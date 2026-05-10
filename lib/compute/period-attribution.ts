import type Database from "better-sqlite3";

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
): { beta: number; benchmarkReturn: number } | null {
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

  const benchByDate = new Map(benchmarks.map((b) => [b.date, b.close_price]));
  const aligned: { portReturn: number; benchReturn: number }[] = [];

  for (let i = 1; i < valuations.length; i++) {
    const prev = valuations[i - 1];
    const curr = valuations[i];
    const benchPrev = benchByDate.get(prev.valuation_date);
    const benchCurr = benchByDate.get(curr.valuation_date);
    if (benchPrev && benchCurr && prev.total_value > 0 && benchPrev > 0) {
      aligned.push({
        portReturn: (curr.total_value - prev.total_value) / prev.total_value,
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

  const firstBench = benchmarks[0].close_price;
  const lastBench = benchmarks[benchmarks.length - 1].close_price;
  const benchmarkReturn = (lastBench - firstBench) / firstBench;

  return { beta, benchmarkReturn };
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
         AND hs.quantity > 0`,
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

  const totalReturn = rows.reduce((s, r) => s + r.contribution, 0);
  let betaContribution = 0;
  let alphaContribution = 0;
  const reg = computeBetaForPeriod(db, accountId, benchmarkSymbol, startDate, endDate);
  if (reg) {
    betaContribution = reg.beta * reg.benchmarkReturn;
    alphaContribution = totalReturn - betaContribution;
  }

  return {
    topContributors,
    topDetractors,
    sectorContribution,
    betaVsAlpha: { betaContribution, alphaContribution },
  };
}
