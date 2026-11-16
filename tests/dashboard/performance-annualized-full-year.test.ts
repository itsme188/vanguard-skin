/**
 * The Performance view shows an annualised time-weighted return for a full
 * one-year period (review 2026-11-15, W2). The old gate was "at least 365
 * days", but a single account's 1Y chain opens the day after the opening
 * month-end (stored monthly returns start on the first of the month), so a
 * full year measured 364 days and the figure was hidden. The rule is now
 * decided by the PERIOD: YTD is never annualised; 1Y / 3Y / 5Y / All are
 * when the measured span is a full year, the shortest of which is 364 days.
 *
 * No DOM harness: the threshold is read from the page source and checked
 * against a real computeTwr span over a migrated in-memory database.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTwr } from "@/lib/compute/twr";
import { resolvePerformanceWindow, latestStatementAnchor, newestStatementInScope } from "@/lib/compute/performance-window";
import { sliceBetween } from "../helpers/source-anchor";

const view = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8");

function minAnnualizedDays(): number {
  const m = view.match(/const MIN_ANNUALIZED_DAYS = (\d+);/);
  if (!m) throw new Error("MIN_ANNUALIZED_DAYS not found in PerformanceView.tsx");
  return Number(m[1]);
}

const MONTH_ENDS = [
  "2025-10-31", "2025-11-30", "2025-12-31", "2026-01-31", "2026-02-28", "2026-03-31",
  "2026-04-30", "2026-05-31", "2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30", "2026-10-31",
];

function oneYearSpan(withStoredReturns: boolean): number {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  let v = 1000;
  for (const d of MONTH_ENDS) {
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source, starting_value, deposits_withdrawals, twr)
       VALUES (1, ?, ?, 'canonical', ?, 0, ?)`,
    ).run(d, v * 1.01, v, withStoredReturns ? 0.01 : null);
    v *= 1.01;
  }
  const today = "2026-11-15";
  const w = resolvePerformanceWindow("1y", {
    today,
    lastStatementAnchor: latestStatementAnchor(db, [1], today),
    newestScopeStatement: newestStatementInScope(db, [1], today),
  });
  const r = computeTwr(db, { startDate: w.chainStartDate, endDate: w.endDate, accountId: 1 });
  if (!r) throw new Error("no TWR");
  return r.totalDays;
}

describe("Performance view: a full 1Y period shows its annualised TWR", () => {
  it("a single account's full 1Y span passes the threshold (stored monthly returns)", () => {
    expect(oneYearSpan(true)).toBeGreaterThanOrEqual(minAnnualizedDays());
  });

  it("a single account's full 1Y span passes the threshold (values only)", () => {
    expect(oneYearSpan(false)).toBeGreaterThanOrEqual(minAnnualizedDays());
  });

  it("the threshold is still about a year: a half year never passes", () => {
    expect(minAnnualizedDays()).toBeGreaterThanOrEqual(364);
    expect(minAnnualizedDays()).toBeLessThanOrEqual(365);
  });

  it("YTD is never annualised, whatever its length", () => {
    const fn = sliceBetween(view, "function shownAnnualized", "\n}\n");
    expect(fn).toContain('period === "ytd"');
    expect(view).toContain("shownAnnualized(activePeriod, annualizedTwr, twrResult?.totalDays)");
    expect(view).toContain("shownAnnualized(activePeriod, acc.annualizedReturn, acc.totalDays)");
  });
});

describe("Performance view: the Cash flows count says what it counts", () => {
  it("the cell's label or tooltip says it counts flow entries, not deposits", () => {
    const dt = view.match(/<dt[^>]*title="([^"]*)"[^>]*>\s*Cash flows\s*<\/dt>/);
    expect(dt).not.toBeNull();
    expect(dt![1]).toMatch(/flow entries/i);
    expect(dt![1]).toMatch(/not a count of individual deposits/i);
  });
});
