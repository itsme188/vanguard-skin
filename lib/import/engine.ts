import type Database from "better-sqlite3";
import type { ParsedImportResult, SourceType } from "./types";
import type { ImportBatch } from "@/lib/types";
import { detectSourceType } from "./detect";
import { validateParsedResult } from "./validate";
import { parseIbkrActivity } from "./parsers/ibkr-activity";
import { parseIbkrHoldings } from "./parsers/ibkr-holdings";
import { parseMonthlyValues } from "./parsers/monthly-values";
import { parseVanguardCostBasis } from "./parsers/vanguard-cost-basis";
import { parseVanguardExport } from "./parsers/vanguard-export";
import { parseVanguardHoldings } from "./parsers/vanguard-holdings";
import { parseVanguardPdf } from "./parsers/vanguard-pdf";
import { parseFactorCsv } from "./parsers/factor-csv";
import { parseCanonicalCsv } from "./parsers/canonical-csv";
import { upsertSecurity } from "@/lib/mutations/securities";
import { FACTOR_COLUMNS } from "@/lib/factors";
import { unitPriceFromMarketValue } from "@/lib/valuation";
import {
  createImportBatch,
  completeImportBatch,
  deleteImportBatch,
} from "@/lib/mutations/import-batches";

// ── Parse (detect + parse, no DB writes) ────────────────────────────

export async function parseImport(
  content: string | Buffer,
  filename: string
): Promise<ParsedImportResult> {
  // For PDFs, content is a Buffer; for CSVs, a string
  const isBuffer = Buffer.isBuffer(content);
  const textContent = isBuffer ? content.toString("utf-8") : content;

  const sourceType = detectSourceType(textContent, filename);

  switch (sourceType) {
    case "ibkr-activity":
      return parseIbkrActivity(textContent, filename);
    case "ibkr-holdings":
      return parseIbkrHoldings(textContent, filename);
    case "monthly-values":
      return parseMonthlyValues(textContent, filename);
    case "vanguard-cost-basis":
      return parseVanguardCostBasis(textContent, filename);
    case "vanguard-export":
      return parseVanguardExport(textContent, filename);
    case "vanguard-holdings":
      return parseVanguardHoldings(textContent, filename);
    case "vanguard-pdf":
      if (!isBuffer) {
        throw new Error("PDF files must be provided as Buffer");
      }
      return parseVanguardPdf(content, filename);
    case "factor-csv":
      return parseFactorCsv(textContent, filename);
    case "canonical-csv":
      return parseCanonicalCsv(textContent, filename);
    default:
      return {
        sourceType: "unknown",
        sourceName: filename,
        transactions: [],
        securities: [],
        holdings: [],
        prices: [],
        snapshots: [],
        errors: [`Unknown file format: ${filename}`],
        warnings: [],
      };
  }
}

// ── Commit (write parsed data to DB atomically) ─────────────────────

export interface CommitResult {
  batchId: number;
  recordCount: number;
  newTransactions: number;
  newHoldings: number;
  newPrices: number;
  newSnapshots: number;
  newSecurities: number;
  newFactors: number;
  skippedDuplicates: number;
  unmatchedFactors?: string[];
}

// Map the parser's sourceType to the price.source value used by step 5's
// priority CASE. Sources not listed here fall through to the ELSE=4 bucket.
function holdingDerivedPriceSource(sourceType: SourceType): string {
  switch (sourceType) {
    case "ibkr-activity":
    case "ibkr-holdings":
    case "vanguard-pdf":
    case "vanguard-export":
    case "vanguard-holdings":
      return sourceType;
    default:
      return "canonical";
  }
}

export function commitImport(
  db: Database.Database,
  parsed: ParsedImportResult
): CommitResult {
  // Validate before writing — removes rows with invalid dates/quantities/prices
  const { validatedResult, skippedRows } = validateParsedResult(parsed);
  if (skippedRows.length > 0) {
    console.warn(
      `Import validation: ${skippedRows.length} row(s) excluded:`,
      skippedRows.map((r) => `${r.category}[${r.index}]: ${r.reason}`),
    );
  }
  // Use the validated (cleaned) result for all DB writes
  parsed = validatedResult;

  let newTransactions = 0;
  let newHoldings = 0;
  let newPrices = 0;
  let newSnapshots = 0;
  let newSecurities = 0;
  let skippedDuplicates = 0;

  const result = db.transaction(() => {
    // 1. Create import batch
    const batch = createImportBatch(db, parsed.sourceType, parsed.sourceName);

    // 2. Upsert all securities
    const securityIdMap = new Map<string, number>();
    for (const sec of parsed.securities) {
      const existingCount = (
        db
          .prepare("SELECT COUNT(*) as c FROM securities WHERE symbol = ?")
          .get(sec.symbol) as { c: number }
      ).c;

      const secId = upsertSecurity(db, {
        symbol: sec.symbol,
        name: sec.name,
        securityType: sec.securityType,
        assetClass: sec.assetClass,
        underlyingSymbol: sec.underlyingSymbol,
        strikePrice: sec.strikePrice,
        expirationDate: sec.expirationDate,
        optionType: sec.optionType,
        multiplier: sec.multiplier,
        maturityDate: sec.maturityDate,
      });
      securityIdMap.set(sec.symbol, secId);

      if (existingCount === 0) newSecurities++;
    }

    // Helper to resolve account ID by name
    const accountIdCache = new Map<string, number>();
    function getAccountId(accountName: string): number {
      const cached = accountIdCache.get(accountName);
      if (cached) return cached;

      const row = db
        .prepare("SELECT id FROM accounts WHERE name = ?")
        .get(accountName) as { id: number } | undefined;

      if (!row) {
        throw new Error(`Unknown account: ${accountName}`);
      }
      accountIdCache.set(accountName, row.id);
      return row.id;
    }

    // Helper to resolve or create security ID
    function getSecurityId(symbol: string): number {
      const cached = securityIdMap.get(symbol);
      if (cached) return cached;
      const id = upsertSecurity(db, symbol);
      securityIdMap.set(symbol, id);
      return id;
    }

    const securityMetaStmt = db.prepare(
      `SELECT security_type, multiplier FROM securities WHERE id = ?`,
    );
    const securityMetaCache = new Map<
      string,
      { security_type: string | null; multiplier: number | null }
    >();
    function getSecurityMeta(symbol: string) {
      const cached = securityMetaCache.get(symbol);
      if (cached) return cached;
      const row = securityMetaStmt.get(getSecurityId(symbol)) as
        | { security_type: string | null; multiplier: number | null }
        | undefined;
      const meta = {
        security_type: row?.security_type ?? null,
        multiplier: row?.multiplier ?? null,
      };
      securityMetaCache.set(symbol, meta);
      return meta;
    }

    // 3. Insert transactions (skip duplicates via source_key)
    const insertTxn = db.prepare(`
      INSERT OR IGNORE INTO transactions
        (account_id, security_id, import_batch_id, trade_date, settlement_date,
         type, quantity, amount, price_per_share, fees, is_external_flow, source_key, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const txn of parsed.transactions) {
      const accountId = getAccountId(txn.accountName);
      const securityId = txn.symbol ? getSecurityId(txn.symbol) : null;
      const txnTypeLower = txn.type.toLowerCase();
      const isExternal =
        txn.isExternalFlow ||
        txnTypeLower === "transfer_in" ||
        txnTypeLower === "transfer_out" ||
        txnTypeLower === "deposit" ||
        txnTypeLower === "withdrawal"
          ? 1
          : 0;

      const res = insertTxn.run(
        accountId,
        securityId,
        batch.id,
        txn.tradeDate,
        txn.settlementDate ?? null,
        txn.type,
        txn.quantity ?? null,
        txn.amount ?? null,
        txn.pricePerShare ?? null,
        txn.fees ?? 0,
        isExternal,
        txn.sourceKey,
        txn.notes ?? null
      );

      if (res.changes > 0) {
        newTransactions++;
      } else {
        skippedDuplicates++;
      }
    }

    // 4. Insert holdings (skip duplicates via source_key)
    const insertHolding = db.prepare(`
      INSERT OR IGNORE INTO holdings
        (account_id, security_id, quantity, cost_basis, as_of_date, import_batch_id, source_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const h of parsed.holdings) {
      const accountId = getAccountId(h.accountName);
      const securityId = getSecurityId(h.symbol);

      const res = insertHolding.run(
        accountId,
        securityId,
        h.quantity,
        h.costBasis ?? null,
        h.asOfDate,
        batch.id,
        h.sourceKey
      );

      if (res.changes > 0) {
        newHoldings++;
      } else {
        skippedDuplicates++;
      }
    }

    // 4b. Derive prices from holdings that have marketValue.
    //     price = marketValue / quantity (for bonds this gives % of par, for stocks $/share).
    //     These are statement-sourced prices — lower priority than TWS but fill gaps
    //     for securities that can't be priced via TWS (mutual funds, CUSIPs).
    //     Inherit the parser's sourceType so the priority CASE in step 5 picks
    //     the right tier (vanguard-pdf=3, ibkr-*=2) instead of falling through
    //     to the ELSE=4 bucket, which would let a stale "manual" price survive
    //     a fresh Vanguard PDF import.
    const derivedPriceSource = holdingDerivedPriceSource(parsed.sourceType);
    const explicitPrices = new Set(
      parsed.prices.map((p) => `${p.symbol}\u0000${p.date}\u0000${p.source}`),
    );
    for (const h of parsed.holdings) {
      if (h.marketValue != null && h.quantity > 0) {
        const meta = getSecurityMeta(h.symbol);
        const pricePerShare = unitPriceFromMarketValue(
          h.marketValue,
          h.quantity,
          meta.security_type,
          meta.multiplier ?? 1,
        );
        if (pricePerShare != null && pricePerShare > 0 && isFinite(pricePerShare)) {
          const key = `${h.symbol}\u0000${h.asOfDate}\u0000${derivedPriceSource}`;
          if (explicitPrices.has(key)) continue;
          parsed.prices.push({
            symbol: h.symbol,
            date: h.asOfDate,
            closePrice: pricePerShare,
            source: derivedPriceSource,
          });
        }
      }
    }

    // 5. Insert prices with source priority (higher-priority sources overwrite lower)
    //    Priority: tws (1) > ibkr statement (2) > vanguard statement (3) > other (4)
    //    On conflict: overwrite only if incoming source has equal or higher priority.
    const insertPrice = db.prepare(`
      INSERT INTO prices (security_id, date, close_price, source, import_batch_id)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(security_id, date) DO UPDATE SET
        close_price = excluded.close_price,
        source = excluded.source,
        import_batch_id = excluded.import_batch_id
      WHERE CASE excluded.source
        WHEN 'tws' THEN 1
        WHEN 'ibkr-activity' THEN 2
        WHEN 'ibkr-holdings' THEN 2
        WHEN 'vanguard-pdf' THEN 3
        WHEN 'vanguard-export' THEN 3
        WHEN 'vanguard-holdings' THEN 3
        ELSE 4
      END <= CASE prices.source
        WHEN 'tws' THEN 1
        WHEN 'ibkr-activity' THEN 2
        WHEN 'ibkr-holdings' THEN 2
        WHEN 'vanguard-pdf' THEN 3
        WHEN 'vanguard-export' THEN 3
        WHEN 'vanguard-holdings' THEN 3
        ELSE 4
      END
    `);

    for (const p of parsed.prices) {
      const securityId = getSecurityId(p.symbol);

      const res = insertPrice.run(
        securityId,
        p.date,
        p.closePrice,
        p.source,
        batch.id
      );

      if (res.changes > 0) {
        newPrices++;
      } else {
        skippedDuplicates++;
      }
    }

    // 6. Insert monthly snapshots (skip duplicates via UNIQUE(account_id, month_end_date))
    const insertSnapshot = db.prepare(`
      INSERT OR IGNORE INTO monthly_snapshots
        (account_id, month_end_date, total_value, source, starting_value,
         mark_to_market, deposits_withdrawals, dividends, interest,
         commissions, fees, other_pnl, twr, investment_gain, import_batch_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const s of parsed.snapshots) {
      const accountId = getAccountId(s.accountName);

      const res = insertSnapshot.run(
        accountId,
        s.monthEndDate,
        s.totalValue,
        s.source,
        s.startingValue ?? null,
        s.markToMarket ?? null,
        s.depositsWithdrawals ?? null,
        s.dividends ?? null,
        s.interest ?? null,
        s.commissions ?? null,
        s.fees ?? null,
        s.otherPnl ?? null,
        s.twr ?? null,
        s.investmentGain ?? null,
        batch.id
      );

      if (res.changes > 0) {
        newSnapshots++;
      } else {
        skippedDuplicates++;
      }
    }

    // 7. Insert/update factor exposures (from factor-csv)
    let newFactors = 0;
    const unmatchedFactors: string[] = [];

    if (parsed.factors && parsed.factors.length > 0) {
      const upsertFactor = db.prepare(`
        INSERT INTO security_factors
          (security_id, interest_rate_sensitive, growth_vs_value, cyclical,
           international_exposure, geopolitical_onshoring, tariff_exposure,
           ai_exposure, crypto_adjacent, regulatory_risk,
           factor_source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(security_id) DO UPDATE SET
          interest_rate_sensitive = excluded.interest_rate_sensitive,
          growth_vs_value = excluded.growth_vs_value,
          cyclical = excluded.cyclical,
          international_exposure = excluded.international_exposure,
          geopolitical_onshoring = excluded.geopolitical_onshoring,
          tariff_exposure = excluded.tariff_exposure,
          ai_exposure = excluded.ai_exposure,
          crypto_adjacent = excluded.crypto_adjacent,
          regulatory_risk = excluded.regulatory_risk,
          factor_source = excluded.factor_source,
          updated_at = excluded.updated_at
      `);

      const updateSectorIndustry = db.prepare(`
        UPDATE securities SET sector = ?, industry = ? WHERE id = ?
      `);

      for (const f of parsed.factors) {
        // Resolve symbol to security_id
        const sec = db
          .prepare("SELECT id FROM securities WHERE symbol = ?")
          .get(f.symbol) as { id: number } | undefined;

        if (!sec) {
          unmatchedFactors.push(f.symbol);
          continue;
        }

        upsertFactor.run(
          sec.id,
          f.interest_rate_sensitive ?? null,
          f.growth_vs_value ?? null,
          f.cyclical ?? null,
          f.international_exposure ?? null,
          f.geopolitical_onshoring ?? null,
          f.tariff_exposure ?? null,
          f.ai_exposure ?? null,
          f.crypto_adjacent ?? null,
          f.regulatory_risk ?? null,
          "csv_import"
        );
        newFactors++;

        // Override sector/industry from CSV
        if (f.sector || f.industry) {
          const current = db
            .prepare("SELECT sector, industry FROM securities WHERE id = ?")
            .get(sec.id) as { sector: string | null; industry: string | null };

          updateSectorIndustry.run(
            f.sector ?? current.sector,
            f.industry ?? current.industry,
            sec.id
          );
        }
      }
    }

    // 8. Store raw content
    db.prepare(
      "INSERT INTO raw_imports (import_batch_id, raw_data) VALUES (?, ?)"
    ).run(batch.id, JSON.stringify(parsed));

    // 9. Complete the batch
    const recordCount =
      newTransactions + newHoldings + newPrices + newSnapshots + newFactors;
    const summary = [
      newTransactions > 0 ? `${newTransactions} transactions` : null,
      newHoldings > 0 ? `${newHoldings} holdings` : null,
      newPrices > 0 ? `${newPrices} prices` : null,
      newSnapshots > 0 ? `${newSnapshots} snapshots` : null,
      newFactors > 0 ? `${newFactors} factor classifications` : null,
      unmatchedFactors.length > 0 ? `${unmatchedFactors.length} unmatched symbols` : null,
      skippedDuplicates > 0 ? `${skippedDuplicates} duplicates skipped` : null,
    ]
      .filter(Boolean)
      .join(", ");

    completeImportBatch(db, batch.id, recordCount, summary);

    return {
      batchId: batch.id,
      recordCount,
      newTransactions,
      newHoldings,
      newPrices,
      newSnapshots,
      newSecurities,
      newFactors,
      skippedDuplicates,
      unmatchedFactors: unmatchedFactors.length > 0 ? unmatchedFactors : undefined,
    };
  })();

  return result;
}

// ── Undo (delete all records from a batch) ──────────────────────────

export function undoImport(db: Database.Database, batchId: number): void {
  deleteImportBatch(db, batchId);
}
