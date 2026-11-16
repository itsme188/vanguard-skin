import type Database from "better-sqlite3";
import { addDays, calendarDaysBetween } from "@/lib/calendar/date-utils";
import { SIGNED_EXTERNAL_FLOW_SQL } from "@/lib/compute/flow-adjusted";
import { getDailyValuationsForAccounts } from "@/lib/queries/daily-valuations";
import { getUsdPerUnit } from "@/lib/queries/fx-rates";
import { accountScopeAndSql } from "@/lib/queries/account-scope-sql";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { adjustedMarketValueSQL } from "@/lib/valuation";

/**
 * Scope for attribution: a single account id, an explicit id set, or
 * undefined for the whole portfolio. A DEFINED EMPTY id set is NO accounts
 * (an empty attribution, never the whole book). Multi-account scopes are aggregated —
 * valuations SUMMED per date before the regression, holdings merged per
 * security — never collapsed to the first id (deep-QA 2026-06-11: scope=all
 * rendered account 1's beta/alpha labeled "All accounts").
 */
export type AttributionScope = number | number[] | undefined;

function scopeToIds(scope: AttributionScope): number[] | undefined {
  if (typeof scope === "number") return [scope];
  // `undefined` is every account; a defined empty list stays empty.
  return scope;
}

/** `AND <column> IN (?,?,…)` fragment + params, or empty for whole-portfolio. */
function accountFilter(ids: number[] | undefined, column: string): { sql: string; params: number[] } {
  if (!ids) return { sql: "", params: [] };
  return { sql: ` AND ${column} IN (${ids.map(() => "?").join(",")})`, params: ids };
}

// Guard against the `prices`/`daily_valuations` multi-month gap: a return pair
// spanning more than this many calendar days is dropped (an ln/simple return
// across the gap injects a giant fake "daily" return). Same convention as
// lib/compute/risk.ts.
const MAX_RETURN_GAP_DAYS = 7;

export interface AttributionRow {
  symbol: string;
  contribution: number;
}

export interface SectorAttribution {
  sector: string;
  contribution: number;
}

export interface PeriodAttribution {
  topContributors: AttributionRow[];
  topDetractors: AttributionRow[];
  sectorContribution: SectorAttribution[];
  betaVsAlpha: { betaContribution: number; alphaContribution: number };
  /**
   * The daily window the beta regression actually spanned (first and last
   * valuation date of its aligned return pairs), or null when no regression
   * ran. At a multi-account scope fullCoverageOnly clamps the series to the
   * dates every account co-exists, so this can start well after the
   * requested period start; the card captions it via dataWindowNotice.
   */
  betaWindow: { start: string; end: string } | null;
  /**
   * What betaVsAlpha decomposes: the flow-adjusted return compounded over the
   * regression's aligned daily pairs, and how many pairs there were. Beta
   * contribution + alpha equals portfolioReturn by construction. It is NOT
   * the TWR headline (chained from monthly snapshots over its own window),
   * so the card states this figure rather than leaving the parts to be
   * summed against the TWR tile. Null when no regression ran.
   */
  decomposedReturn: { portfolioReturn: number; observations: number } | null;
  /**
   * What the contributors / detractors / sector lists were weighted from:
   * the position snapshot in force at the start (latest per account and
   * security on or before it), or why there is none. The card renders the
   * reason instead of vanishing.
   */
  positionsBasis: PositionsBasis;
}

// ─── Local beta regression ────────────────────────────────────────────────────

function computeBetaForPeriod(
  db: Database.Database,
  accountIds: number[] | undefined,
  benchmarkSymbol: string,
  startDate: string,
  endDate: string,
): {
  beta: number;
  benchmarkReturn: number;
  portfolioReturn: number;
  observations: number;
  windowStart: string;
  windowEnd: string;
} | null {
  // SUM across the scoped accounts per date BEFORE any return math — the
  // regression must see one portfolio series, never a single account's.
  // fullCoverageOnly is the coverage-jump guard (an appearing account's
  // whole value reads as a fake +89% YTD return) — single-sourced in
  // lib/queries/daily-valuations.ts::fullCoverageHaving since 2026-07-03;
  // this file's inline copy migrated there.
  // (`undefined` = every account; an empty list reads no series.)
  const valuations = getDailyValuationsForAccounts(db, accountIds, {
    startDate,
    endDate,
    fullCoverageOnly: true,
  });

  const benchmarks = db
    .prepare(
      `SELECT date, close_price FROM benchmark_prices
       WHERE symbol = ? AND date BETWEEN ? AND ?
       ORDER BY date ASC`,
    )
    .all(benchmarkSymbol, startDate, endDate) as { date: string; close_price: number }[];

  if (valuations.length < 5 || benchmarks.length < 5) return null;

  // External cash flows (deposits/withdrawals) show up as one-day jumps in
  // daily_valuations. They are not investment return — subtract them from the
  // day's value change so neither the regression nor the period return is
  // distorted (a -$100k withdrawal otherwise reads as a -19% "return").
  const flowFilter = accountFilter(accountIds, "account_id");
  const flowRows = db
    .prepare(
      `SELECT trade_date, SUM(${SIGNED_EXTERNAL_FLOW_SQL}) AS amount
       FROM transactions
       WHERE is_external_flow = 1 AND amount IS NOT NULL
         AND trade_date BETWEEN ? AND ?${flowFilter.sql}
       GROUP BY trade_date`,
    )
    .all(startDate, endDate, ...flowFilter.params) as { trade_date: string; amount: number }[];
  const flowByDate = new Map(flowRows.map((f) => [f.trade_date, f.amount]));

  // Pairs are consecutive BENCHMARK sessions, with the portfolio valuation
  // looked up on each session date. daily_valuations carries a row for every
  // calendar day (the fallback writes weekends and holidays too) and those
  // rows have no benchmark close, so walking valuation rows dropped every
  // Friday-to-Monday session. Walking sessions means a weekend or holiday
  // valuation row can never break a Friday-to-Monday pair. A session whose
  // date has no valuation drops the two pairs it belongs to, never more.
  const valueByDate = new Map(valuations.map((v) => [v.valuation_date, v.total_value]));
  const aligned: { portReturn: number; benchReturn: number }[] = [];
  let windowStart: string | null = null;
  let windowEnd: string | null = null;

  for (let i = 1; i < benchmarks.length; i++) {
    const prev = benchmarks[i - 1];
    const curr = benchmarks[i];
    // Gap guard: never compute a "daily" return across a multi-week hole
    // in either series (measured between the two session dates).
    if (calendarDaysBetween(prev.date, curr.date) > MAX_RETURN_GAP_DAYS) {
      continue;
    }
    const valuePrev = valueByDate.get(prev.date);
    const valueCurr = valueByDate.get(curr.date);
    if (
      valuePrev !== undefined &&
      valueCurr !== undefined &&
      valuePrev > 0 &&
      valueCurr > 0 &&
      prev.close_price > 0
    ) {
      // Net external flow attributed to this pair: flows dated after the
      // previous session up to and including this one (a weekend flow lands
      // in the Friday-to-Monday pair; the first valuation already reflects
      // earlier flows).
      let flow = 0;
      for (const [date, amount] of flowByDate) {
        if (date > prev.date && date <= curr.date) flow += amount;
      }
      aligned.push({
        portReturn: (valueCurr - valuePrev - flow) / valuePrev,
        benchReturn: (curr.close_price - prev.close_price) / prev.close_price,
      });
      windowStart ??= prev.date;
      windowEnd = curr.date;
    }
  }

  if (aligned.length < 5 || windowStart === null || windowEnd === null) return null;

  const meanP = aligned.reduce((s, r) => s + r.portReturn, 0) / aligned.length;
  const meanB = aligned.reduce((s, r) => s + r.benchReturn, 0) / aligned.length;
  let covar = 0;
  let varB = 0;
  for (const r of aligned) {
    covar += (r.portReturn - meanP) * (r.benchReturn - meanB);
    varB += (r.benchReturn - meanB) ** 2;
  }
  if (varB === 0) return null;
  const beta = covar / varB;

  // Compound BOTH period returns over the same aligned (flow-adjusted,
  // gap-guarded) pairs so the decomposition is internally consistent:
  // portfolioReturn = beta × benchmarkReturn + alpha by construction.
  const portfolioReturn = aligned.reduce((p, r) => p * (1 + r.portReturn), 1) - 1;
  const benchmarkReturn = aligned.reduce((p, r) => p * (1 + r.benchReturn), 1) - 1;

  return { beta, benchmarkReturn, portfolioReturn, observations: aligned.length, windowStart, windowEnd };
}

// ─── Per-position contributions ───────────────────────────────────────────────

/**
 * How old the start book may be. The start dates this card is handed are a
 * January 1 or a statement month-end, so the book in force is the statement
 * on or just before it; one statement cycle of slack covers a month whose
 * statement is missing. Anything older is not "the positions at the start".
 */
const MAX_START_BOOK_AGE_DAYS = 31;
/**
 * How old a close may be and still stand for the start or end date: a weekend
 * or holiday at either end, the same bound as the return-gap guard above.
 */
const MAX_PRICE_AGE_DAYS = MAX_RETURN_GAP_DAYS;

/** Why the contributors / detractors / sector lists are empty, when they are. */
export type PositionsEmptyReason =
  /** No scoped account has a position snapshot at the start. */
  | "no_positions_at_start"
  /** A scoped account held value at the start but no position snapshot of it is on file then. */
  | "accounts_missing_at_start";

export interface PositionsBasis {
  /** Earliest position-snapshot date the start weights were read from, or null when none were. */
  asOf: string | null;
  /** Null when contributions were measured. */
  emptyReason: PositionsEmptyReason | null;
  /** Scoped accounts that held value at the start with no position snapshot then. */
  missingAccounts: string[];
}

function computePerPositionContributions(
  db: Database.Database,
  accountIds: number[] | undefined,
  startDate: string,
  endDate: string,
): { rows: AttributionRow[]; sectorMap: Map<string, number>; basis: PositionsBasis } {
  // Validated: the as-of dates are inlined as literals by
  // latestHoldingsPredicate (its own pattern), so they must be plain dates.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    throw new Error(`computePeriodAttribution: dates must match YYYY-MM-DD, got ${startDate} / ${endDate}`);
  }
  const bookFloor = addDays(startDate, -MAX_START_BOOK_AGE_DAYS);
  const empty = (emptyReason: PositionsEmptyReason, missingAccounts: string[] = []) => ({
    rows: [] as AttributionRow[],
    sectorMap: new Map<string, number>(),
    basis: { asOf: null, emptyReason, missingAccounts },
  });

  // Per account in scope: the newest position snapshot on or before the start
  // (no look-ahead), and whether the account held value then (a statement
  // month-end inside the same window with a positive total). An account that
  // had money but no book cannot be weighted, and weighting the rest of the
  // scope without it would present a part of the scope as the whole.
  const scopeSql = accountScopeAndSql(accountIds, "a.id");
  const accounts = db
    .prepare(
      `SELECT a.id, a.name,
         (SELECT MAX(h.as_of_date) FROM holdings h
           WHERE h.account_id = a.id AND h.as_of_date <= ? AND h.as_of_date >= ?) AS book_date,
         EXISTS (SELECT 1 FROM monthly_snapshots ms
           WHERE ms.account_id = a.id AND ms.month_end_date <= ? AND ms.month_end_date >= ?
             AND ms.total_value > 0) AS had_value
       FROM accounts a
       WHERE 1 = 1 ${scopeSql.sql}
       ORDER BY a.id`,
    )
    .all(startDate, bookFloor, startDate, bookFloor, ...scopeSql.params) as Array<{
    id: number;
    name: string;
    book_date: string | null;
    had_value: number;
  }>;
  const missingAccounts = accounts.filter((a) => a.book_date === null && a.had_value === 1).map((a) => a.name);
  if (missingAccounts.length > 0) return empty("accounts_missing_at_start", missingAccounts);
  const bookAccounts = accounts.filter((a) => a.book_date !== null);
  if (bookAccounts.length === 0) return empty("no_positions_at_start");

  // The latest row per (account, security) on or before the start
  // (latestHoldingsPredicate with asOfDate; a quantity-0 tombstone as that
  // row closes the position), inside the same age window so a sold position
  // with no tombstone is not carried forward from an old book.
  const bookScope = accountScopeAndSql(
    bookAccounts.map((a) => a.id),
    "h.account_id",
  );
  const predicate = latestHoldingsPredicate({
    keyBy: "account_security",
    includeShorts: false, // long-only by design (see below)
    asOfDate: startDate,
    accountFilter: bookScope.sql,
  });
  // GROUP BY security: the same symbol held in two scoped accounts is ONE
  // position with the combined quantity, not two duplicate rows. Prices are
  // the latest close on or before each end, never after it, and no older
  // than a weekend or holiday.
  const rows = db
    .prepare(
      `WITH start_book AS (
         SELECT h.security_id, SUM(h.quantity) AS qty
         FROM holdings h
         WHERE ${predicate} AND h.as_of_date >= ?
         GROUP BY h.security_id
       )
       SELECT
         s.symbol,
         ${adjustedMarketValueSQL("b.qty", "ps.close_price", "s.security_type", "s.multiplier")} AS start_value_native,
         ps.close_price AS start_price,
         pe.close_price AS end_price,
         s.currency,
         COALESCE(s.sector, 'Unclassified') AS sector
       FROM start_book b
       JOIN securities s ON s.id = b.security_id
       JOIN prices ps ON ps.security_id = b.security_id
         AND ps.date = (SELECT MAX(p.date) FROM prices p
                        WHERE p.security_id = b.security_id AND p.date <= ? AND p.date >= ?)
       LEFT JOIN prices pe ON pe.security_id = b.security_id
         AND pe.date = (SELECT MAX(p.date) FROM prices p
                        WHERE p.security_id = b.security_id AND p.date <= ? AND p.date >= ?)
       WHERE LOWER(s.security_type) IN ('stock', 'etf', 'common stock', 'mutual fund')
         AND b.qty > 0
         AND ps.close_price > 0`, // Sector contribution analysis is long-only; short positions excluded by design.
    )
    .all(
      ...bookScope.params,
      bookFloor,
      startDate,
      addDays(startDate, -MAX_PRICE_AGE_DAYS),
      endDate,
      addDays(endDate, -MAX_PRICE_AGE_DAYS),
    ) as Array<{
    symbol: string;
    start_value_native: number;
    start_price: number;
    end_price: number | null;
    currency: string | null;
    sector: string;
  }>;

  if (rows.length === 0) return empty("no_positions_at_start");

  // Per-holding $ WEIGHTS must be USD-comparable across securities — a raw
  // native-currency qty×price sum would let a KRW holding's won notional
  // dominate totalStartValue and hence startWeight (the "contribution"
  // phantom). The %-return factor (positionReturn) is currency-invariant
  // (a ratio of two same-currency prices) and stays unconverted.
  const usdPerUnitFor = (currency: string | null) => getUsdPerUnit(db, currency);
  const totalStartValue = rows.reduce(
    (s, r) => s + r.start_value_native * usdPerUnitFor(r.currency),
    0,
  );
  if (totalStartValue === 0) return empty("no_positions_at_start");

  const contributions: AttributionRow[] = [];
  const sectorMap = new Map<string, number>();

  for (const r of rows) {
    if (r.end_price == null) continue;
    const startValueUsd = r.start_value_native * usdPerUnitFor(r.currency);
    const startWeight = startValueUsd / totalStartValue;
    const positionReturn = (r.end_price - r.start_price) / r.start_price;
    const contribution = startWeight * positionReturn;
    contributions.push({ symbol: r.symbol, contribution });
    sectorMap.set(r.sector, (sectorMap.get(r.sector) ?? 0) + contribution);
  }

  const asOf = bookAccounts.map((a) => a.book_date as string).sort()[0];
  return {
    rows: contributions,
    sectorMap,
    basis: {
      asOf,
      emptyReason: contributions.length === 0 ? "no_positions_at_start" : null,
      missingAccounts: [],
    },
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function computePeriodAttribution(
  db: Database.Database,
  /** Single id, explicit id set, or undefined = whole portfolio. */
  scope: AttributionScope,
  startDate: string,
  endDate: string,
  benchmarkSymbol: string = "SPY",
): PeriodAttribution {
  const accountIds = scopeToIds(scope);
  // No accounts: nothing to attribute. Same result an account with no data
  // gets (no positions, no regression).
  if (accountIds && accountIds.length === 0) {
    return {
      topContributors: [],
      topDetractors: [],
      sectorContribution: [],
      betaVsAlpha: { betaContribution: 0, alphaContribution: 0 },
      betaWindow: null,
      decomposedReturn: null,
      positionsBasis: { asOf: null, emptyReason: "no_positions_at_start", missingAccounts: [] },
    };
  }
  const { rows, sectorMap, basis: positionsBasis } = computePerPositionContributions(
    db,
    accountIds,
    startDate,
    endDate,
  );

  const sortedDesc = [...rows].sort((a, b) => b.contribution - a.contribution);
  const topContributors = sortedDesc.filter((r) => r.contribution > 0).slice(0, 5);
  // For detractors: sort ascending (most-negative first) so the worst performers
  // appear first. Explicit sort rather than .reverse() makes the intent clear.
  const topDetractors = rows
    .filter((r) => r.contribution < 0)
    .sort((a, b) => a.contribution - b.contribution)
    .slice(0, 5);

  const sectorContribution = [...sectorMap.entries()]
    .map(([sector, contribution]) => ({ sector, contribution }))
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  // Decompose the PORTFOLIO's period return (from the daily-valuation series —
  // the same series the beta regression runs on), never the sum of per-position
  // contributions: those cover only the long equity and fund book held at the
  // start and can be empty, which made alpha ≡ −betaContribution (the
  // 2026-06-10 bug).
  let betaContribution = 0;
  let alphaContribution = 0;
  let betaWindow: PeriodAttribution["betaWindow"] = null;
  let decomposedReturn: PeriodAttribution["decomposedReturn"] = null;
  const reg = computeBetaForPeriod(db, accountIds, benchmarkSymbol, startDate, endDate);
  if (reg) {
    betaContribution = reg.beta * reg.benchmarkReturn;
    alphaContribution = reg.portfolioReturn - betaContribution;
    betaWindow = { start: reg.windowStart, end: reg.windowEnd };
    decomposedReturn = { portfolioReturn: reg.portfolioReturn, observations: reg.observations };
  }

  return {
    topContributors,
    topDetractors,
    sectorContribution,
    betaVsAlpha: { betaContribution, alphaContribution },
    betaWindow,
    decomposedReturn,
    positionsBasis,
  };
}
