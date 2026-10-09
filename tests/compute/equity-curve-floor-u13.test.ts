/**
 * U13 — the Performance equity curve starts at the first statement anchor.
 *
 * Ruling 2026-09-02: daily values dated before an account's first statement
 * are estimates (the engine has no statement to tie them to), so the day
 * before the first statement made a fake step on the curve's base day. The
 * curve is floored at the first statement: no estimated pre-anchor base day.
 *
 * Every figure is invented.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { buildEquityCurveData } from "@/lib/compute/equity-curve";
import { curveFloorDate, firstStatementAnchorForCurve } from "@/lib/compute/equity-curve-floor";
import { getDailyValuationsForAccounts } from "@/lib/queries/daily-valuations";

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEndDate: string,
  totalValue: number,
  source = "canonical",
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, ?, ?)`,
  ).run(accountId, monthEndDate, totalValue, source);
}

function seedDaily(db: Database.Database, accountId: number, date: string, value: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO daily_valuations
       (account_id, valuation_date, cash_balance, holdings_value, total_value)
     VALUES (?, ?, 0, ?, ?)`,
  ).run(accountId, date, value, value);
}

const WINDOW = { startDate: "2000-01-01", endDate: "2025-12-31" };

describe("buildEquityCurveData — floor at the first statement anchor", () => {
  const bench = [
    { date: "2025-03-27", close_price: 100 },
    { date: "2025-03-28", close_price: 100 },
    { date: "2025-03-31", close_price: 100 },
    { date: "2025-04-01", close_price: 101 },
    { date: "2025-04-02", close_price: 102 },
  ];
  // Two estimated days before the first statement (holdings only, no cash:
  // 60,000), then the statement day at its true 100,000.
  const vals = [
    { valuation_date: "2025-03-27", total_value: 60000 },
    { valuation_date: "2025-03-28", total_value: 60000 },
    { valuation_date: "2025-03-31", total_value: 100000 },
    { valuation_date: "2025-04-01", total_value: 101000 },
    { valuation_date: "2025-04-02", total_value: 103000 },
  ];

  it("without a floor the estimated days put a fake step on the curve", () => {
    const curve = buildEquityCurveData(vals, bench);
    expect(curve[0].date).toBe("2025-03-27");
    // 60,000 to 100,000 with no flow reads as +66.7%.
    expect(curve[2].portfolio).toBeCloseTo(166.6667, 3);
  });

  it("with the floor the curve opens at 100 on the statement day", () => {
    const curve = buildEquityCurveData(vals, bench, [], [], "2025-03-31");
    expect(curve.map((p) => p.date)).toEqual(["2025-03-31", "2025-04-01", "2025-04-02"]);
    expect(curve[0]).toEqual({ date: "2025-03-31", portfolio: 100, benchmark: 100 });
    expect(curve[1].portfolio).toBeCloseTo(101, 6);
    expect(curve[2].portfolio).toBeCloseTo(103, 6);
    expect(curve[2].benchmark).toBeCloseTo(102, 6);
  });

  it("a flow on or before the floor day is inside the opening value, not a return", () => {
    const flows = [
      { date: "2025-03-28", net: 40000 },
      { date: "2025-03-31", net: 5000 },
      { date: "2025-04-01", net: 1000 },
    ];
    const curve = buildEquityCurveData(vals, bench, flows, [], "2025-03-31");
    expect(curve[0].portfolio).toBe(100);
    // Only the Apr 1 deposit is netted: (101,000 - 1,000) / 100,000 = flat.
    expect(curve[1].portfolio).toBeCloseTo(100, 6);
  });

  it("no floor (null or undefined) leaves the curve as it was", () => {
    expect(buildEquityCurveData(vals, bench, [], [], null)).toEqual(buildEquityCurveData(vals, bench));
  });

  it("a floor after the last daily value plots nothing", () => {
    expect(buildEquityCurveData(vals, bench, [], [], "2025-05-31")).toEqual([]);
  });
});

describe("firstStatementAnchorForCurve — the floor for a scope", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("one account: its first statement, never an earlier live snapshot", () => {
    seedSnapshot(db, 1, "2025-03-20", 99000, "plaid");
    seedSnapshot(db, 1, "2025-03-31", 100000);
    seedSnapshot(db, 1, "2025-04-30", 104000);
    seedDaily(db, 1, "2025-03-28", 60000);
    seedDaily(db, 1, "2025-03-31", 100000);
    expect(firstStatementAnchorForCurve(db, [1], WINDOW.startDate, WINDOW.endDate)).toBe("2025-03-31");
  });

  it("several accounts: the latest of their first statements", () => {
    // Before the later account's first statement its daily values are
    // estimates, so the summed series is not statement-tied until then.
    seedSnapshot(db, 1, "2025-03-31", 100000);
    seedSnapshot(db, 2, "2025-04-30", 50000);
    for (const id of [1, 2]) {
      seedDaily(db, id, "2025-04-29", 40000);
      seedDaily(db, id, "2025-04-30", 50000);
    }
    expect(firstStatementAnchorForCurve(db, [1, 2], WINDOW.startDate, WINDOW.endDate)).toBe("2025-04-30");
    // The whole portfolio (no scope) follows the same rule.
    expect(firstStatementAnchorForCurve(db, undefined, WINDOW.startDate, WINDOW.endDate)).toBe("2025-04-30");
    // Each account alone keeps its own first statement.
    expect(firstStatementAnchorForCurve(db, [1], WINDOW.startDate, WINDOW.endDate)).toBe("2025-03-31");
  });

  it("an account with no daily value in the window does not move the floor", () => {
    seedSnapshot(db, 1, "2025-03-31", 100000);
    seedDaily(db, 1, "2025-03-31", 100000);
    seedSnapshot(db, 3, "2025-09-30", 70000); // statements only, no daily rows
    expect(firstStatementAnchorForCurve(db, undefined, WINDOW.startDate, WINDOW.endDate)).toBe("2025-03-31");
  });

  it("no statement at all: no floor (a live-only account still plots)", () => {
    seedSnapshot(db, 1, "2025-03-20", 99000, "tws");
    seedDaily(db, 1, "2025-03-20", 99000);
    expect(firstStatementAnchorForCurve(db, [1], WINDOW.startDate, WINDOW.endDate)).toBeNull();
    expect(firstStatementAnchorForCurve(db, [], WINDOW.startDate, WINDOW.endDate)).toBeNull();
  });

  it("curveFloorDate: the later of the window start and the first statement", () => {
    expect(curveFloorDate("2025-01-01", "2025-03-31")).toBe("2025-03-31");
    expect(curveFloorDate("2025-06-30", "2025-03-31")).toBe("2025-06-30");
    expect(curveFloorDate("2025-06-30", null)).toBe("2025-06-30");
  });

  it("end to end for a two-account scope: summed, full coverage, opening on the floor", () => {
    seedSnapshot(db, 1, "2025-03-31", 100000);
    seedSnapshot(db, 2, "2025-03-31", 50000);
    // Estimated days before the statements, then two statement-tied days.
    for (const [d, a, b] of [
      ["2025-03-27", 60000, 30000],
      ["2025-03-28", 60000, 30000],
      ["2025-03-31", 100000, 50000],
      ["2025-04-01", 102000, 51000],
    ] as const) {
      seedDaily(db, 1, d, a);
      seedDaily(db, 2, d, b);
    }
    seedDaily(db, 1, "2025-04-02", 103000); // only one account: not full coverage
    seedDaily(db, 3, "2025-04-01", 999000); // outside the scope

    const floor = firstStatementAnchorForCurve(db, [1, 2], WINDOW.startDate, WINDOW.endDate);
    const start = curveFloorDate(WINDOW.startDate, floor);
    const vals = getDailyValuationsForAccounts(db, [1, 2], {
      startDate: start,
      endDate: WINDOW.endDate,
      fullCoverageOnly: true,
    });
    const bench = [
      { date: "2025-03-28", close_price: 50 },
      { date: "2025-03-31", close_price: 100 },
      { date: "2025-04-01", close_price: 101 },
    ];
    const curve = buildEquityCurveData(vals, bench, [], [], floor);
    expect(curve).toEqual([
      { date: "2025-03-31", portfolio: 100, benchmark: 100 },
      { date: "2025-04-01", portfolio: expect.closeTo(102, 6), benchmark: expect.closeTo(101, 6) },
    ]);
  });
});

describe("PerformanceView draws the curve for the whole scope, from the floor", () => {
  const flat = readFileSync("app/dashboard/components/PerformanceView.tsx", "utf8").replace(/\s+/g, " ");

  it("looks the floor up over the full scope and starts the daily series there", () => {
    expect(flat).toContain(
      "firstStatementAnchorForCurve(db, scopeAccountIds, effectiveStart, dailyEnd)",
    );
    expect(flat).toContain("const curveSeriesStart = curveFloorDate(effectiveStart, curveFloor);");
    expect(flat).toContain(
      "getDailyValuationsForAccounts(db, scopeAccountIds, { startDate: curveSeriesStart, endDate: dailyEnd, fullCoverageOnly: true, })",
    );
    // Scope rule (2026-10-09): the scope is passed straight through, with
    // undefined = every account. It is never coerced to an empty list, which
    // now means NO accounts.
    expect(flat).not.toContain("scopeAccountIds ?? []");
    // The single-account series (a first-id collapse for a wider scope) is gone.
    expect(flat).not.toContain("getDailyValuationsByAccount");
  });

  it("nets the scope's own flows and seams, and hands the builder the floor", () => {
    expect(flat).toContain("fetchNetFlowsByDate( db, scopeAccountIds,");
    expect(flat).toContain("fetchAnchorSourceSeamDates( db, scopeAccountIds,");
    expect(flat).toContain("buildEquityCurveData( dailyVals, benchmarkRows, flows, seamDates, curveFloor, )");
  });
});
