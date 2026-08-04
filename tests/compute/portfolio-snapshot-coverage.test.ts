import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTwr } from "@/lib/compute/twr";
import { computeXirr } from "@/lib/compute/xirr";

// Portfolio-wide TWR/XIRR aggregate monthly_snapshots across accounts per
// month. A month where one account's statement hasn't been imported yet
// (statement lag — e.g. IBKR's July statement landing before Vanguard's)
// must NOT enter the summed series: the missing account's whole value would
// read as a catastrophic fake return while every per-account number stays
// healthy. Monthly-snapshot sibling of the daily fullCoverageOnly guard
// (qa:analysis-performance--scope-all-twr-negative-transfer-flows-double-counted).

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEndDate: string,
  totalValue: number
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots
       (account_id, month_end_date, total_value, source)
     VALUES (?, ?, ?, 'manual')`
  ).run(accountId, monthEndDate, totalValue);
}

describe("portfolio aggregation skips partially-covered months", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    // Account 1: full history. Account 2: statement lag — no March row.
    seedSnapshot(db, 1, "2025-12-31", 95000);
    seedSnapshot(db, 2, "2025-12-31", 45000);
    seedSnapshot(db, 1, "2026-01-31", 100000);
    seedSnapshot(db, 2, "2026-01-31", 50000);
    seedSnapshot(db, 1, "2026-02-28", 110000);
    seedSnapshot(db, 2, "2026-02-28", 55000);
    seedSnapshot(db, 1, "2026-03-31", 121000);
  });

  it("TWR ignores the lag month instead of reading the missing account as a loss", () => {
    const result = computeTwr(db);
    expect(result).not.toBeNull();
    // Covered series: 140k -> 150k -> 165k = +17.86%. The buggy series
    // appends March's 121k (account 2 missing) for a fake -26.7% month.
    expect(result!.totalReturn).toBeGreaterThan(0);
    expect(result!.totalReturn).toBeCloseTo(165000 / 140000 - 1, 3);
  });

  it("XIRR terminal value comes from the latest fully-covered month", () => {
    const result = computeXirr(db, {
      startDate: "2026-01-15",
      endDate: "2026-03-31",
    });
    expect(result).not.toBeNull();
    // Liquidation value must be Feb's 165k (both accounts), never March's
    // account-1-only 121k, which reads as an -88%-style loss vs the 140k start.
    expect(result!.currentValue).toBeCloseTo(165000, 0);
    expect(result!.xirr).toBeGreaterThan(0);
  });

  it("a late-starting account does not poison earlier full-coverage months", () => {
    // Account 3 is born in Feb — Dec/Jan (2-account months) stay covered.
    seedSnapshot(db, 3, "2026-02-28", 30000);
    seedSnapshot(db, 3, "2026-03-31", 31000);
    const result = computeTwr(db);
    expect(result).not.toBeNull();
    // March still skipped (account 2 lagging); Dec->Jan->Feb chain survives.
    // Feb month return includes account 3's appearance-as-flowless-value —
    // that boundary is governed by deposits_withdrawals, not this guard; the
    // assertion here is only that earlier months aren't dropped and the
    // result isn't the catastrophic negative.
    expect(result!.totalReturn).toBeGreaterThan(0);
  });
});
