import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeXirr } from "@/lib/compute/xirr";

// ─── Seed helpers ───────────────────────────────────────────────────

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEndDate: string,
  totalValue: number,
  opts: {
    source?: string;
    depositsWithdrawals?: number;
    startingValue?: number;
  } = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots
       (account_id, month_end_date, total_value, source, deposits_withdrawals, starting_value)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    accountId,
    monthEndDate,
    totalValue,
    opts.source ?? "manual",
    opts.depositsWithdrawals ?? null,
    opts.startingValue ?? null
  );
}

function seedExternalFlow(
  db: Database.Database,
  accountId: number,
  date: string,
  amount: number
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, 1, ?)`
  ).run(
    accountId,
    date,
    amount > 0 ? "DEPOSIT" : "WITHDRAWAL",
    amount,
    `flow-${accountId}-${date}-${Math.random()}`
  );
}

function seedDailyValuation(
  db: Database.Database,
  accountId: number,
  date: string,
  totalValue: number
): void {
  db.prepare(
    `INSERT OR REPLACE INTO daily_valuations
       (account_id, valuation_date, cash_balance, holdings_value, total_value)
     VALUES (?, ?, 0, ?, ?)`
  ).run(accountId, date, totalValue, totalValue);
}

describe("XIRR computation", () => {
  let db: Database.Database;
  const ACCT_1 = 1; // Vanguard Taxable (seeded by migration)

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns null when no snapshots exist", () => {
    const result = computeXirr(db);
    expect(result).toBeNull();
  });

  it("computes XIRR for a single lump-sum investment", () => {
    // Invest $100,000 on Jan 31, worth $110,000 on Dec 31 (~10% annual return)
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-12-31", 110000);

    // Deposit of $100k at start
    seedExternalFlow(db, ACCT_1, "2025-01-15", 100000);

    const result = computeXirr(db, {
      startDate: "2025-02-01",
      endDate: "2025-12-31",
    });

    expect(result).not.toBeNull();
    expect(result!.perAccount).toHaveLength(1);

    const acct = result!.perAccount[0];
    // ~10% return on a ~11 month period, annualized should be slightly higher
    expect(acct.xirr).toBeGreaterThan(0.05);
    expect(acct.xirr).toBeLessThan(0.20);
    expect(acct.currentValue).toBe(110000);
  });

  it("computes XIRR with periodic contributions", () => {
    // Monthly deposits of $1,000 for 12 months
    // Starting value: $10,000
    seedSnapshot(db, ACCT_1, "2024-12-31", 10000);

    // Deposit $1k each month
    for (let m = 1; m <= 12; m++) {
      const month = String(m).padStart(2, "0");
      seedExternalFlow(db, ACCT_1, `2025-${month}-15`, 1000);
    }

    // After 12 months of $1k deposits ($12k total) + growth
    // Total invested: $10k initial + $12k = $22k
    // Value: $24,000 (modest growth)
    seedSnapshot(db, ACCT_1, "2025-12-31", 24000);

    const result = computeXirr(db, {
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });

    expect(result).not.toBeNull();
    // Should produce a positive XIRR since value > cost
    expect(result!.xirr).toBeGreaterThan(0);
  });

  it("computes negative XIRR for losing investment", () => {
    // Invest $100k, lose 20% over the year
    seedSnapshot(db, ACCT_1, "2024-12-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-12-31", 80000);

    const result = computeXirr(db, {
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });

    expect(result).not.toBeNull();
    expect(result!.xirr).toBeLessThan(0); // negative return
    expect(result!.xirr).toBeGreaterThan(-0.30); // not unreasonable
  });

  it("handles withdrawals correctly", () => {
    // Start with $200k, withdraw $50k, end with $160k
    seedSnapshot(db, ACCT_1, "2024-12-31", 200000);
    seedExternalFlow(db, ACCT_1, "2025-06-15", -50000); // withdrawal
    seedSnapshot(db, ACCT_1, "2025-12-31", 160000);

    const result = computeXirr(db, {
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });

    expect(result).not.toBeNull();
    // $200k - $50k withdrawal = $150k base, ended at $160k = positive return
    expect(result!.perAccount[0].xirr).toBeGreaterThan(0);
    expect(result!.perAccount[0].totalWithdrawn).toBe(50000);
  });

  it("computes portfolio-wide XIRR across multiple accounts", () => {
    const ACCT_2 = 2; // second account

    // Account 1: steady growth
    seedSnapshot(db, ACCT_1, "2024-12-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-12-31", 115000);

    // Account 2: modest growth
    seedSnapshot(db, ACCT_2, "2024-12-31", 50000);
    seedSnapshot(db, ACCT_2, "2025-12-31", 52000);

    const result = computeXirr(db, {
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });

    expect(result).not.toBeNull();
    expect(result!.perAccount).toHaveLength(2);
    expect(result!.currentValue).toBe(167000); // 115k + 52k
    expect(result!.xirr).toBeGreaterThan(0);
  });

  it("filters by account when accountId provided", () => {
    const ACCT_2 = 2;

    seedSnapshot(db, ACCT_1, "2024-12-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-12-31", 110000);
    seedSnapshot(db, ACCT_2, "2024-12-31", 50000);
    seedSnapshot(db, ACCT_2, "2025-12-31", 55000);

    const result = computeXirr(db, {
      startDate: "2025-01-01",
      endDate: "2025-12-31",
      accountId: ACCT_1,
    });

    expect(result).not.toBeNull();
    expect(result!.perAccount).toHaveLength(1);
    expect(result!.perAccount[0].accountId).toBe(ACCT_1);
  });

  it("filters by date range", () => {
    seedSnapshot(db, ACCT_1, "2024-12-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-06-30", 105000);
    seedSnapshot(db, ACCT_1, "2025-12-31", 112000);

    // Only compute for H2
    const result = computeXirr(db, {
      startDate: "2025-07-01",
      endDate: "2025-12-31",
    });

    expect(result).not.toBeNull();
    // H2 return: $105k → $112k ≈ 6.7%
    expect(result!.perAccount[0].xirr).toBeGreaterThan(0);
  });

  it("falls back to daily_valuations for custom date ranges between snapshots", () => {
    // Monthly snapshots only at month boundaries
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-03-31", 108000);

    // Daily valuations fill the gaps
    seedDailyValuation(db, ACCT_1, "2025-02-14", 103000);
    seedDailyValuation(db, ACCT_1, "2025-02-28", 105000);
    seedDailyValuation(db, ACCT_1, "2025-03-14", 106500);

    // Custom range: Feb 15 - Mar 14 (between monthly snapshots)
    const result = computeXirr(db, {
      startDate: "2025-02-15",
      endDate: "2025-03-14",
    });

    expect(result).not.toBeNull();
    // Start value from daily: $103k (Feb 14), end value from daily: $106.5k (Mar 14)
    expect(result!.perAccount).toHaveLength(1);
    expect(result!.perAccount[0].currentValue).toBe(106500);
    expect(result!.perAccount[0].xirr).toBeGreaterThan(0);
  });

  it("prefers monthly snapshots over daily valuations when both exist", () => {
    // Monthly snapshot available
    seedSnapshot(db, ACCT_1, "2024-12-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-12-31", 110000);

    // Daily valuation also exists with different value
    seedDailyValuation(db, ACCT_1, "2024-12-30", 99000);
    seedDailyValuation(db, ACCT_1, "2025-12-30", 109000);

    const result = computeXirr(db, {
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });

    expect(result).not.toBeNull();
    // Should use monthly snapshot values, not daily
    expect(result!.currentValue).toBe(110000);
  });

  it("returns reasonable XIRR for known scenario", () => {
    // Classic scenario: invest $10,000 on Jan 1,
    // add $5,000 on Jul 1, end with $16,500 on Dec 31
    seedSnapshot(db, ACCT_1, "2024-12-31", 0);
    seedExternalFlow(db, ACCT_1, "2025-01-01", 10000);
    seedExternalFlow(db, ACCT_1, "2025-07-01", 5000);
    seedSnapshot(db, ACCT_1, "2025-12-31", 16500);

    const result = computeXirr(db, {
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });

    expect(result).not.toBeNull();
    // Total invested: $15k, ending: $16.5k, $1.5k gain
    // XIRR should be positive and reasonable (10-15% range)
    expect(result!.perAccount[0].xirr).toBeGreaterThan(0.05);
    expect(result!.perAccount[0].xirr).toBeLessThan(0.25);
    expect(result!.perAccount[0].totalInvested).toBe(15000);
  });

  // ─── New tests: TWS exclusion, snapshot deposits ─────

  it("excludes TWS snapshots from ending value lookup", () => {
    const ACCT_2 = 2;
    seedSnapshot(db, ACCT_1, "2024-12-31", 100000);
    seedSnapshot(db, ACCT_2, "2024-12-31", 50000);
    seedSnapshot(db, ACCT_1, "2025-12-31", 110000);
    seedSnapshot(db, ACCT_2, "2025-12-31", 55000);
    // TWS snapshot AFTER month-end — should NOT be used for ending value
    seedSnapshot(db, ACCT_2, "2026-01-05", 56000, { source: "tws" });

    const result = computeXirr(db, {
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });

    expect(result).not.toBeNull();
    // Ending value = 110k + 55k = 165k, NOT just 56k from TWS
    expect(result!.currentValue).toBe(165000);
  });

  it("uses deposits_withdrawals from snapshots when no transaction flows exist", () => {
    seedSnapshot(db, ACCT_1, "2024-12-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-06-30", 115000, { depositsWithdrawals: 10000 });
    seedSnapshot(db, ACCT_1, "2025-12-31", 120000);
    // No transaction flows seeded!

    const result = computeXirr(db, {
      startDate: "2025-01-01",
      endDate: "2025-12-31",
    });

    expect(result).not.toBeNull();
    expect(result!.perAccount[0].xirr).toBeGreaterThan(0);
    expect(result!.perAccount[0].totalInvested).toBe(10000);
  });

  it("does not use TWS-only ending value for portfolio XIRR", () => {
    const ACCT_2 = 2;
    seedSnapshot(db, ACCT_1, "2024-12-31", 1000000);
    seedSnapshot(db, ACCT_2, "2024-12-31", 500000);
    seedSnapshot(db, ACCT_1, "2025-03-31", 1020000);
    seedSnapshot(db, ACCT_2, "2025-03-31", 510000);
    // TWS snapshot in April — only account 2
    seedSnapshot(db, ACCT_2, "2025-04-06", 515000, { source: "tws" });

    const result = computeXirr(db, {
      startDate: "2025-01-01",
      endDate: "2025-04-30",
    });

    expect(result).not.toBeNull();
    // Portfolio ending value should be $1.53M (Mar totals), not just $515k from TWS
    expect(result!.currentValue).toBe(1530000);
  });
});
