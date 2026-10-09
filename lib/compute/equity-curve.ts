// Pure builder for the Performance equity curve ("indexed to 100").
//
// Both series MUST be indexed to the same date — the first PLOTTED point
// (the first valuation date that also has a benchmark close). Basing the
// benchmark at the SELECTED-PERIOD start instead let SPY carry months or
// years of pre-window returns into the chart: on 1Y+ the benchmark started
// ~30 points above the portfolio and an outperforming book read as a large
// laggard, contradicting the alpha decomposition on the same page.
// (qa:analysis-performance--equity-curve-benchmark-not-reindexed-to-100)
//
// The PORTFOLIO series is flow-adjusted and seam-bridged (see
// lib/compute/flow-adjusted.ts) — never a raw total_value ratio. A raw index
// reads a deposit/withdrawal as a market move (CLAUDE.md: "a metric must be
// invariant to depositing $1M and buying nothing") and reads an
// anchor-source handoff (statement<->Plaid<->TWS) as a fake step. The
// BENCHMARK series stays a plain raw-close ratio — SPY has no external
// flows and no measurement-basis seams.
// (qa:analysis-performance--equity-curve-raw-value-not-flow-adjusted)
//
// FLOOR (ruling 2026-09-02): the curve starts at the first statement anchor.
// A daily value dated before an account's first statement is an estimate, so
// as the base day it put a fake step on the statement day. `floorDate` (see
// lib/compute/equity-curve-floor.ts) drops every earlier day before anything
// is indexed, so the base day is statement-tied.
// (qa:analysis-performance--equity-curve-pre-anchor-estimated-base-day-step)

import { buildFlowAdjustedIndex, type SeriesPoint } from "./flow-adjusted";

export interface EquityCurvePoint {
  date: string;
  portfolio: number; // indexed to 100 at the first plotted date
  benchmark: number; // indexed to 100 at the same date
}

export function buildEquityCurveData(
  dailyVals: Array<{ valuation_date: string; total_value: number }>,
  benchmarkRows: Array<{ date: string; close_price: number }>,
  flows: { date: string; net: number }[] = [],
  seamDates: string[] = [],
  /** First statement anchor for the scope; days before it are not plotted.
   *  null / undefined = no floor. */
  floorDate?: string | null
): EquityCurvePoint[] {
  // Floor first: the growth index below bases on the series' first row, and
  // buildFlowAdjustedIndex treats a flow or seam on or before that row as
  // already inside the opening value, so nothing dated before the floor can
  // reach the plotted returns.
  if (floorDate) {
    dailyVals = dailyVals.filter((v) => v.valuation_date >= floorDate);
  }
  if (dailyVals.length < 2 || benchmarkRows.length < 2) return [];

  const benchByDate = new Map(benchmarkRows.map((b) => [b.date, b.close_price]));

  // First point that will actually be plotted: has a positive portfolio
  // value AND a positive benchmark close on the same date.
  const first = dailyVals.find((v) => {
    const bp = benchByDate.get(v.valuation_date);
    return v.total_value > 0 && bp != null && bp > 0;
  });
  if (!first) return [];

  const benchBase = benchByDate.get(first.valuation_date)!;

  // Build the flow-adjusted, seam-bridged growth index over the FULL
  // daily-valuation series — not filtered down to benchmark-matching dates
  // first. A flow or seam must be netted out against its OWN date even when
  // that date has no benchmark close (e.g. a market holiday); the
  // half-open interval bucketing inside buildFlowAdjustedIndex already
  // folds any skipped date's flows/seams into the next retained step, so
  // pre-filtering would only risk misattributing a flow to the wrong step.
  const series: SeriesPoint[] = dailyVals.map((v) => ({
    date: v.valuation_date,
    value: v.total_value,
  }));
  const { index } = buildFlowAdjustedIndex(series, flows, seamDates);
  const indexByDate = new Map(index.map((p) => [p.date, p.value]));

  // Rebase the growth index (which starts at 1 on dailyVals[0].date, the
  // series' absolute first date) to the first PLOTTED date so it lines up
  // with the benchmark's base — the same "first plotted, not first overall"
  // contract as the benchmark base above.
  const portBase = indexByDate.get(first.valuation_date);
  if (portBase == null || portBase <= 0) return [];

  return dailyVals
    .map((v) => {
      const benchPrice = benchByDate.get(v.valuation_date);
      if (benchPrice == null || benchPrice <= 0) return null;
      const portIndex = indexByDate.get(v.valuation_date);
      if (portIndex == null) return null;
      return {
        date: v.valuation_date,
        portfolio: (portIndex / portBase) * 100,
        benchmark: (benchPrice / benchBase) * 100,
      };
    })
    .filter((d): d is EquityCurvePoint => d !== null);
}
