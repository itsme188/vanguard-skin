import type Database from "better-sqlite3";
import { calendarDaysBetween } from "@/lib/calendar/date-utils";

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
  accountId: number,
  benchmarkSymbol: string,
  startDate: string,
  endDate: string,
): { beta: number; benchmarkReturn: number; portfolioReturn: number } | null {
  const valuations = db
    .prepare(
      `SELECT valuation_date, total_value FROM daily_valuations
       WHERE account_id = ? AND valuation_date BETWEEN ? AND ?
       ORDER BY valuation_date ASC`,
    )
    .all(accountId, startDate, endDate) as { valuation_date: string; total_value: number }[];

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
  const flowRows = db
    .prepare(
      `SELECT trade_date, SUM(amount) AS amount
       FROM transactions
       WHERE account_id = ? AND is_external_flow = 1 AND amount IS NOT NULL
         AND trade_date BETWEEN ? AND ?
       GROUP BY trade_date`,
    )
    .all(accountId, startDate, endDate) as { trade_date: string; amount: number }[];
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
  accountId: number,
  startDate: string,
  endDate: string,
): { rows: AttributionRow[]; sectorMap: Map<string, number> } {
  const rows = db
    .prepare(
      `SELECT
         s.symbol,
         hs.quantity AS qty,
         ps.close_price AS start_price,
         pe.close_price AS end_price,
         COALESCE(s.sector, 'Unclassified') AS sector
       FROM holdings hs
       JOIN securities s ON s.id = hs.security_id
       JOIN prices ps ON ps.security_id = hs.security_id AND ps.date = ?
       LEFT JOIN prices pe ON pe.security_id = hs.security_id AND pe.date = ?
       WHERE hs.account_id = ? AND hs.as_of_date = ?
         AND LOWER(s.security_type) IN ('stock', 'etf', 'common stock', 'mutual fund')
         AND hs.quantity > 0`, // Sector contribution analysis is long-only; short positions excluded by design.
    )
    .all(startDate, endDate, accountId, startDate) as Array<{
    symbol: string;
    qty: number;
    start_price: number;
    end_price: number | null;
    sector: string;
  }>;

  if (rows.length === 0) return { rows: [], sectorMap: new Map() };

  const totalStartValue = rows.reduce((s, r) => s + r.qty * r.start_price, 0);
  if (totalStartValue === 0) return { rows: [], sectorMap: new Map() };

  const contributions: AttributionRow[] = [];
  const sectorMap = new Map<string, number>();

  for (const r of rows) {
    if (r.end_price == null) continue;
    const startWeight = (r.qty * r.start_price) / totalStartValue;
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
  accountId: number,
  startDate: string,
  endDate: string,
  benchmarkSymbol: string = "SPY",
): PeriodAttribution {
  const { rows, sectorMap } = computePerPositionContributions(
    db,
    accountId,
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
  const reg = computeBetaForPeriod(db, accountId, benchmarkSymbol, startDate, endDate);
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
