import type Database from "better-sqlite3";
import type { ParsedImportResult } from "./types";
import type { ImportBatch } from "@/lib/types";
import { detectSourceType } from "./detect";
import { parseIbkrActivity } from "./parsers/ibkr-activity";
import { parseIbkrHoldings } from "./parsers/ibkr-holdings";
import { parseMonthlyValues } from "./parsers/monthly-values";
import { parseVanguardCostBasis } from "./parsers/vanguard-cost-basis";
import { parseVanguardHoldings } from "./parsers/vanguard-holdings";
import { parseVanguardPdf } from "./parsers/vanguard-pdf";
import { upsertSecurity } from "@/lib/mutations/securities";
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
    case "vanguard-holdings":
      return parseVanguardHoldings(textContent, filename);
    case "vanguard-pdf":
      if (!isBuffer) {
        throw new Error("PDF files must be provided as Buffer");
      }
      return parseVanguardPdf(content, filename);
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
  skippedDuplicates: number;
}

export function commitImport(
  db: Database.Database,
  parsed: ParsedImportResult
): CommitResult {
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

    // 5. Insert prices (skip duplicates via UNIQUE(security_id, date))
    const insertPrice = db.prepare(`
      INSERT OR IGNORE INTO prices (security_id, date, close_price, source, import_batch_id)
      VALUES (?, ?, ?, ?, ?)
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

    // 7. Store raw content
    db.prepare(
      "INSERT INTO raw_imports (import_batch_id, raw_data) VALUES (?, ?)"
    ).run(batch.id, JSON.stringify(parsed));

    // 8. Complete the batch
    const recordCount =
      newTransactions + newHoldings + newPrices + newSnapshots;
    const summary = [
      newTransactions > 0 ? `${newTransactions} transactions` : null,
      newHoldings > 0 ? `${newHoldings} holdings` : null,
      newPrices > 0 ? `${newPrices} prices` : null,
      newSnapshots > 0 ? `${newSnapshots} snapshots` : null,
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
      skippedDuplicates,
    };
  })();

  return result;
}

// ── Undo (delete all records from a batch) ──────────────────────────

export function undoImport(db: Database.Database, batchId: number): void {
  deleteImportBatch(db, batchId);
}
