import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { buildEquityCurveData, loadPerformanceCurve } from "@/lib/compute/equity-curve";
import { curveFloorDate, firstStatementAnchorForCurve } from "@/lib/compute/equity-curve-floor";
import { getDailyValuationsForAccounts } from "@/lib/queries/daily-valuations";
import { fetchAnchorSourceSeamDates, fetchNetFlowsByDate } from "@/lib/compute/flow-adjusted";
import { baseSessionOnOrBefore } from "@/lib/compute/performance-window";

// FIX 14: the Performance curve starts on the BASE SESSION (the last
// benchmark close on or before the window's opening date). A YTD window opens
// on Jan 1, a closed day; the curve used to open on Jan 2 at 100 / 100 and so
// lost the Jan 2 session's move, while the TWR tile (opening on the Dec 31
// statement) kept it. All values are synthetic.

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

/** Dec 31 close 100, a +5% Jan 2 session, Feb 13 close 112.11; the book is
 *  the benchmark times `scale`, with a valuation row every calendar day. */
function seed(
  db: Database.Database,
  opts: { accountId?: number; scale?: number; withBenchmark?: boolean; skip?: Set<string>; from?: string } = {},
): void {
  let close = 100;
  let k = 0;
  let last = close;
  const fixed: Record<string, number> = { "2025-12-31": 100, "2026-01-02": 105, "2026-02-13": 112.11 };
  for (const date of calendarDays(opts.from ?? "2025-12-31", "2026-02-13")) {
    if (isSession(date)) {
      if (date !== "2025-12-31") close = close * (1 + CYCLE[k++ % CYCLE.length]);
      if (fixed[date] !== undefined) close = fixed[date];
      last = close;
      if (opts.withBenchmark ?? true) {
        db.prepare(
          `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'tws')`,
        ).run(date, close);
      }
    }
    if (opts.skip?.has(date)) continue;
    const v = (opts.scale ?? 1000) * last;
    db.prepare(
      `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
       VALUES (?, ?, 0, ?, ?)`,
    ).run(opts.accountId ?? 1, date, v, v);
  }
}

/** The curve exactly as PerformanceView built it before the fix. */
function oldCurve(db: Database.Database, ids: number[] | undefined, start: string, end: string) {
  const curveFloor = firstStatementAnchorForCurve(db, ids, start, end);
  const seriesStart = curveFloorDate(start, curveFloor);
  const dailyVals = getDailyValuationsForAccounts(db, ids, { startDate: seriesStart, endDate: end, fullCoverageOnly: true });
  const bench = db
    .prepare(`SELECT date, close_price FROM benchmark_prices WHERE symbol = 'SPY' AND date BETWEEN ? AND ? ORDER BY date`)
    .all(start, end) as { date: string; close_price: number }[];
  const from = dailyVals[0]?.valuation_date;
  const to = dailyVals[dailyVals.length - 1]?.valuation_date;
  const flows = dailyVals.length >= 2 ? fetchNetFlowsByDate(db, ids, from, to) : [];
  const seams = dailyVals.length >= 2 ? fetchAnchorSourceSeamDates(db, ids, from, to) : [];
  return buildEquityCurveData(dailyVals, bench, flows, seams, curveFloor);
}

describe("Performance curve: base session", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("the base session is the last close on or before the opening date", () => {
    seed(db);
    expect(baseSessionOnOrBefore(db, "SPY", "2026-01-01")).toBe("2025-12-31");
    expect(baseSessionOnOrBefore(db, "SPY", "2026-01-02")).toBe("2026-01-02");
    // No close within a week before: the opening date itself.
    expect(baseSessionOnOrBefore(db, "SPY", "2025-12-01")).toBe("2025-12-01");
  });

  it("YTD from Jan 1 plots from the Dec 31 close and keeps the Jan 2 session", () => {
    seed(db);
    const { data } = loadPerformanceCurve(db, [1], "2026-01-01", "2026-02-13", "SPY");
    // Before the fix: first point Jan 2 at 100 / 100, last 106.77 on both.
    expect(oldCurve(db, [1], "2026-01-01", "2026-02-13")[0].date).toBe("2026-01-02");
    expect(data[0]).toEqual({ date: "2025-12-31", portfolio: 100, benchmark: 100 });
    const last = data[data.length - 1];
    expect(last.date).toBe("2026-02-13");
    expect(last.portfolio).toBeCloseTo(112.11, 8);
    expect(last.benchmark).toBeCloseTo(112.11, 8);
  });

  it("a window opening on a trading day is unchanged (old = new)", () => {
    seed(db);
    db.prepare(
      `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
       VALUES (1, '2026-01-21', 'DEPOSIT', 4000, 1, 'curve-pin-flow')`,
    ).run();
    db.prepare(`UPDATE daily_valuations SET total_value = total_value + 4000 WHERE valuation_date >= '2026-01-21'`).run();
    const { data } = loadPerformanceCurve(db, [1], "2026-01-02", "2026-02-13", "SPY");
    expect(data.length).toBeGreaterThan(20);
    expect(data).toEqual(oldCurve(db, [1], "2026-01-02", "2026-02-13"));
    expect(data[0].date).toBe("2026-01-02");
  });

  it("the first-statement floor still wins when it is later than the base session", () => {
    seed(db);
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (1, '2026-01-15', 100000, 'vanguard-pdf')`,
    ).run();
    const { data, curveFloor } = loadPerformanceCurve(db, [1], "2026-01-01", "2026-02-13", "SPY");
    expect(curveFloor).toBe("2026-01-15");
    expect(data[0].date).toBe("2026-01-15");
    expect(data).toEqual(oldCurve(db, [1], "2026-01-01", "2026-02-13"));
  });

  it("a floor ON the base session lets the curve start there", () => {
    seed(db);
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (1, '2025-12-31', 100000, 'vanguard-pdf')`,
    ).run();
    const { data } = loadPerformanceCurve(db, [1], "2026-01-01", "2026-02-13", "SPY");
    expect(data[0]).toEqual({ date: "2025-12-31", portfolio: 100, benchmark: 100 });
  });

  it("fullCoverageOnly: a scope with no full-coverage value on the base day opens inside the window, as before", () => {
    seed(db);
    seed(db, { accountId: 2, scale: 500, withBenchmark: false, skip: new Set(["2025-12-31"]) });
    const { data } = loadPerformanceCurve(db, [1, 2], "2026-01-01", "2026-02-13", "SPY");
    expect(data[0].date).toBe("2026-01-02");
    expect(data).toEqual(oldCurve(db, [1, 2], "2026-01-01", "2026-02-13"));
  });

  it("fullCoverageOnly: a base day that would change which window days survive is not used", () => {
    // Account 2 has a value only on Dec 31. Reading from Dec 31 would make
    // two accounts the full-coverage count and drop every window day.
    seed(db);
    db.prepare(
      `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
       VALUES (2, '2025-12-31', 0, 50000, 50000)`,
    ).run();
    const { data } = loadPerformanceCurve(db, [1, 2], "2026-01-01", "2026-02-13", "SPY");
    expect(data[0].date).toBe("2026-01-02");
    expect(data).toEqual(oldCurve(db, [1, 2], "2026-01-01", "2026-02-13"));
  });
});
