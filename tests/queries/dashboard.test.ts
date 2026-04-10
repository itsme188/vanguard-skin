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
  twr?: number,
  source?: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots (account_id, month_end_date, total_value, twr, source)
     VALUES (?, ?, ?, ?, ?)`
  ).run(accountId, monthEnd, totalValue, twr ?? null, source ?? "manual");
}

function seedDailyValuation(
  db: Database.Database,
  accountId: number,
  date: string,
  totalValue: number
): void {
  db.prepare(
    `INSERT OR REPLACE INTO daily_valuations (account_id, valuation_date, total_value, holdings_value, cash_balance)
     VALUES (?, ?, ?, ?, 0)`
  ).run(accountId, date, totalValue, totalValue);
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

  it("excludes TWS snapshots from monthly data", () => {
    seedSnapshot(db, 1, "2025-01-31", 100000);
    seedSnapshot(db, 1, "2025-02-28", 110000);
    // TWS snapshot with today's date — should be ignored
    seedSnapshot(db, 1, "2025-03-15", 112000, undefined, "tws");

    const summaries = getAccountSummaries(db);
    const taxable = summaries.find((s) => s.id === 1)!;

    // Latest should be Feb 28 (non-TWS), not March 15 TWS
    expect(taxable.latestValue).toBe(110000);
    expect(taxable.latestDate).toBe("2025-02-28");
    expect(taxable.previousValue).toBe(100000);
  });

  it("prefers daily valuation over monthly snapshot when newer", () => {
    seedSnapshot(db, 1, "2025-02-28", 110000);
    seedDailyValuation(db, 1, "2025-03-10", 115000);

    const summaries = getAccountSummaries(db);
    const taxable = summaries.find((s) => s.id === 1)!;

    expect(taxable.latestValue).toBe(115000);
    expect(taxable.latestDate).toBe("2025-03-10");
    // Previous = most recent non-TWS monthly before March 10 = Feb 28
    expect(taxable.previousValue).toBe(110000);
    expect(taxable.monthlyChange).toBe(5000);
  });

  it("uses monthly snapshot when daily valuation is older", () => {
    seedDailyValuation(db, 1, "2025-02-15", 108000);
    seedSnapshot(db, 1, "2025-02-28", 110000);
    seedSnapshot(db, 1, "2025-01-31", 100000);

    const summaries = getAccountSummaries(db);
    const taxable = summaries.find((s) => s.id === 1)!;

    expect(taxable.latestValue).toBe(110000);
    expect(taxable.latestDate).toBe("2025-02-28");
    expect(taxable.previousValue).toBe(100000);
  });

  it("previous is rn=1 monthly when daily valuation is latest", () => {
    // Account 1 has monthly snapshots through March + daily val in April
    seedSnapshot(db, 1, "2025-02-28", 100000);
    seedSnapshot(db, 1, "2025-03-31", 110000);
    seedDailyValuation(db, 1, "2025-04-10", 115000);

    const summaries = getAccountSummaries(db);
    const taxable = summaries.find((s) => s.id === 1)!;

    // Latest = daily val (April 10)
    expect(taxable.latestValue).toBe(115000);
    // Previous should be March 31 (rn=1 monthly), NOT Feb 28 (rn=2)
    expect(taxable.previousValue).toBe(110000);
    expect(taxable.monthlyChange).toBe(5000);
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
    expect(totals.latestDate).toBeNull();
    expect(totals.oldestDate).toBeNull();
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
    expect(totals.latestDate).toBe("2025-02-28");
    expect(totals.oldestDate).toBe("2025-02-28");
  });

  it("excludes TWS snapshots from totals", () => {
    seedSnapshot(db, 1, "2025-01-31", 100000);
    seedSnapshot(db, 1, "2025-02-28", 110000);
    // TWS snapshot should be ignored
    seedSnapshot(db, 1, "2025-03-15", 115000, undefined, "tws");

    const totals = getPortfolioTotals(db);
    expect(totals.totalValue).toBe(110000); // Feb 28, not TWS
    expect(totals.totalPreviousValue).toBe(100000);
    expect(totals.snapshotCount).toBe(2); // TWS excluded from count
  });

  it("matches account card sum when daily valuations are newer", () => {
    seedSnapshot(db, 1, "2025-02-28", 100000);
    seedSnapshot(db, 2, "2025-02-28", 50000);
    seedDailyValuation(db, 1, "2025-03-10", 105000);
    // Account 2 has no daily valuations — uses monthly

    const totals = getPortfolioTotals(db);
    const summaries = getAccountSummaries(db);
    const summaryTotal = summaries.reduce(
      (sum, s) => sum + (s.latestValue ?? 0),
      0
    );

    // Portfolio total should equal sum of account card values
    expect(totals.totalValue).toBe(summaryTotal);
    expect(totals.totalValue).toBe(155000); // 105k (daily) + 50k (monthly)
  });

  it("shows date range when accounts have different freshness", () => {
    seedSnapshot(db, 1, "2025-02-28", 100000);
    seedSnapshot(db, 2, "2025-02-28", 50000);
    seedDailyValuation(db, 1, "2025-03-10", 105000);

    const totals = getPortfolioTotals(db);
    // Account 1: daily val from March 10, Account 2: monthly from Feb 28
    expect(totals.latestDate).toBe("2025-03-10");
    expect(totals.oldestDate).toBe("2025-02-28");
  });

  it("TWS snapshots don't corrupt change calculation", () => {
    // Simulate the bug: TWS shifts globalMax, making Vanguard latest=previous
    seedSnapshot(db, 1, "2025-01-31", 100000); // Vanguard
    seedSnapshot(db, 1, "2025-02-28", 110000); // Vanguard
    seedSnapshot(db, 3, "2025-01-31", 200000); // IBKR
    seedSnapshot(db, 3, "2025-02-28", 210000); // IBKR
    seedSnapshot(db, 3, "2025-03-15", 215000, undefined, "tws"); // TWS mid-month

    const totals = getPortfolioTotals(db);
    // Should use Feb 28 for both accounts (non-TWS latest)
    expect(totals.totalValue).toBe(320000); // 110k + 210k
    expect(totals.totalPreviousValue).toBe(300000); // 100k + 200k
    expect(totals.totalChange).toBe(20000);
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

  it("excludes TWS snapshots from chart data", () => {
    seedSnapshot(db, 1, "2025-01-31", 100000);
    seedSnapshot(db, 1, "2025-02-28", 110000);
    seedSnapshot(db, 1, "2025-03-15", 112000, undefined, "tws");

    const data = getPortfolioChartData(db);
    expect(data).toHaveLength(2); // Only Jan and Feb, not TWS March
    expect(data.map((d) => d.date)).toEqual(["2025-01-31", "2025-02-28"]);
  });
});
