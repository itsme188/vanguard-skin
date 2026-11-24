import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { loadPerformanceCurve } from "@/lib/compute/equity-curve";
import { computePeriodAttribution } from "@/lib/compute/period-attribution";
import { queryPerformanceVsBenchmarkTool } from "@/lib/chat/composite/performance-vs-benchmark";

// Review defect 2 (2026-11-24): the base session must be used however many
// closed days sit between it and the window's opening date. daily_valuations
// carries a row for every calendar day, so a Sunday opening reads two rows
// before it (Fri, Sat) and a Monday-holiday opening three (Fri, Sat, Sun);
// the first version accepted exactly one and fell back, losing the Friday ->
// first-session move. Closed days in between never become curve points or
// attribution pairs (the curve plots benchmark days, the walk is by session).
// Checked on the curve, the attribution and the chat tool (which reads the
// same loader). All values are synthetic.

const HOLIDAYS = new Set([
  "2021-12-24",
  "2022-01-17",
  "2022-12-26",
  "2023-01-02",
  "2023-01-16",
  "2023-12-25",
  "2024-01-01",
  "2024-01-15",
]);
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

/** Account 1 = 1,000 × the benchmark; a valuation every calendar day. */
function seed(db: Database.Database, from: string, to: string): Map<string, number> {
  const closes = new Map<string, number>();
  let close = 100;
  let k = 0;
  let last = close;
  let first = true;
  for (const date of calendarDays(from, to)) {
    if (isSession(date)) {
      if (!first) close *= 1 + CYCLE[k++ % CYCLE.length];
      first = false;
      last = close;
      closes.set(date, close);
      db.prepare("INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'test')").run(
        date,
        close,
      );
    }
    const v = 1000 * last;
    db.prepare(
      "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (1, ?, 0, ?, ?)",
    ).run(date, v, v);
  }
  return closes;
}

const CASES: Array<{ label: string; opening: string; base: string; end: string }> = [
  { label: "Sunday opening (Jan 1, 2023)", opening: "2023-01-01", base: "2022-12-30", end: "2023-02-15" },
  { label: "Monday-holiday opening (Jan 1, 2024)", opening: "2024-01-01", base: "2023-12-29", end: "2024-02-15" },
  // Worked before the fix too: one closed day in between.
  { label: "Saturday opening (Jan 1, 2022)", opening: "2022-01-01", base: "2021-12-31", end: "2022-02-15" },
];

describe("base session across closed days", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  for (const c of CASES) {
    it(`${c.label}: curve, attribution and chat start on the prior close`, () => {
      const closes = seed(db, "2021-12-15", "2024-02-20");
      const total = closes.get(c.end)! / closes.get(c.base)! - 1;

      const { data } = loadPerformanceCurve(db, [1], c.opening, c.end, "SPY");
      // Before the fix (Sunday / Monday holiday): first point on the first
      // session inside the window, at 100 / 100.
      expect(data[0]).toEqual({ date: c.base, portfolio: 100, benchmark: 100 });
      // No closed day became a point of its own.
      expect(data.every((p) => isSession(p.date))).toBe(true);
      expect(data[data.length - 1].benchmark).toBeCloseTo(100 * (1 + total), 8);
      expect(data[data.length - 1].portfolio).toBeCloseTo(100 * (1 + total), 8);

      const a = computePeriodAttribution(db, 1, c.opening, c.end, "SPY");
      expect(a.betaWindow).toEqual({ start: c.base, end: c.end });
      expect(a.decomposedReturn!.portfolioReturn).toBeCloseTo(total, 10);
      // One pair per session step, closed days never a pair of their own.
      const sessions = [...closes.keys()].filter((d) => d >= c.base && d <= c.end);
      expect(a.decomposedReturn!.observations).toBe(sessions.length - 1);

      const chat = queryPerformanceVsBenchmarkTool.run(
        db,
        { period: "ytd" },
        { accountIds: [1], today: c.end },
      ) as { vs_benchmark: { first_date: string; benchmark_index_end: number } };
      expect(chat.vs_benchmark.first_date).toBe(c.base);
      expect(chat.vs_benchmark.benchmark_index_end).toBe(data[data.length - 1].benchmark);
    });
  }
});
