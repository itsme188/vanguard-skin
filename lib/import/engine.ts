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
import { parseDafContributions } from "./parsers/daf-contributions";
import { upsertSecurity } from "@/lib/mutations/securities";
import { FACTOR_COLUMNS } from "@/lib/factors";
import { unitPriceFromMarketValue } from "@/lib/valuation";
import {
  createImportBatch,
  completeImportBatch,
  deleteImportBatch,
} from "@/lib/mutations/import-batches";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { purgeExpiredOptionHoldings } from "@/lib/mutations/expired-options";
import { purgeMaturedBondHoldings } from "@/lib/mutations/matured-bonds";
import { reconcileClosedEquityHoldings } from "@/lib/mutations/closed-equity";
import { normalizeSector } from "@/lib/securities/normalize-sector";

// ── IBKR exchange-suffixed symbol resolution ────────────────────────
//
// IBKR activity statements print foreign-listed positions with an
// exchange-suffixed symbol (e.g. the Korea-listed "402340.KS"). The
// TWS/Web-API sync, however, always writes that same listing under the BARE
// symbol ("402340", currency resolved from the contract — e.g. 'KRW') — the
// bare form is this codebase's canonical representation for a foreign
// listing. Normalization therefore strips a known IBKR exchange suffix
// UNCONDITIONALLY, never gated on whether a base-symbol securities row
// already exists.
//
// Why unconditional (2026-07-05 review redesign — replaces a DB-existence
// gate that shipped, then was reverted, in this same branch): gating
// resolution on "does a base row exist yet" makes symbol resolution a
// function of MUTABLE DB STATE, not just the file's own bytes. The same
// statement file would then resolve differently depending on import order:
// first import (no base row yet) keeps "402340.KS" and creates a security
// under that suffixed symbol; once a sync later creates the bare "402340"
// row, re-importing the IDENTICAL statement resolves to a DIFFERENT
// security id for the same holding — the ON CONFLICT(account_id,
// security_id, as_of_date) target on the second commit no longer matches
// the first commit's row, so the INSERT falls through to a plain insert
// that collides with the (unchanged, suffix-preserving) `source_key`
// UNIQUE column constraint instead — which the upsert's ON CONFLICT clause
// doesn't cover — and the whole transaction rolls back.
//
// Stripping unconditionally makes symbol (and therefore security)
// resolution a PURE function of the file: idempotent in every DB state.
// If the statement arrives before any sync row exists, the bare-symbol
// security is created fresh (currency defaults to USD via `upsertSecurity`)
// and self-heals to the real currency on the next sync upsert (the
// COALESCE(NULLIF(excluded.currency,'USD'), securities.currency) pattern —
// see lib/mutations/securities.ts) — one row either way, never two.
//
// `parseIbkrActivity` is a pure function (content, filename) -> parsed
// records with no `db` parameter, and its own test suite
// (tests/import/parsers/ibkr-activity.test.ts) exercises it that way; this
// normalization deliberately stays pure too and lives in `commitImport`
// (gated to `sourceType === "ibkr-activity"`), running once up front
// (mutating the validated `parsed` records) before any DB writes.
//
// source_key invariant: normalization rewrites ONLY the in-memory `.symbol`
// field. `source_key` values are built from the parser's ORIGINAL
// (unresolved, still-suffixed) statement symbol and are NEVER rewritten
// here — source_key = pure function of file content; symbol = normalized.
// Re-running normalization against the same source_key is what makes the
// idempotency guarantee above hold.

/**
 * Exchange suffixes IBKR appends to foreign-listed symbols on activity
 * statements. Extensible — add new suffixes here as they're observed on
 * real statements. The actual safety rule this list encodes is: no suffix
 * that collides with a plausible US dual-class share letter (.A, .B, ...) —
 * see lib/securities/issuer-family.ts's FAMILIES list, which only ever uses
 * single-letter class suffixes (HEI.A, BRK.A/BRK.B). `.T` and `.L` below are
 * also single letters, but they're real exchange suffixes (Tokyo, London)
 * with no dual-class collision anywhere in that family list, so they're
 * safe to strip unconditionally.
 */
export const IBKR_EXCHANGE_SUFFIXES = [
  ".KS", // Korea (KOSPI)
  ".T", // Tokyo
  ".TO", // Toronto
  ".L", // London
  ".HK", // Hong Kong
  ".SW", // Switzerland (SIX)
  ".AX", // Australia (ASX)
  ".PA", // Paris (Euronext)
  ".DE", // Germany (Xetra)
  ".MI", // Milan (Borsa Italiana)
  ".AS", // Amsterdam (Euronext)
  ".MC", // Madrid (BME)
  ".VX", // Switzerland (virt-x/SIX, legacy feed)
  ".SS", // Shanghai
  ".SZ", // Shenzhen
] as const;

/**
 * Resolve an IBKR exchange-suffixed symbol (e.g. "402340.KS") to its bare
 * base symbol (e.g. "402340"). PURE — no db access, no lookups — and
 * therefore unconditional: a recognized suffix is always stripped,
 * regardless of whether a base-symbol securities row currently exists. See
 * the file-header comment above for why this must not depend on DB state.
 */
export function resolveIbkrExchangeSuffixedSymbol(symbol: string): string {
  const suffix = IBKR_EXCHANGE_SUFFIXES.find((s) => symbol.endsWith(s));
  if (!suffix) return symbol;
  const base = symbol.slice(0, -suffix.length);
  if (!base) return symbol;
  return base;
}

function resolveIbkrExchangeSuffixedSymbols(parsed: ParsedImportResult): void {
  if (parsed.sourceType !== "ibkr-activity") return;

  for (const sec of parsed.securities) {
    sec.symbol = resolveIbkrExchangeSuffixedSymbol(sec.symbol);
    if (sec.underlyingSymbol) {
      sec.underlyingSymbol = resolveIbkrExchangeSuffixedSymbol(
        sec.underlyingSymbol
      );
    }
  }
  for (const txn of parsed.transactions) {
    if (txn.symbol) {
      txn.symbol = resolveIbkrExchangeSuffixedSymbol(txn.symbol);
    }
  }
  for (const h of parsed.holdings) {
    h.symbol = resolveIbkrExchangeSuffixedSymbol(h.symbol);
  }
  for (const p of parsed.prices) {
    p.symbol = resolveIbkrExchangeSuffixedSymbol(p.symbol);
  }
  for (const ca of parsed.corporateActions) {
    ca.symbol = resolveIbkrExchangeSuffixedSymbol(ca.symbol);
  }
}

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
    case "daf-contributions":
      return parseDafContributions(textContent, filename);
    default:
      return {
        sourceType: "unknown",
        sourceName: filename,
        transactions: [],
        securities: [],
        holdings: [],
        prices: [],
        snapshots: [],
        corporateActions: [],
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
  newCorporateActions: number;
  skippedDuplicates: number;
  unmatchedFactors?: string[];
  warnings: string[];
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

  // Normalize IBKR exchange-suffixed foreign symbols ("402340.KS" ->
  // "402340") BEFORE any writes below — pure/unconditional, see
  // resolveIbkrExchangeSuffixedSymbols for the full rationale.
  resolveIbkrExchangeSuffixedSymbols(parsed);

  let newTransactions = 0;
  let newHoldings = 0;
  let newPrices = 0;
  let newSnapshots = 0;
  let newSecurities = 0;
  let newCorporateActions = 0;
  let skippedDuplicates = 0;
  const warnings: string[] = [];

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

    // 3b. Insert corporate actions (spec 2026-08-11 §3). Collision check is
    // TYPE-AGNOSTIC on (security_id, effective_date). Security resolution is
    // RESOLVE-ONLY — a split on a symbol we've never seen means missing
    // history; creating a bare securities row would be a guess.
    const insertCa = db.prepare(`
      INSERT OR IGNORE INTO corporate_actions
        (security_id, account_id, action_type, effective_date, ratio_numerator,
         ratio_denominator, applied, source, source_key, import_batch_id, quantity_delta)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'import', ?, ?, ?)
    `);
    const findCollision = db.prepare(`
      SELECT action_type, ratio_numerator, ratio_denominator, source
      FROM corporate_actions WHERE security_id = ? AND effective_date = ?
    `);
    const findSecurity = db.prepare("SELECT id FROM securities WHERE symbol = ?");
    for (const ca of parsed.corporateActions) {
      const secRow = findSecurity.get(ca.symbol) as { id: number } | undefined;
      if (!secRow) {
        warnings.push(
          `Corporate action skipped: no known security for symbol ${ca.symbol} — import the trades/holdings that establish it first`,
        );
        continue;
      }
      const accountId = getAccountId(ca.accountName);
      const existing = findCollision.get(secRow.id, ca.effectiveDate) as
        | { action_type: string; ratio_numerator: number; ratio_denominator: number; source: string }
        | undefined;
      if (existing) {
        const sameShape =
          existing.action_type === ca.actionType &&
          existing.ratio_numerator === ca.ratioNumerator &&
          existing.ratio_denominator === ca.ratioDenominator;
        if (!sameShape) {
          warnings.push(
            `Corporate action conflict for ${ca.symbol} on ${ca.effectiveDate}: existing ${existing.source} ` +
            `${existing.action_type} ${existing.ratio_numerator}:${existing.ratio_denominator} vs statement ` +
            `${ca.actionType} ${ca.ratioNumerator}:${ca.ratioDenominator} — resolve manually`,
          );
        }
        skippedDuplicates++;
        continue;
      }
      const res2 = insertCa.run(
        secRow.id, accountId, ca.actionType, ca.effectiveDate,
        ca.ratioNumerator, ca.ratioDenominator, ca.sourceKey, batch.id, ca.quantityDelta,
      );
      if (res2.changes > 0) newCorporateActions++;
      else skippedDuplicates++;
    }

    // 4. Upsert holdings. UNIQUE(account_id, security_id, as_of_date) means only
    //    one row per (account, security, date). Statement holdings — the
    //    six-prefix statement-authority class single-sourced in
    //    lib/db/holding-sources.ts — are the end-of-day authority and must
    //    overwrite earlier live intra-day rows for the same date (live
    //    prefixes live in the same file). Re-imports of the same statement
    //    match on UNIQUE source_key and are no-ops.
    //
    //    Pre-2026-05-04 this used INSERT OR IGNORE, which silently dropped the
    //    statement holdings whenever TWS had already written an intra-day row.
    //    For IBKR April: 18 of 19 statement holdings were lost this way (only 1
    //    new option position survived because TWS hadn't seen it yet).
    const insertHolding = db.prepare(`
      INSERT INTO holdings
        (account_id, security_id, quantity, cost_basis, as_of_date, import_batch_id, source_key)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, security_id, as_of_date) DO UPDATE SET
        quantity = excluded.quantity,
        cost_basis = excluded.cost_basis,
        import_batch_id = excluded.import_batch_id,
        source_key = excluded.source_key
      WHERE holdings.source_key LIKE 'tws-%' OR holdings.source_key LIKE 'plaid:%'
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
        WHEN 'plaid' THEN 3
        ELSE 4
      END <= CASE prices.source
        WHEN 'tws' THEN 1
        WHEN 'ibkr-activity' THEN 2
        WHEN 'ibkr-holdings' THEN 2
        WHEN 'vanguard-pdf' THEN 3
        WHEN 'vanguard-export' THEN 3
        WHEN 'vanguard-holdings' THEN 3
        WHEN 'plaid' THEN 3
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

    // 6. Upsert monthly snapshots. UNIQUE(account_id, month_end_date) means there
    //    can only be one row per (account, month). Statement data (source ∈
    //    {ibkr-activity, canonical, vanguard-pdf, …}) is authoritative for
    //    month-end values and must overwrite any earlier 'tws' or 'manual' row
    //    that the live-sync wrote as a real-time approximation. Re-imports of
    //    the same statement are no-ops (excluded values match exactly).
    //
    //    Pre-2026-05-04 this used INSERT OR IGNORE, which silently dropped the
    //    statement row whenever TWS had already written a placeholder — the IBKR
    //    April snapshot had `total_value=$448,941` (stale TWS value) instead of
    //    the statement's $449,764 with full starting_value/twr/deposits/etc.
    const insertSnapshot = db.prepare(`
      INSERT INTO monthly_snapshots
        (account_id, month_end_date, total_value, source, starting_value,
         mark_to_market, deposits_withdrawals, dividends, interest,
         commissions, fees, other_pnl, twr, investment_gain, import_batch_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, month_end_date) DO UPDATE SET
        total_value = excluded.total_value,
        source = excluded.source,
        starting_value = excluded.starting_value,
        mark_to_market = excluded.mark_to_market,
        deposits_withdrawals = excluded.deposits_withdrawals,
        dividends = excluded.dividends,
        interest = excluded.interest,
        commissions = excluded.commissions,
        fees = excluded.fees,
        other_pnl = excluded.other_pnl,
        twr = excluded.twr,
        investment_gain = excluded.investment_gain,
        import_batch_id = excluded.import_batch_id
      WHERE monthly_snapshots.source IN ('tws', 'manual', 'plaid')
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
        UPDATE securities
        SET sector = COALESCE(?, sector),
            sector_source = CASE WHEN ? IS NOT NULL THEN 'csv_import' ELSE sector_source END,
            industry = COALESCE(NULLIF(industry,''), ?)
        WHERE id = ?
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

        // Override sector/industry from CSV — normalize to GICS, preserve raw as industry fallback
        if (f.sector || f.industry) {
          const gics = normalizeSector(f.sector ?? null);
          updateSectorIndustry.run(
            gics,
            gics,
            f.industry ?? f.sector ?? null,
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
      newTransactions + newHoldings + newPrices + newSnapshots + newFactors +
      newCorporateActions;
    const summary = [
      newTransactions > 0 ? `${newTransactions} transactions` : null,
      newHoldings > 0 ? `${newHoldings} holdings` : null,
      newPrices > 0 ? `${newPrices} prices` : null,
      newSnapshots > 0 ? `${newSnapshots} snapshots` : null,
      newFactors > 0 ? `${newFactors} factor classifications` : null,
      newCorporateActions > 0 ? `${newCorporateActions} corporate actions` : null,
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
      newCorporateActions,
      skippedDuplicates,
      unmatchedFactors: unmatchedFactors.length > 0 ? unmatchedFactors : undefined,
      warnings,
    };
  })();

  // Post-commit hygiene: holdings-snapshot imports (Vanguard / IBKR positions)
  // need to sweep stale expired options + matured bonds because statement
  // snapshots never zero-out rows that simply disappear. Transaction-style
  // sources (canonical-csv transactions, monthly-values, factor-csv, etc.)
  // don't carry a full positions snapshot and shouldn't trigger the sweep.
  // Each purge runs in its own try/catch — a failed sweep should NOT mask the
  // successful import.
  const HOLDINGS_SNAPSHOT_SOURCES: SourceType[] = [
    "vanguard-pdf",
    "vanguard-export",
    "vanguard-holdings",
    "ibkr-holdings",
    "ibkr-activity", // ibkr-activity statements include a positions block
  ];
  // canonical-csv is deliberately NOT in the static list above — a
  // canonical-csv import can be transactions-only (dividends, fees, trades)
  // OR carry a full holdings block, and blanket-adding the source type would
  // fire the sweep even for pure-transaction imports with no bearing on
  // current positions. Instead, gate on EVIDENCE, scoped ONLY to
  // canonical-csv: did THIS batch's parsed result carry holdings rows?
  // `parsed.holdings.length` (not `newHoldings`) is the right signal — a
  // verbatim re-import of an unchanged statement legitimately reports
  // `newHoldings === 0` (every row is an idempotent no-op via the ON
  // CONFLICT guard) even though it's a genuine holdings snapshot that
  // should still keep the sweep active. The `sourceType === "canonical-csv"`
  // guard is deliberate, not redundant with `.length > 0` alone — other
  // parsers (e.g. the legacy `vanguard-cost-basis` original-format branch)
  // also emit `ParsedHolding[]` rows without being a full-book snapshot
  // source in the same sense, and widening the evidence check to ANY source
  // type would silently re-include them. The sweeps are idempotent +
  // shrink-guarded, so gating canonical-csv this liberally is safe by
  // design — the worst case is a harmless extra global scan.
  //
  // `parsed.holdings.length > 0` is now also required for the STATIC-LIST
  // sources (spec 2026-08-11, corporate-actions import): an ibkr-activity
  // file can be corporate-actions-only or transactions-only, carrying an
  // EMPTY holdings block despite the source type normally implying a full
  // positions snapshot. Running `reconcileClosedEquityHoldings` against that
  // empty snapshot would zero out every real position (a mass-close
  // hazard the 50% shrink guard only partially bounds) — no holdings in the
  // parse means no snapshot evidence, full stop, regardless of source type.
  // A genuine holdings-snapshot statement (including a verbatim re-import)
  // always parses out its holdings rows, so this doesn't weaken detection
  // of the real case the static list exists for.
  const hasHoldingsSnapshot =
    parsed.holdings.length > 0 &&
    (HOLDINGS_SNAPSHOT_SOURCES.includes(parsed.sourceType) ||
      parsed.sourceType === "canonical-csv");
  if (hasHoldingsSnapshot) {
    try {
      const purged = purgeExpiredOptionHoldings(db);
      if (purged > 0) {
        console.log(`[commit] Purged ${purged} expired option holdings`);
      }
    } catch (err) {
      console.error(
        "[commit] Expired-option purge error:",
        err instanceof Error ? err.message : err,
      );
    }
    try {
      const purged = purgeMaturedBondHoldings(db);
      if (purged > 0) {
        console.log(`[commit] Purged ${purged} matured bond holdings`);
      }
    } catch (err) {
      console.error(
        "[commit] Matured-bond purge error:",
        err instanceof Error ? err.message : err,
      );
    }
    try {
      // Snapshot-diff: a stock/ETF absent from the just-imported holdings
      // snapshot was sold/covered — mark it flat (zero-row). Guarded against a
      // partial/under-extracted snapshot wiping the book. See closed-equity.ts.
      const reconciled = reconcileClosedEquityHoldings(db);
      if (reconciled > 0) {
        console.log(`[commit] Reconciled ${reconciled} closed equity holdings`);
      }
    } catch (err) {
      console.error(
        "[commit] Closed-equity reconcile error:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return result;
}

// ── Undo (delete all records from a batch) ──────────────────────────

export function undoImport(db: Database.Database, batchId: number): void {
  deleteImportBatch(db, batchId);
  // deleteImportBatch clears the derived layer (tax_lots, tax_lot_sales,
  // daily_valuations) wholesale on the assumption that the caller regenerates
  // it — do that here so every undo path leaves the derived data consistent
  // with the surviving source records. Best-effort, mirroring the post-commit
  // recompute in the import route: a recompute failure must not un-delete the
  // batch or surface as an undo failure.
  try {
    computeTaxLots(db);
  } catch (err) {
    console.error(
      "[undo] Tax lot recompute failed:",
      err instanceof Error ? err.message : err,
    );
  }
  try {
    computeDailyValuations(db);
  } catch (err) {
    console.error(
      "[undo] Valuation recompute failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
