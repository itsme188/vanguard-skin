import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getAccountSummaries,
  getPortfolioTotals,
  getPortfolioChartData,
} from "@/lib/queries/dashboard";

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEnd: string,
  totalValue: number,
  twr?: number
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots (account_id, month_end_date, total_value, twr)
     VALUES (?, ?, ?, ?)`
  ).run(accountId, monthEnd, totalValue, twr ?? null);
}

describe("getAccountSummaries", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns all accounts with null values when no snapshots exist", () => {
    const summaries = getAccountSummaries(db);
    expect(summaries).toHaveLength(3);
    expect(summaries[0].name).toBe("Vanguard Taxable");
    expect(summaries[0].latestValue).toBeNull();
    expect(summaries[0].previousValue).toBeNull();
    expect(summaries[0].monthlyChange).toBeNull();
  });

  it("returns latest and previous values from snapshots", () => {
    seedSnapshot(db, 1, "2025-01-31", 100000, 0.05);
    seedSnapshot(db, 1, "2025-02-28", 110000, 0.08);

    const summaries = getAccountSummaries(db);
    const taxable = summaries.find((s) => s.id === 1)!;

    expect(taxable.latestValue).toBe(110000);
    expect(taxable.previousValue).toBe(100000);
    expect(taxable.latestDate).toBe("2025-02-28");
    expect(taxable.monthlyChange).toBe(10000);
    expect(taxable.monthlyChangePercent).toBe(10);
    expect(taxable.twr).toBe(0.08);
  });

  it("handles accounts with only one snapshot", () => {
    seedSnapshot(db, 1, "2025-01-31", 100000);

    const summaries = getAccountSummaries(db);
    const taxable = summaries.find((s) => s.id === 1)!;

    expect(taxable.latestValue).toBe(100000);
    expect(taxable.previousValue).toBeNull();
    expect(taxable.monthlyChange).toBeNull();
  });

  it("handles multiple accounts independently", () => {
    seedSnapshot(db, 1, "2025-01-31", 100000);
    seedSnapshot(db, 2, "2025-01-31", 50000);
    seedSnapshot(db, 1, "2025-02-28", 110000);
    seedSnapshot(db, 2, "2025-02-28", 55000);

    const summaries = getAccountSummaries(db);
    const taxable = summaries.find((s) => s.id === 1)!;
    const roth = summaries.find((s) => s.id === 2)!;

    expect(taxable.latestValue).toBe(110000);
    expect(taxable.monthlyChange).toBe(10000);
    expect(roth.latestValue).toBe(55000);
    expect(roth.monthlyChange).toBe(5000);
  });
});

describe("getPortfolioTotals", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns zeros when no data exists", () => {
    const totals = getPortfolioTotals(db);
    expect(totals.totalValue).toBe(0);
    expect(totals.totalPreviousValue).toBe(0);
    expect(totals.totalChange).toBe(0);
    expect(totals.accountCount).toBe(3);
    expect(totals.snapshotCount).toBe(0);
  });

  it("computes totals across accounts", () => {
    seedSnapshot(db, 1, "2025-01-31", 100000);
    seedSnapshot(db, 2, "2025-01-31", 50000);
    seedSnapshot(db, 1, "2025-02-28", 110000);
    seedSnapshot(db, 2, "2025-02-28", 55000);

    const totals = getPortfolioTotals(db);
    expect(totals.totalValue).toBe(165000); // 110k + 55k
    expect(totals.totalPreviousValue).toBe(150000); // 100k + 50k
    expect(totals.totalChange).toBe(15000);
    expect(totals.totalChangePercent).toBe(10);
    expect(totals.snapshotCount).toBe(4);
  });
});

describe("getPortfolioChartData", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns empty array when no snapshots exist", () => {
    const data = getPortfolioChartData(db);
    expect(data).toHaveLength(0);
  });

  it("returns time-series grouped by date with account columns", () => {
    seedSnapshot(db, 1, "2025-01-31", 100000);
    seedSnapshot(db, 2, "2025-01-31", 50000);
    seedSnapshot(db, 1, "2025-02-28", 110000);
    seedSnapshot(db, 2, "2025-02-28", 55000);

    const data = getPortfolioChartData(db);
    expect(data).toHaveLength(2);
    expect(data[0].date).toBe("2025-01-31");
    expect(data[0]["Vanguard Taxable"]).toBe(100000);
    expect(data[0]["Vanguard Roth IRA"]).toBe(50000);
    expect(data[1].date).toBe("2025-02-28");
    expect(data[1]["Vanguard Taxable"]).toBe(110000);
  });
});
