/**
 * The year-to-date money-weighted return (XIRR) read about +450% every
 * January.
 *
 * Cause: the YTD window starts on Jan 1 with no end date, so the engine's end
 * falls back to the latest statement month-end, Dec 31 of the year before.
 * That is on or before the opening value's date (also Dec 31), so the cash
 * flows were -V and +V on the same day. NPV is zero at every rate, Newton
 * never moves, and the bisection fallback returned the midpoint of its
 * bracket, (-0.99 + 10) / 2 = 4.505.
 *
 * A window whose terminal date is on or before its opening date has no
 * money-weighted return: the engine returns null (no figure), as computeTwr
 * already does. Every figure below is invented.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeXirr, solveXirr, bisectionFallback } from "@/lib/compute/xirr";
import { computeTwr } from "@/lib/compute/twr";
import { resolvePerformanceWindow } from "@/lib/compute/performance-window";

const A = 1;
const B = 2;
const TODAY = "2027-01-20";

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEndDate: string,
  totalValue: number,
  deposits: number | null = null,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots
       (account_id, month_end_date, total_value, source, deposits_withdrawals)
     VALUES (?, ?, ?, 'canonical', ?)`,
  ).run(accountId, monthEndDate, totalValue, deposits);
}

describe("computeXirr — a YTD window in January has no figure yet", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedSnapshot(db, A, "2026-11-30", 100000);
    seedSnapshot(db, A, "2026-12-31", 110000);
    seedSnapshot(db, B, "2026-11-30", 50000);
    seedSnapshot(db, B, "2026-12-31", 52000);
  });

  // Exactly as the Performance view and the chat tool build the call.
  const ytd = resolvePerformanceWindow("ytd", { today: TODAY, lastStatementAnchor: "2026-12-31" });
  const startDate = ytd.chainStartDate;
  const endDate = ytd.endsAtStatement ? ytd.endDate : undefined;

  it("the window is Jan 1 with no end date (the shape that triggers the bug)", () => {
    expect(startDate).toBe("2027-01-01");
    expect(endDate).toBeUndefined();
  });

  it("whole book: null, not 4.505, and agrees with computeTwr", () => {
    expect(computeTwr(db, { startDate, endDate })).toBeNull();
    expect(computeXirr(db, { startDate, endDate })).toBeNull();
  });

  it("a two-account scope: null", () => {
    expect(computeXirr(db, { startDate, endDate, accountIds: [A, B] })).toBeNull();
  });

  it("a single account: null", () => {
    expect(computeXirr(db, { startDate, endDate, accountIds: [A] })).toBeNull();
    expect(computeXirr(db, { startDate, endDate, accountId: B })).toBeNull();
  });

  it("the prior month still has a figure (the guard is not too wide)", () => {
    // December: opens 150,000 on Nov 30, closes 162,000 on Dec 31, no flows.
    const dec = computeXirr(db, { startDate: "2026-12-01", endDate: "2026-12-31" });
    expect(dec).not.toBeNull();
    const years = 31 / 365.25;
    expect(dec!.xirr).toBeCloseTo(Math.pow(162000 / 150000, 1 / years) - 1, 6);
  });
});

describe("computeXirr — an unsolvable whole-book headline is null, never 0 or 4.505", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("aggregate opening and terminal on the same statement date: headline null, account row kept", () => {
    // Statements Jan 31 and Mar 31; a mid-February to mid-March window. The
    // account reads daily values, but the whole-book path anchors both its
    // opening and its terminal on the Jan 31 statement (same date).
    seedSnapshot(db, A, "2025-01-31", 100000);
    seedSnapshot(db, A, "2025-03-31", 108000);
    db.prepare(
      `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
       VALUES (?, ?, 0, ?, ?)`,
    ).run(A, "2025-02-14", 103000, 103000);
    db.prepare(
      `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
       VALUES (?, ?, 0, ?, ?)`,
    ).run(A, "2025-03-14", 106000, 106000);

    const r = computeXirr(db, { startDate: "2025-02-15", endDate: "2025-03-14" });
    expect(r).not.toBeNull();
    expect(r!.xirr).toBeNull(); // was 4.505
    expect(r!.perAccount).toHaveLength(1);
    expect(r!.perAccount[0].xirr).toBeGreaterThan(0);
  });

  it("no solvable aggregate flows: headline null, was 0", () => {
    // A zero opening statement and ledger-only deposits: the account solves
    // from its ledger flows; the whole-book path sees only the terminal value.
    seedSnapshot(db, A, "2024-12-31", 0);
    for (const [date, amount] of [["2025-01-01", 10000], ["2025-07-01", 5000]] as const) {
      db.prepare(
        `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
         VALUES (?, ?, 'DEPOSIT', ?, 1, ?)`,
      ).run(A, date, amount, `syn-${date}`);
    }
    seedSnapshot(db, A, "2025-12-31", 16500);

    const r = computeXirr(db, { startDate: "2025-01-01", endDate: "2025-12-31" });
    expect(r).not.toBeNull();
    expect(r!.xirr).toBeNull();
    expect(r!.perAccount[0].xirr).toBeGreaterThan(0);
  });
});

describe("solveXirr / bisectionFallback — no root means no figure", () => {
  it("same-date -V and +V: null, not the bracket midpoint", () => {
    const flows = [
      { date: "2026-12-31", amount: -100000 },
      { date: "2026-12-31", amount: 100000 },
    ];
    expect(solveXirr(flows)).toBeNull();
    expect(bisectionFallback(flows, "2026-12-31")).toBeNull();
  });

  it("flows that net to zero on every date: null", () => {
    const flows = [
      { date: "2026-06-30", amount: -1000 },
      { date: "2026-06-30", amount: 1000 },
      { date: "2026-12-31", amount: -500 },
      { date: "2026-12-31", amount: 500 },
    ];
    expect(solveXirr(flows)).toBeNull();
  });

  it("a normal flow set still returns its known rate", () => {
    // 100,000 in, 110,000 out exactly one engine year (365.25 days) later
    // would be 10%; use a whole-day span and annualize the same way.
    const flows = [
      { date: "2025-01-01", amount: -100000 },
      { date: "2026-01-01", amount: 110000 },
    ];
    const years = 365 / 365.25;
    const expected = Math.pow(1.1, 1 / years) - 1;
    expect(solveXirr(flows)).toBeCloseTo(expected, 6);
    expect(bisectionFallback(flows, "2025-01-01")).toBeCloseTo(expected, 5);
  });
});
