import type Database from "better-sqlite3";
import { easternDaySql, unmaturedSecuritySql } from "@/lib/db/eastern-day-sql";
import { todayET } from "@/lib/calendar/date-utils";
import {
  estimateBondRateLeg,
  type BondUnmodelledReason,
  type RateDurationSource,
} from "@/lib/compute/bond-duration";
import {
  reconcileTwrAgainstStatements,
  type TwrReconcileResult,
} from "@/lib/compute/twr-reconcile";
import type { DietzBand } from "@/lib/compute/dietz";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { accountScopeAndSql, accountScopeCondition } from "@/lib/queries/account-scope-sql";

/** The `settings` key the sector run stamps. The same string is exported as
 *  `SECTOR_CLASSIFY_LAST_RUN_KEY` by lib/securities/classify-option-sectors.ts,
 *  the only writer; it is repeated here so this read-only query does not
 *  import the classifier (and with it the AI client).
 *  tests/queries/analysis-trust-state.test.ts pins the two together. */
const SECTOR_CLASSIFY_LAST_RUN_SETTING = "sector_classify_last_run_at";

/** One walked calendar month in an account's cross-check chain. A month
 *  with no statement row at all is "missing" — distinct from a Dietz band,
 *  and (like "investigate"/"insufficient") breaks the chain. */
export interface BandHistoryEntry {
  monthEndDate: string;
  band: DietzBand | "missing";
  divergenceBp: number | null;
}

/** The first walked month that broke an account's chain (band investigate,
 *  insufficient, or a missing calendar month) — null when the walk never
 *  broke (including a "chainless" account with no 2nd statement month to
 *  start from, or one whose chain is unbroken through its latest month). */
export interface ChainBreak {
  monthEndDate: string;
  band: DietzBand | "missing";
}

export interface PerAccountReconciliation {
  accountId: number;
  accountName: string;
  monthEndDate: string | null; // latest statement month, null if the account has no statement row at all
  statementTwr: number | null;
  dietzReturn: number | null;
  divergenceBp: number | null;
  band: DietzBand | null; // null when the account has no statement row at all
  bandHistory: BandHistoryEntry[]; // the walked sequence, 2nd statement month through the latest
  crossCheckedThru: string | null; // this account's OWN chain frontier (see walkAccountChain) — may reach further than the rollup crossCheckedThru
  chainBreak: ChainBreak | null; // where and why this account's own chain stopped, if it did
}

export interface AnalysisTrustState {
  factorCoverage: {
    totalNames: number;
    classified: number;
    percentage: number;
    missingSymbols: string[];
  };
  lastClassification: string | null;
  /** When option sectors were last checked and found in line with their
   *  underlyings, or brought in line (lib/securities/classify-option-sectors.ts;
   *  a check that hit an AI error does not count): stored UTC,
   *  `YYYY-MM-DD HH:MM:SS`. null = never stamped. Not per account: the check
   *  covers every account. */
  lastSectorClassification: string | null;
  crossCheckedThru: string | null; // populated by Slice D; renamed from performanceReconciledThru (Task 13)
  perAccountReconciliation: PerAccountReconciliation[];
  stalePrices: { count: number; symbols: string[] };
  /** Held securities with NO price row at all. Counted apart from
   *  `stalePrices` (a stale price is old; this is absent), so neither count
   *  changes meaning. Same holdings universe as `stalePrices`. */
  neverPriced: { count: number; symbols: string[] };
  /** Held, unmatured bonds, each judged by `estimateBondRateLeg`: the same
   *  rule, on the same stored inputs, as the Fixed Income card. One row per
   *  security. totalBonds = storedCount + estimated.length + missing.length. */
  bondDuration: {
    totalBonds: number;
    /** Bonds that have a duration, stored or estimated (storedCount + estimated.length). */
    withDuration: number;
    /** Bonds whose duration is the stored figure. */
    storedCount: number;
    /** Bonds whose duration is worked out from their own maturity, coupon and price. */
    estimated: EstimatedDurationBond[];
    /** Bonds the rule cannot model, with the reason. The only gap: nothing is
     *  ever assumed for them (missing.length = totalBonds - withDuration). */
    missing: MissingDurationBond[];
  };
}

export interface EstimatedDurationBond {
  securityId: number;
  symbol: string;
  name: string | null;
  durationYears: number;
  /** What the duration was derived from; never "stored". */
  durationSource: RateDurationSource;
}

export interface MissingDurationBond {
  securityId: number;
  symbol: string;
  name: string | null;
  /** Why the bond is not modelled. */
  reason: BondUnmodelledReason | null;
}

interface BondDurationRow {
  securityId: number;
  symbol: string;
  name: string | null;
  security_type: string;
  sector: string | null;
  fund_category: string | null;
  duration_years: number | null;
  maturity_date: string | null;
  coupon_rate: number | null;
  bond_price: number | null;
}

const STALE_PRICE_DAYS = 4;
const STATEMENT_SOURCES = "'ibkr-activity', 'canonical', 'vanguard-pdf'";

/** The last calendar day of the month AFTER monthEndDate's month, e.g.
 *  "2026-01-31" → "2026-02-28", "2026-12-31" → "2027-01-31". Mirrors
 *  monthly-snapshot-utils.ts's private priorMonthEndDate in the opposite
 *  direction (not exported there, so duplicated here per that file's own
 *  precedent — see dietz.ts). */
function nextMonthEndDate(monthEndDate: string): string {
  const d = new Date(monthEndDate + "T00:00:00Z");
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 2, 0));
  return next.toISOString().slice(0, 10);
}

/**
 * Walks one account's independent Dietz cross-check chain: every calendar
 * month from the account's SECOND statement month (inclusive) through its
 * LATEST statement month (inclusive), stepping one calendar month at a
 * time — not skipping gaps. The first statement month is never a valid
 * chain start: computeMonthlyDietz always needs a prior month-end snapshot
 * (fetchPriorMonthTotal), which the very first statement month can never
 * have.
 *
 * Returns the walked bandHistory and this account's own crossCheckedThru
 * frontier: the latest "consistent" month such that every walked month up
 * to and including it is "consistent" or "not_comparable". A
 * "not_comparable" month (seam-straddled) is pass-through — it does not
 * break the chain, but it does not EXTEND the frontier either, because
 * nothing was verified in it. "investigate", "insufficient", and a missing
 * calendar month (no statement row for that exact month) all break the
 * chain at that point — null when no "consistent" month precedes the first
 * break (including a chain made only of not_comparable months), or when
 * there's no second statement month to start from at all ("chainless").
 * The UI copy "cross-checked through X" therefore always names a month in
 * which the statement TWR and the independent Dietz return actually agreed
 * (CLAUDE.md: never a blanket reconciled claim; gate on band === consistent).
 *
 * Also returns `chainBreak`: the FIRST walked month whose band is
 * "investigate", "insufficient", or "missing" — i.e. the month where (and
 * why) the chain actually stopped. "not_comparable" is pass-through (see
 * above) and is never a break. null when the walk never broke (including
 * the chainless case, and the case where the chain runs unbroken all the
 * way through the latest statement month).
 */
function walkAccountChain(
  db: Database.Database,
  accountId: number
): {
  bandHistory: BandHistoryEntry[];
  crossCheckedThru: string | null;
  chainBreak: ChainBreak | null;
} {
  const stmtMonths = (
    db
      .prepare(
        `SELECT DISTINCT month_end_date FROM monthly_snapshots
         WHERE account_id = ? AND source IN (${STATEMENT_SOURCES})
         ORDER BY month_end_date ASC`
      )
      .all(accountId) as { month_end_date: string }[]
  ).map((r) => r.month_end_date);

  if (stmtMonths.length < 2) {
    return { bandHistory: [], crossCheckedThru: null, chainBreak: null };
  }

  const chainStart = stmtMonths[1];
  const chainEnd = stmtMonths[stmtMonths.length - 1];

  const bandHistory: BandHistoryEntry[] = [];
  let month = chainStart;
  // chainStart <= chainEnd always holds (stmtMonths is sorted ascending and
  // chainStart is at index 1, chainEnd at the last index).
  while (month <= chainEnd) {
    const r = reconcileTwrAgainstStatements(db, accountId, month);
    if (r === null) {
      bandHistory.push({ monthEndDate: month, band: "missing", divergenceBp: null });
    } else {
      bandHistory.push({
        monthEndDate: month,
        band: r.band,
        divergenceBp: r.divergenceBp,
      });
    }
    month = nextMonthEndDate(month);
  }

  let crossCheckedThru: string | null = null;
  let chainBreak: ChainBreak | null = null;
  for (const entry of bandHistory) {
    if (entry.band === "consistent") {
      crossCheckedThru = entry.monthEndDate;
    } else if (entry.band === "not_comparable") {
      continue; // pass-through: does not break, does not certify
    } else {
      chainBreak = { monthEndDate: entry.monthEndDate, band: entry.band };
      break;
    }
  }

  return { bandHistory, crossCheckedThru, chainBreak };
}

export function getAnalysisTrustState(
  db: Database.Database,
  accountIds?: number[],
  /** The Eastern calendar date the bond durations and the maturity cut are judged on. */
  today: string = todayET(),
): AnalysisTrustState {
  // `undefined` is every account; a defined empty list is NO accounts.
  const { sql: accountFilter, params } = accountScopeAndSql(accountIds);

  // ── Factor coverage ──────────────────────────────────────────────────
  const factorRow = db
    .prepare(
      `
    WITH latest AS (
      SELECT h.security_id FROM holdings h
      WHERE ${latestHoldingsPredicate({ accountFilter })}
      GROUP BY h.security_id
    )
    SELECT
      COUNT(DISTINCT s.id) AS total,
      COUNT(DISTINCT CASE WHEN sf.security_id IS NOT NULL OR sf_u.security_id IS NOT NULL THEN s.id END) AS classified,
      GROUP_CONCAT(CASE WHEN sf.security_id IS NULL AND sf_u.security_id IS NULL THEN s.symbol END) AS missing
    FROM latest l
    JOIN securities s ON s.id = l.security_id
    LEFT JOIN security_factors sf ON sf.security_id = s.id
    -- Options inherit factors from their underlying at query time (same rule
    -- as getFactorHeatmap / getFactorCoverage in lib/queries/analysis.ts) —
    -- count them as classified when the underlying has a factor row, or this
    -- metric contradicts the heatmap it sits above.
    LEFT JOIN securities s_u ON s_u.symbol = s.underlying_symbol
    LEFT JOIN security_factors sf_u ON sf_u.security_id = s_u.id
  `
    )
    .get(...params) as { total: number; classified: number; missing: string | null };

  const total = factorRow.total ?? 0;
  const classified = factorRow.classified ?? 0;
  const missingSymbols = factorRow.missing
    ? factorRow.missing.split(",").filter(Boolean)
    : [];
  const percentage = total > 0 ? classified / total : 0;

  // ── Last classification ──────────────────────────────────────────────
  const lastClassRow = db
    .prepare(`SELECT MAX(updated_at) AS last FROM security_factors`)
    .get() as { last: string | null };

  // ── Last sector classification ───────────────────────────────────────
  // datetime() normalizes the stored text (and turns a value that is not a
  // time into NULL), so the strip never prints a raw or malformed stamp.
  const lastSectorRow = db
    .prepare(`SELECT datetime(value) AS last FROM settings WHERE key = ?`)
    .get(SECTOR_CLASSIFY_LAST_RUN_SETTING) as { last: string | null } | undefined;

  // ── Stale prices ─────────────────────────────────────────────────────
  // Param order: accountIds first (in CTE), STALE_PRICE_DAYS last (outer WHERE)
  const staleRows = db
    .prepare(
      `
    WITH latest AS (
      SELECT h.security_id FROM holdings h
      WHERE ${latestHoldingsPredicate({ accountFilter })}
      GROUP BY h.security_id
    ),
    latest_prices AS (
      SELECT p.security_id, MAX(p.date) AS latest_date
      FROM prices p
      JOIN latest l ON l.security_id = p.security_id
      GROUP BY p.security_id
    )
    SELECT s.symbol
    FROM latest_prices lp
    JOIN securities s ON s.id = lp.security_id
    -- Whole days from the Eastern day (inlined literal), not from SQLite's
    -- UTC clock. ">=" on whole days flags the same days the old fractional
    -- ">" did in daytime; after 20:00 Eastern it no longer flags a day early.
    -- date(...) cuts the price date to its calendar day, so a value that
    -- carried a time of day would still count as that whole day.
    WHERE julianday(${easternDaySql()}) - julianday(date(lp.latest_date)) >= ?
    ORDER BY s.symbol
  `
    )
    .all(...params, STALE_PRICE_DAYS) as { symbol: string }[];

  // ── Never priced ─────────────────────────────────────────────────────
  // The stale query above starts from price rows, so a held security with
  // none can never appear in it — and a missing price is the strongest case
  // of a price not to trust (QA finding
  // analysis-trust-strip-stale-prices--drawer-omits-never-priced-held-options).
  // Same `latest` universe; the anti-join keeps the two lists disjoint.
  const neverPricedRows = db
    .prepare(
      `
    WITH latest AS (
      SELECT h.security_id FROM holdings h
      WHERE ${latestHoldingsPredicate({ accountFilter })}
      GROUP BY h.security_id
    )
    SELECT s.symbol
    FROM latest l
    JOIN securities s ON s.id = l.security_id
    LEFT JOIN prices p ON p.security_id = l.security_id
    WHERE p.security_id IS NULL
    ORDER BY s.symbol
  `
    )
    .all(...params) as { symbol: string }[];

  // ── Bond duration coverage ───────────────────────────────────────────
  // Every bond is judged by `estimateBondRateLeg`, the one duration rule the
  // Fixed Income card and the scenario engines use, with the same stored
  // inputs (latest price included). A bond the card can model is therefore
  // never listed here as lacking a duration. Same Eastern-day maturity cut as
  // the card: a bond past its maturity date is no longer a position.
  const bondRows = db
    .prepare(
      `
    WITH latest AS (
      SELECT h.security_id FROM holdings h
      WHERE ${latestHoldingsPredicate({ accountFilter })}
      GROUP BY h.security_id
    ),
    latest_prices AS (
      SELECT security_id, close_price
      FROM prices
      WHERE (security_id, date) IN (
        SELECT security_id, MAX(date) FROM prices GROUP BY security_id
      )
    )
    SELECT s.id AS securityId, s.symbol, s.name, s.security_type, s.sector,
           s.fund_category, s.duration_years, s.maturity_date, s.coupon_rate,
           lp.close_price AS bond_price
    FROM latest l
    JOIN securities s ON s.id = l.security_id
    LEFT JOIN latest_prices lp ON lp.security_id = s.id
    WHERE LOWER(s.security_type) = 'bond'
      AND ${unmaturedSecuritySql("s", today)}
    ORDER BY s.symbol
  `
    )
    .all(...params) as BondDurationRow[];

  let storedBonds = 0;
  const estimatedBonds: EstimatedDurationBond[] = [];
  const missingDurationBonds: MissingDurationBond[] = [];
  for (const row of bondRows) {
    const leg = estimateBondRateLeg(
      {
        security_type: row.security_type,
        security_name: row.name,
        sector: row.sector,
        fund_category: row.fund_category,
        duration_years: row.duration_years,
        maturity_date: row.maturity_date,
        coupon_rate: row.coupon_rate,
        bond_price: row.bond_price,
      },
      0,
      today,
    );
    const id = { securityId: row.securityId, symbol: row.symbol, name: row.name };
    const duration = leg?.durationYears;
    if (typeof duration !== "number" || !Number.isFinite(duration) || !leg?.durationSource) {
      // Not modelled: listed with the reason, never given a figure.
      missingDurationBonds.push({ ...id, reason: leg?.unmodelledReason ?? null });
    } else if (leg.durationSource === "stored") {
      storedBonds += 1;
    } else {
      estimatedBonds.push({ ...id, durationYears: duration, durationSource: leg.durationSource });
    }
  }

  // ── Independent Dietz cross-check ────────────────────────────────────
  // Semantic for the rollup field `crossCheckedThru`: "all accounts have an
  // unbroken chain of statement-vs-independent-Dietz agreement at least
  // through this month." Take the EARLIEST of each account's own chain
  // frontier — anything past that, at least one account's chain has broken
  // (or never started). Per-account detail flows out via
  // `perAccountReconciliation` (headline: the latest statement month) and
  // each row's `bandHistory` (the full walked chain).
  // Same scope rule: an empty list reconciles no account.
  const accountScope = accountScopeCondition(accountIds, "id");
  const accountList = db
    .prepare(
      `SELECT id, name FROM accounts${
        accountScope.condition === null ? "" : ` WHERE ${accountScope.condition}`
      }`,
    )
    .all(...accountScope.params) as { id: number; name: string }[];

  const perAccount: PerAccountReconciliation[] = [];
  let rollupCrossCheckedThru: string | null = null;
  let anyChainless = false;

  for (const acct of accountList) {
    const latestStmt = db
      .prepare(
        `SELECT month_end_date FROM monthly_snapshots
         WHERE account_id = ? AND source IN (${STATEMENT_SOURCES})
         ORDER BY month_end_date DESC LIMIT 1`
      )
      .get(acct.id) as { month_end_date: string } | undefined;

    const { bandHistory, crossCheckedThru, chainBreak } = walkAccountChain(db, acct.id);

    if (!latestStmt) {
      // No statement row at all — nothing to reconcile, and the rollup
      // must never advance past an unreconciled account.
      perAccount.push({
        accountId: acct.id,
        accountName: acct.name,
        monthEndDate: null,
        statementTwr: null,
        dietzReturn: null,
        divergenceBp: null,
        band: null,
        bandHistory,
        crossCheckedThru: null,
        chainBreak: null,
      });
      anyChainless = true;
      continue;
    }

    const headline: TwrReconcileResult | null = reconcileTwrAgainstStatements(
      db,
      acct.id,
      latestStmt.month_end_date
    );

    perAccount.push({
      accountId: acct.id,
      accountName: acct.name,
      monthEndDate: latestStmt.month_end_date,
      statementTwr: headline?.statementTwr ?? null,
      dietzReturn: headline?.dietzReturn ?? null,
      divergenceBp: headline?.divergenceBp ?? null,
      band: headline?.band ?? null,
      bandHistory,
      crossCheckedThru,
      chainBreak,
    });

    if (crossCheckedThru === null) {
      anyChainless = true;
    } else if (
      rollupCrossCheckedThru === null ||
      crossCheckedThru < rollupCrossCheckedThru
    ) {
      rollupCrossCheckedThru = crossCheckedThru;
    }
  }

  return {
    factorCoverage: { totalNames: total, classified, percentage, missingSymbols },
    lastClassification: lastClassRow.last,
    lastSectorClassification: lastSectorRow?.last ?? null,
    crossCheckedThru: anyChainless ? null : rollupCrossCheckedThru,
    perAccountReconciliation: perAccount,
    stalePrices: {
      count: staleRows.length,
      symbols: staleRows.map((r) => r.symbol),
    },
    neverPriced: {
      count: neverPricedRows.length,
      symbols: neverPricedRows.map((r) => r.symbol),
    },
    bondDuration: {
      totalBonds: bondRows.length,
      withDuration: storedBonds + estimatedBonds.length,
      storedCount: storedBonds,
      estimated: estimatedBonds,
      missing: missingDurationBonds,
    },
  };
}
