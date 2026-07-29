// Pure builder for the Performance equity curve ("indexed to 100").
//
// Both series MUST be indexed to the same date — the first PLOTTED point
// (the first valuation date that also has a benchmark close). Basing the
// benchmark at the SELECTED-PERIOD start instead let SPY carry months or
// years of pre-window returns into the chart: on 1Y+ the benchmark started
// ~30 points above the portfolio and an outperforming book read as a large
// laggard, contradicting the alpha decomposition on the same page.
// (qa:analysis-performance--equity-curve-benchmark-not-reindexed-to-100)

export interface EquityCurvePoint {
  date: string;
  portfolio: number; // indexed to 100 at the first plotted date
  benchmark: number; // indexed to 100 at the same date
}

export function buildEquityCurveData(
  dailyVals: Array<{ valuation_date: string; total_value: number }>,
  benchmarkRows: Array<{ date: string; close_price: number }>
): EquityCurvePoint[] {
  if (dailyVals.length < 2 || benchmarkRows.length < 2) return [];

  const benchByDate = new Map(benchmarkRows.map((b) => [b.date, b.close_price]));

  // First point that will actually be plotted: has a positive portfolio
  // value AND a positive benchmark close on the same date.
  const first = dailyVals.find((v) => {
    const bp = benchByDate.get(v.valuation_date);
    return v.total_value > 0 && bp != null && bp > 0;
  });
  if (!first) return [];

  const portBase = first.total_value;
  const benchBase = benchByDate.get(first.valuation_date)!;

  return dailyVals
    .map((v) => {
      const benchPrice = benchByDate.get(v.valuation_date);
      if (benchPrice == null || benchPrice <= 0) return null;
      return {
        date: v.valuation_date,
        portfolio: (v.total_value / portBase) * 100,
        benchmark: (benchPrice / benchBase) * 100,
      };
    })
    .filter((d): d is EquityCurvePoint => d !== null);
}
