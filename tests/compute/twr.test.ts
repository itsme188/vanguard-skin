import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTwr } from "@/lib/compute/twr";

// ─── Seed helpers ───────────────────────────────────────────────────

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEndDate: string,
  totalValue: number,
  opts: {
    startingValue?: number;
    twr?: number;
    depositsWithdrawals?: number;
  } = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots
       (account_id, month_end_date, total_value, starting_value, twr, deposits_withdrawals)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    accountId,
    monthEndDate,
    totalValue,
    opts.startingValue ?? null,
    opts.twr ?? null,
    opts.depositsWithdrawals ?? null
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
     VALUES (?, ?, 'DEPOSIT', ?, 1, ?)`
  ).run(accountId, date, amount, `flow-${accountId}-${date}-${Math.random()}`);
}

describe("TWR computation", () => {
  let db: Database.Database;
  const ACCT_1 = 1; // Vanguard Taxable (seeded by migration)

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns null when no snapshots exist", () => {
    const result = computeTwr(db);
    expect(result).toBeNull();
  });

  it("computes simple return with two snapshots and no external flows", () => {
    // Month 1: $100,000 → Month 2: $110,000 = 10% return
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 110000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    // First month is skipped (no prior value), second month has V_start = 100000
    expect(result!.perAccount).toHaveLength(1);
    const acct = result!.perAccount[0];
    expect(acct.totalReturn).toBeCloseTo(0.1, 6); // 10%
    expect(acct.monthsIncluded).toBe(1);
  });

  it("chain-links multiple months correctly", () => {
    // Three months: $100k → $110k → $121k = (1.1)(1.1) - 1 = 21%
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 110000);
    seedSnapshot(db, ACCT_1, "2025-03-31", 121000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // Two sub-periods: Jan→Feb (+10%), Feb→Mar (+10%)
    // Chain-linked: (1.1)(1.1) - 1 = 0.21
    expect(acct.totalReturn).toBeCloseTo(0.21, 6);
    expect(acct.monthsIncluded).toBe(2);
  });

  it("uses IBKR-provided TWR directly when available", () => {
    // IBKR gives TWR as a percentage (e.g. 5.0 = 5%)
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000, { twr: 5.0 });
    seedSnapshot(db, ACCT_1, "2025-02-28", 108000, { twr: 3.0 });

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // (1.05)(1.03) - 1 = 0.0815
    expect(acct.totalReturn).toBeCloseTo(0.0815, 4);
    expect(acct.monthsIncluded).toBe(2);
    expect(acct.isPartial).toBe(false);
  });

  it("handles mixed IBKR TWR and computed months", () => {
    // Month 1: IBKR TWR = 4%, Month 2: computed (no IBKR TWR)
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000, { twr: 4.0 });
    seedSnapshot(db, ACCT_1, "2025-02-28", 109200); // 5% over 104000

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // Month 1: 4% (IBKR)
    // Month 2: V_start = 100000 (prev total_value), V_end = 109200
    //   Modified Dietz: (109200 - 100000) / 100000 = 0.092
    // Chain-linked: (1.04)(1.092) - 1 = 0.13568
    expect(acct.totalReturn).toBeCloseTo(0.13568, 3);
    expect(acct.monthsIncluded).toBe(2);
  });

  it("applies Modified Dietz correctly with external cash flow mid-month", () => {
    // V_start = $100,000
    // Deposit $10,000 on Feb 15 (14 days remaining out of 28)
    // V_end = $115,500
    // Expected: r = (115500 - 100000 - 10000) / (100000 + 10000 * 14/28)
    //            = 5500 / 105000 = 0.05238...
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 115500);
    seedExternalFlow(db, ACCT_1, "2025-02-15", 10000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // (115500 - 100000 - 10000) / (100000 + 10000 * (13/28))
    // 13 days remaining: Feb 15 → Feb 28 = 13 days
    // = 5500 / (100000 + 4642.857) = 5500 / 104642.857 ≈ 0.05255
    expect(acct.totalReturn).toBeCloseTo(0.05255, 3);
    expect(acct.monthsIncluded).toBe(1);
  });

  it("computes portfolio-wide TWR across multiple accounts", () => {
    // Account 1: $100k → $110k (10%)
    // Account 2: $200k → $220k (10%)
    // Portfolio: $300k → $330k (10%)
    const ACCT_2 = 2;

    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 110000);
    seedSnapshot(db, ACCT_2, "2025-01-31", 200000);
    seedSnapshot(db, ACCT_2, "2025-02-28", 220000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    // Portfolio-wide
    expect(result!.totalReturn).toBeCloseTo(0.1, 6); // 10%
    expect(result!.perAccount).toHaveLength(2);
  });

  it("filters by date range", () => {
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 110000);
    seedSnapshot(db, ACCT_1, "2025-03-31", 121000);
    seedSnapshot(db, ACCT_1, "2025-04-30", 133100);

    // Only Feb through Mar (2 months)
    const result = computeTwr(db, {
      startDate: "2025-02-01",
      endDate: "2025-03-31",
    });
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // Feb: V_start from prior (Jan = 100000), V_end = 110000 → 10%
    // Mar: V_start = 110000, V_end = 121000 → 10%
    // Chain-linked: (1.1)(1.1) - 1 = 0.21
    expect(acct.totalReturn).toBeCloseTo(0.21, 4);
    expect(acct.monthsIncluded).toBe(2);
  });

  it("filters by account ID", () => {
    const ACCT_2 = 2;

    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 110000);
    seedSnapshot(db, ACCT_2, "2025-01-31", 200000);
    seedSnapshot(db, ACCT_2, "2025-02-28", 206000);

    const result = computeTwr(db, { accountId: ACCT_2 });
    expect(result).not.toBeNull();

    expect(result!.perAccount).toHaveLength(1);
    expect(result!.perAccount[0].accountId).toBe(ACCT_2);
    // (206000 - 200000) / 200000 = 3%
    expect(result!.perAccount[0].totalReturn).toBeCloseTo(0.03, 6);
  });

  it("skips months with V_start = 0 and marks partial", () => {
    // First snapshot has 0 value (new account)
    seedSnapshot(db, ACCT_1, "2025-01-31", 0);
    seedSnapshot(db, ACCT_1, "2025-02-28", 50000);
    seedSnapshot(db, ACCT_1, "2025-03-31", 55000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // Jan→Feb: V_start = 0, skipped (partial)
    // Feb→Mar: V_start = 50000, V_end = 55000 → 10%
    expect(acct.totalReturn).toBeCloseTo(0.1, 6);
    expect(acct.isPartial).toBe(true);
    expect(acct.monthsIncluded).toBe(1);
  });

  it("annualizes correctly", () => {
    // 12 months of ~1% monthly return
    const dates = [
      "2025-01-31",
      "2025-02-28",
      "2025-03-31",
      "2025-04-30",
      "2025-05-31",
      "2025-06-30",
      "2025-07-31",
      "2025-08-31",
      "2025-09-30",
      "2025-10-31",
      "2025-11-30",
      "2025-12-31",
    ];
    let value = 100000;
    for (const date of dates) {
      seedSnapshot(db, ACCT_1, date, value);
      value *= 1.01; // 1% growth each month
    }

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    // 11 months of 1% = (1.01)^11 - 1 ≈ 11.57%
    expect(acct.totalReturn).toBeCloseTo(Math.pow(1.01, 11) - 1, 4);
    // Annualized should be close to 12.68% ((1.01)^12 - 1 ≈ 12.68%)
    expect(acct.annualizedReturn).not.toBeNull();
    expect(acct.annualizedReturn!).toBeGreaterThan(0.11);
    expect(acct.annualizedReturn!).toBeLessThan(0.14);
  });

  it("returns null annualized return for short periods", () => {
    // Only 2 months = ~30 days = borderline
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 105000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    // totalDays is 28 (Jan 31 → Feb 28), should be < 30
    const acct = result!.perAccount[0];
    // With only 28 days, annualized return should be null
    expect(acct.totalDays).toBeLessThan(30);
    expect(acct.annualizedReturn).toBeNull();
  });

  it("handles negative returns correctly", () => {
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 90000); // -10%

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    expect(acct.totalReturn).toBeCloseTo(-0.1, 6);
  });

  it("handles withdrawal (negative cash flow) correctly", () => {
    // V_start = $100,000
    // Withdrawal of $10,000 on Feb 15 (13 days remaining out of 28)
    // V_end = $92,000
    // r = (92000 - 100000 - (-10000)) / (100000 + (-10000) * (13/28))
    //   = 2000 / (100000 - 4642.857) = 2000 / 95357.143 ≈ 0.02097
    seedSnapshot(db, ACCT_1, "2025-01-31", 100000);
    seedSnapshot(db, ACCT_1, "2025-02-28", 92000);
    seedExternalFlow(db, ACCT_1, "2025-02-15", -10000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    const acct = result!.perAccount[0];
    expect(acct.totalReturn).toBeCloseTo(0.02097, 3);
  });
});
