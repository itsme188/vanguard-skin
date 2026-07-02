import type Database from "better-sqlite3";
import { calendarDaysBetween } from "@/lib/calendar/date-utils";
import {
  getDailyValuationsCombined,
  getDailyValuationsForAccounts,
} from "@/lib/queries/daily-valuations";
import { getUsdPerUnit } from "@/lib/queries/fx-rates";

/**
 * Scope for attribution: a single account id, an explicit id set, or
 * undefined for the whole portfolio. Multi-account scopes are aggregated —
 * valuations SUMMED per date before the regression, holdings merged per
 * security — never collapsed to the first id (deep-QA 2026-06-11: scope=all
 * rendered account 1's beta/alpha labeled "All accounts").
 */
export type AttributionScope = number | number[] | undefined;

function scopeToIds(scope: AttributionScope): number[] | undefined {
  if (typeof scope === "number") return [scope];
  if (scope && scope.length > 0) return scope;
  return undefined;
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
}

// ─── Local beta regression ────────────────────────────────────────────────────

function computeBetaForPeriod(
  db: Database.Database,
  accountIds: number[] | undefined,
  benchmarkSymbol: string,
  startDate: string,
  endDate: string,
): { beta: number; benchmarkReturn: number; portfolioReturn: number } | null {
  // SUM across the scoped accounts per date BEFORE any return math — the
  // regression must see one portfolio series, never a single account's.
  const summed = accountIds
    ? getDailyValuationsForAccounts(db, accountIds, { startDate, endDate })
    : getDailyValuationsCombined(db, { startDate, endDate });

  // Full-coverage filter: only dates where the MAX number of simultaneously-
  // covered accounts all have a row. Account coverage windows differ (live
  // DB: IBKR daily valuations start 3/27, Vanguard + Roth 4/06) and the
  // summed series "gains" an appearing account's entire value as a fake
  // return — a 4-day pair slips under the gap guard and read as +89% YTD.
  // Max-coverage (not accountIds.length) self-calibrates when a scoped
  // account has no data at all in the window. Omit, never mislead.
  const covFilter = accountFilter(accountIds, "account_id");
  const coverage = new Map<string, number>();
  for (const row of db
    .prepare(
      `SELECT valuation_date AS d, COUNT(DISTINCT account_id) AS n
       FROM daily_valuations
       WHERE valuation_date BETWEEN ? AND ?${covFilter.sql}
       GROUP BY valuation_date`,
    )
    .all(startDate, endDate, ...covFilter.params) as { d: string; n: number }[]) {
    coverage.set(row.d, row.n);
  }
  const fullCoverage = Math.max(0, ...coverage.values());
  const valuations = summed.filter((v) => coverage.get(v.valuation_date) === fullCoverage);

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
      `SELECT trade_date, SUM(amount) AS amount
       FROM transactions
       WHERE is_external_flow = 1 AND amount IS NOT NULL
         AND trade_date BETWEEN ? AND ?${flowFilter.sql}
       GROUP BY trade_date`,
    )
    .all(startDate, endDate, ...flowFilter.params) as { trade_date: string; amount: number }[];
  const flowByDate = new Map(flowRows.map((f) => [f.trade_date, f.amount]));

  const benchByDate = new Map(benchmarks.map((b) => [b.date, b.close_price]));
  const aligned: { portReturn: number; benchReturn: number }[] = [];

  for (let i = 1; i < valuations.length; i++) {
    const prev = valuations[i - 1];
    const curr = valuations[i];
    // Gap guard: never compute a "daily" return across a multi-week hole
    if (calendarDaysBetween(prev.valuation_date, curr.valuation_date) > MAX_RETURN_GAP_DAYS) {
      continue;
    }
    const benchPrev = benchByDate.get(prev.valuation_date);
    const benchCurr = benchByDate.get(curr.valuation_date);
    if (benchPrev && benchCurr && prev.total_value > 0 && benchPrev > 0) {
      // Net external flow attributed to this pair: flows dated after prev up
      // to and including curr (the first valuation already reflects earlier flows).
      let flow = 0;
      for (const [date, amount] of flowByDate) {
        if (date > prev.valuation_date && date <= curr.valuation_date) flow += amount;
      }
      aligned.push({
        portReturn: (curr.total_value - prev.total_value - flow) / prev.total_value,
        benchReturn: (benchCurr - benchPrev) / benchPrev,
      });
    }
  }

  if (aligned.length < 5) return null;

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

  return { beta, benchmarkReturn, portfolioReturn };
}

// ─── Per-position contributions ───────────────────────────────────────────────

function computePerPositionContributions(
  db: Database.Database,
  accountIds: number[] | undefined,
  startDate: string,
  endDate: string,
): { rows: AttributionRow[]; sectorMap: Map<string, number> } {
  const acctFilter = accountFilter(accountIds, "hs.account_id");
  // GROUP BY security: the same symbol held in two scoped accounts is ONE
  // position with the combined quantity, not two duplicate rows.
  const rows = db
    .prepare(
      `SELECT
         s.symbol,
         SUM(hs.quantity) AS qty,
         ps.close_price AS start_price,
         pe.close_price AS end_price,
         s.currency,
         COALESCE(s.sector, 'Unclassified') AS sector
       FROM holdings hs
       JOIN securities s ON s.id = hs.security_id
       JOIN prices ps ON ps.security_id = hs.security_id AND ps.date = ?
       LEFT JOIN prices pe ON pe.security_id = hs.security_id AND pe.date = ?
       WHERE hs.as_of_date = ?${acctFilter.sql}
         AND LOWER(s.security_type) IN ('stock', 'etf', 'common stock', 'mutual fund')
         AND hs.quantity > 0
       GROUP BY s.id`, // Sector contribution analysis is long-only; short positions excluded by design.
    )
    .all(startDate, endDate, startDate, ...acctFilter.params) as Array<{
    symbol: string;
    qty: number;
    start_price: number;
    end_price: number | null;
    currency: string | null;
    sector: string;
  }>;

  if (rows.length === 0) return { rows: [], sectorMap: new Map() };

  // Per-holding $ WEIGHTS must be USD-comparable across securities — a raw
  // native-currency qty×price sum would let a KRW holding's won notional
  // dominate totalStartValue and hence startWeight (the "contribution"
  // phantom). The %-return factor (positionReturn) is currency-invariant
  // (a ratio of two same-currency prices) and stays unconverted.
  const usdPerUnitFor = (currency: string | null) => getUsdPerUnit(db, currency);
  const totalStartValue = rows.reduce(
    (s, r) => s + r.qty * r.start_price * usdPerUnitFor(r.currency),
    0,
  );
  if (totalStartValue === 0) return { rows: [], sectorMap: new Map() };

  const contributions: AttributionRow[] = [];
  const sectorMap = new Map<string, number>();

  for (const r of rows) {
    if (r.end_price == null) continue;
    const startValueUsd = r.qty * r.start_price * usdPerUnitFor(r.currency);
    const startWeight = startValueUsd / totalStartValue;
    const positionReturn = (r.end_price - r.start_price) / r.start_price;
    const contribution = startWeight * positionReturn;
    contributions.push({ symbol: r.symbol, contribution });
    sectorMap.set(r.sector, (sectorMap.get(r.sector) ?? 0) + contribution);
  }

  return { rows: contributions, sectorMap };
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
  const { rows, sectorMap } = computePerPositionContributions(
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
  // contributions: those require holdings + prices at exactly startDate and are
  // routinely empty, which made alpha ≡ −betaContribution (the 2026-06-10 bug).
  let betaContribution = 0;
  let alphaContribution = 0;
  const reg = computeBetaForPeriod(db, accountIds, benchmarkSymbol, startDate, endDate);
  if (reg) {
    betaContribution = reg.beta * reg.benchmarkReturn;
    alphaContribution = reg.portfolioReturn - betaContribution;
  }

  return {
    topContributors,
    topDetractors,
    sectorContribution,
    betaVsAlpha: { betaContribution, alphaContribution },
  };
}
