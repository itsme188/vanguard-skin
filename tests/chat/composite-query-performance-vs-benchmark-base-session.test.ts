/**
 * query_performance_vs_benchmark draws its curve with the page's own loader
 * (loadPerformanceCurve, lib/compute/equity-curve.ts), so the chat and the
 * Performance view cannot show two curves for one window (2026-11-24).
 *
 * Protects: a YTD window opening on a closed day (Jan 1) starts on the base
 * session (the Dec 31 close), as the page does; a window opening on a trading
 * day answers exactly as before. All values are synthetic.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { queryPerformanceVsBenchmarkTool } from "@/lib/chat/composite/performance-vs-benchmark";
import { buildEquityCurveData, loadPerformanceCurve } from "@/lib/compute/equity-curve";
import { curveFloorDate, firstStatementAnchorForCurve } from "@/lib/compute/equity-curve-floor";
import { getDailyValuationsForAccounts } from "@/lib/queries/daily-valuations";
import { fetchAnchorSourceSeamDates, fetchNetFlowsByDate } from "@/lib/compute/flow-adjusted";

const HOLIDAYS = new Set(["2025-12-25", "2026-01-01", "2026-01-19"]);
const CYCLE = [0.01, -0.006, 0.008, 0.003, -0.004, 0.007, 0.002, -0.005, 0.009, -0.002];

function* calendarDays(from: string, to: string): Generator<string> {
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d <= end) {
    yield d.toISOString().slice(0, 10);
    d.setUTCDate(d.getUTCDate() + 1);
  }
}
const isSession = (date: string) => {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6 && !HOLIDAYS.has(date);
};

/** Account 3: a book of 1,000 x the benchmark, a valuation every calendar
 *  day, benchmark closes on sessions. `fixed` overrides closes. */
function seed(db: Database.Database, from: string, to: string, fixed: Record<string, number> = {}): void {
  let close = 100;
  let k = 0;
  let last = close;
  let first = true;
  for (const date of calendarDays(from, to)) {
    if (isSession(date)) {
      if (!first) close = close * (1 + CYCLE[k++ % CYCLE.length]);
      first = false;
      if (fixed[date] !== undefined) close = fixed[date];
      last = close;
      db.prepare("INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'test')").run(
        date,
        close,
      );
    }
    const v = 1000 * last;
    db.prepare(
      "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (3, ?, 0, ?, ?)",
    ).run(date, v, v);
  }
}

type Vs = {
  first_date: string;
  last_date: string;
  days_plotted: number;
  portfolio_index_end: number;
  benchmark_index_end: number;
  portfolio_return: number;
  benchmark_return: number;
};

/** The chat's curve exactly as the tool built it before it used the loader. */
function oldCurve(db: Database.Database, ids: number[], start: string, end: string) {
  const curveFloor = firstStatementAnchorForCurve(db, ids, start, end);
  const seriesStart = curveFloorDate(start, curveFloor);
  const dailyVals = getDailyValuationsForAccounts(db, ids, { startDate: seriesStart, endDate: end, fullCoverageOnly: true });
  const bench = db
    .prepare("SELECT date, close_price FROM benchmark_prices WHERE symbol = 'SPY' AND date BETWEEN ? AND ? ORDER BY date")
    .all(start, end) as { date: string; close_price: number }[];
  const from = dailyVals.length >= 2 ? dailyVals[0].valuation_date : null;
  const to = dailyVals.length >= 2 ? dailyVals[dailyVals.length - 1].valuation_date : null;
  const flows = from && to ? fetchNetFlowsByDate(db, ids, from, to) : [];
  const seams = from && to ? fetchAnchorSourceSeamDates(db, ids, from, to) : [];
  return buildEquityCurveData(dailyVals, bench, flows, seams, curveFloor);
}

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("query_performance_vs_benchmark uses the page's curve loader", () => {
  it("YTD opening on Jan 1 starts on the Dec 31 base session, as the page does", () => {
    seed(db, "2025-12-31", "2026-02-13", { "2025-12-31": 100, "2026-01-02": 105, "2026-02-13": 112.11 });
    const out = queryPerformanceVsBenchmarkTool.run(db, { period: "ytd" }, { accountIds: [3], today: "2026-02-13" }) as {
      vs_benchmark: Vs;
    };
    const page = loadPerformanceCurve(db, [3], "2026-01-01", "2026-02-13", "SPY").data;
    // Before: first_date 2026-01-02, both ends 106.77 (the Jan 2 session lost).
    expect(oldCurve(db, [3], "2026-01-01", "2026-02-13")[0].date).toBe("2026-01-02");
    expect(out.vs_benchmark.first_date).toBe("2025-12-31");
    expect(out.vs_benchmark.first_date).toBe(page[0].date);
    expect(out.vs_benchmark.last_date).toBe(page[page.length - 1].date);
    expect(out.vs_benchmark.portfolio_index_end).toBe(page[page.length - 1].portfolio);
    expect(out.vs_benchmark.benchmark_index_end).toBe(page[page.length - 1].benchmark);
    expect(out.vs_benchmark.benchmark_index_end).toBeCloseTo(112.11, 8);
    expect(out.vs_benchmark.days_plotted).toBe(page.length);
  });

  it("a window opening on a trading day answers exactly as before (old = new)", () => {
    // 1Y ending on the Jul 31, 2026 statement opens on Thu Jul 31, 2025.
    seed(db, "2025-07-24", "2026-07-31");
    for (const d of ["2025-07-31", "2026-07-31"]) {
      db.prepare(
        "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (3, ?, 100000, 'ibkr-activity')",
      ).run(d);
    }
    const out = queryPerformanceVsBenchmarkTool.run(db, { period: "1y" }, { accountIds: [3], today: "2026-08-05" }) as {
      window: { start: string | null; end: string };
      vs_benchmark: Vs;
    };
    expect(out.window).toMatchObject({ start: "2025-07-31", end: "2026-07-31" });
    const old = oldCurve(db, [3], "2025-07-31", "2026-07-31");
    const oldLast = old[old.length - 1];
    expect(out.vs_benchmark).toMatchObject({
      first_date: old[0].date,
      last_date: oldLast.date,
      days_plotted: old.length,
      portfolio_index_end: oldLast.portfolio,
      benchmark_index_end: oldLast.benchmark,
      portfolio_return: oldLast.portfolio / 100 - 1,
      benchmark_return: oldLast.benchmark / 100 - 1,
    });
    expect(out.vs_benchmark.first_date).toBe("2025-07-31");
  });
});
