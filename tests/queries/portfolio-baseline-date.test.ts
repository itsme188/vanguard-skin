import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getPortfolioTotals, getPortfolioCurrentValues } from "@/lib/queries/dashboard";

// Invented round numbers. Migration 002 seeds accounts 1, 2, 3.
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function snap(accountId: number, date: string, value: number, source = "manual"): void {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (?, ?, ?, ?)`,
  ).run(accountId, date, value, source);
}

describe("baseline statement date behind the strip's delta", () => {
  it("returns each account's previous statement date and the earliest/latest", () => {
    snap(1, "2025-07-31", 90000);
    snap(1, "2025-08-31", 100000);
    snap(2, "2025-07-29", 30000);
    snap(2, "2025-08-29", 40000);
    const v = getPortfolioCurrentValues(db);
    expect(v.accounts.map((a) => a.previousDate)).toEqual(["2025-07-31", "2025-07-29", null]);
    expect(v.previousDateEarliest).toBe("2025-07-29");
    expect(v.previousDateLatest).toBe("2025-07-31");
    const t = getPortfolioTotals(db);
    expect(t.previousDateEarliest).toBe("2025-07-29");
    expect(t.previousDateLatest).toBe("2025-07-31");
    expect(t.totalPreviousValue).toBe(120000);
  });

  it("is null when no account has a previous snapshot", () => {
    snap(1, "2025-08-31", 100000);
    const t = getPortfolioTotals(db);
    expect(t.previousDateEarliest).toBeNull();
    expect(t.previousDateLatest).toBeNull();
    expect(getPortfolioCurrentValues(db, []).previousDateEarliest).toBeNull();
  });

  it("ignores live rows as a baseline", () => {
    snap(1, "2025-07-31", 90000);
    snap(1, "2025-08-31", 100000);
    snap(1, "2025-08-15", 95000, "tws");
    expect(getPortfolioCurrentValues(db).accounts[0].previousDate).toBe("2025-07-31");
  });
});
