import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { computeTwr } from "@/lib/compute/twr";
import { computeXirr } from "@/lib/compute/xirr";

// ─── Donation tracking, 2026-08-17, spec §6.5 ────────────────────────────
//
// In-kind TRANSFER_IN/OUT legs (a security moving in or out; security_id
// set) now carry the transfer-date FMV as a positive `amount` instead of 0.
// That FMV is a real flow for RETURN math (TWR/XIRR) but never a CASH
// movement (daily-valuation.ts's cash stepper). This file covers the
// "union rule": the transaction-fallback branches in TWR/XIRR already
// include these rows (no type filter); only the snapshot-PREFERRED
// branches needed augmenting so an in-kind leg in a month that also has a
// reported statement cash flow (or, for XIRR, ANY month in a range where
// some other month has one) doesn't vanish.

// ─── Seed helpers ─────────────────────────────────────────────────────

function seedSecurity(db: Database.Database, id: number, symbol: string): void {
  db.prepare(`INSERT INTO securities (id, symbol) VALUES (?, ?)`).run(id, symbol);
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, asOfDate, `hold-${accountId}-${securityId}-${asOfDate}`);
}

function seedPrice(db: Database.Database, securityId: number, date: string, price: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
  ).run(securityId, date, price);
}

function seedCashTransaction(
  db: Database.Database,
  accountId: number,
  date: string,
  amount: number,
  type: string
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, 1, ?)`
  ).run(accountId, date, type, amount, `cash-${accountId}-${date}-${type}-${Math.random()}`);
}

/** An in-kind transfer leg: security_id set, FMV stored positive
 *  (type carries direction — SIGNED_EXTERNAL_FLOW_SQL signs OUT negative). */
function seedInKindTransfer(
  db: Database.Database,
  accountId: number,
  securityId: number,
  date: string,
  type: "TRANSFER_IN" | "TRANSFER_OUT",
  fmv: number
): void {
  db.prepare(
    `INSERT INTO transactions
       (account_id, security_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(accountId, securityId, date, type, fmv, `inkind-${accountId}-${date}-${type}-${Math.random()}`);
}

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEndDate: string,
  totalValue: number,
  opts: { startingValue?: number; depositsWithdrawals?: number } = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots
       (account_id, month_end_date, total_value, starting_value, deposits_withdrawals, source)
     VALUES (?, ?, ?, ?, ?, 'manual')`
  ).run(
    accountId,
    monthEndDate,
    totalValue,
    opts.startingValue ?? null,
    opts.depositsWithdrawals ?? null
  );
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z");
  const db_ = new Date(b + "T00:00:00Z");
  return Math.round((db_.getTime() - da.getTime()) / (1000 * 60 * 60 * 24));
}

describe("in-kind transfer FMV union across metric engines", () => {
  let db: Database.Database;
  const ACCT_1 = 1; // Vanguard Taxable (seeded by migration)
  const ACCT_2 = 2; // Vanguard Roth IRA (seeded by migration)

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  // ─── 1. Daily valuation: excludeInKind cash-stepping guard ────────────

  it("does not step cash for an in-kind OUT with FMV, but still steps a real WITHDRAWAL", () => {
    seedSecurity(db, 1, "AAPL"); // held security, drives holdings_value
    seedSecurity(db, 2, "MSFT"); // donated security, transaction-only

    const HOLDINGS = 500_000;
    seedHolding(db, ACCT_1, 1, 1, "2026-01-01");
    seedPrice(db, 1, "2026-01-31", HOLDINGS);
    seedPrice(db, 1, "2026-02-15", HOLDINGS); // inside the Jan->Feb window
    seedPrice(db, 1, "2026-02-28", HOLDINGS);
    seedPrice(db, 1, "2026-03-15", HOLDINGS); // inside the open-ended Feb-anchor window

    // Two anchors, same cash residual (10,000) both times — the in-kind OUT
    // between them never touched cash, so the residual is legitimately
    // unchanged month over month.
    seedSnapshot(db, ACCT_1, "2026-01-31", HOLDINGS + 10_000);
    seedSnapshot(db, ACCT_1, "2026-02-28", HOLDINGS + 10_000);

    // In-kind OUT: $20,000 FMV of MSFT donated/journaled out, mid-window.
    seedInKindTransfer(db, ACCT_1, 2, "2026-02-10", "TRANSFER_OUT", 20_000);

    // A real cash WITHDRAWAL in the open-ended tail after the last anchor.
    seedCashTransaction(db, ACCT_1, "2026-03-05", -6_000, "WITHDRAWAL");

    computeDailyValuations(db);

    const vals = Object.fromEntries(
      (
        db
          .prepare(
            `SELECT valuation_date, cash_balance, total_value FROM daily_valuations WHERE account_id = ? ORDER BY valuation_date`
          )
          .all(ACCT_1) as { valuation_date: string; cash_balance: number; total_value: number }[]
      ).map((v) => [v.valuation_date, v])
    );

    // In-kind OUT never steps cash: the Feb-15 residual is untouched.
    expect(vals["2026-02-15"].cash_balance).toBeCloseTo(10_000, 2);
    expect(vals["2026-02-15"].total_value).toBeCloseTo(HOLDINGS + 10_000, 2);

    // A real WITHDRAWAL after the last anchor still steps cash down.
    expect(vals["2026-03-15"].cash_balance).toBeCloseTo(4_000, 2); // 10,000 - 6,000
    expect(vals["2026-03-15"].total_value).toBeCloseTo(HOLDINGS + 4_000, 2);
  });

  // ─── 2-5. TWR per-account: snapshot-preferred branches augmented ──────

  it("TWR per-account: snapshot deposits_withdrawals AND an in-kind OUT both feed Modified Dietz", () => {
    seedSecurity(db, 1, "AAPL");

    seedSnapshot(db, ACCT_1, "2026-01-31", 100_000); // prior month, no flows
    seedSnapshot(db, ACCT_1, "2026-02-28", 90_000, { depositsWithdrawals: -10_000 });
    // In-kind OUT mid-February: FMV $5,000, day-weighted like the fallback
    // branch (weight = daysRemaining / totalDaysInMonth).
    seedInKindTransfer(db, ACCT_1, 1, "2026-02-10", "TRANSFER_OUT", 5_000);

    const result = computeTwr(db, { accountId: ACCT_1 });
    expect(result).not.toBeNull();

    // Hand-computed Modified Dietz for February 2026 (28 days):
    //   vStart = 100,000 (January), vEnd = 90,000
    //   Flow 1: snapshot cash d_w = -10,000, weight 0.5 (existing convention)
    //   Flow 2: in-kind OUT, SIGNED_EXTERNAL_FLOW_SQL signs TRANSFER_OUT
    //           negative => -5,000; weight = daysRemaining/totalDays
    const totalDaysInFeb = 28;
    const daysRemaining = daysBetween("2026-02-10", "2026-02-28"); // 18
    const inKindWeight = daysRemaining / totalDaysInFeb; // 18/28
    const totalCF = -10_000 + -5_000;
    const weightedCF = -10_000 * 0.5 + -5_000 * inKindWeight;
    const vStart = 100_000;
    const vEnd = 90_000;
    const denominator = vStart + weightedCF;
    const numerator = vEnd - vStart - totalCF;
    const expectedR = numerator / denominator;

    expect(result!.totalReturn).toBeCloseTo(expectedR, 8);
  });

  it("TWR per-account: snapshot deposits_withdrawals with NO in-kind rows is unchanged", () => {
    seedSnapshot(db, ACCT_1, "2026-01-31", 100_000);
    seedSnapshot(db, ACCT_1, "2026-02-28", 104_750, { depositsWithdrawals: -5_000 });

    const result = computeTwr(db, { accountId: ACCT_1 });
    expect(result).not.toBeNull();

    // Pre-existing single-flow math (weight 0.5), no in-kind rows exist:
    //   totalCF = -5,000, weightedCF = -2,500, denominator = 97,500
    //   numerator = 104,750 - 100,000 - (-5,000) = 9,750
    //   r = 9,750 / 97,500 = 0.10 exactly
    expect(result!.totalReturn).toBeCloseTo(0.1, 8);
  });

  it("TWR per-account: fallback month (NULL deposits_withdrawals) includes the in-kind row exactly once", () => {
    seedSecurity(db, 1, "AAPL");

    seedSnapshot(db, ACCT_1, "2026-01-31", 100_000);
    seedSnapshot(db, ACCT_1, "2026-02-28", 106_000); // deposits_withdrawals left NULL
    seedInKindTransfer(db, ACCT_1, 1, "2026-02-12", "TRANSFER_OUT", 4_000);

    const result = computeTwr(db, { accountId: ACCT_1 });
    expect(result).not.toBeNull();

    // NULL deposits_withdrawals => falls straight to the transaction-level
    // fallback (cashFlowStmt), which already includes ALL is_external_flow
    // rows regardless of type — this test proves the new augmentation code
    // (added only to the two snapshot branches) does NOT also fire here and
    // double the flow.
    const totalDaysInFeb = 28;
    const daysRemaining = daysBetween("2026-02-12", "2026-02-28"); // 16
    const weight = daysRemaining / totalDaysInFeb; // 16/28
    const totalCF = -4_000;
    const weightedCF = -4_000 * weight;
    const vStart = 100_000;
    const vEnd = 106_000;
    const denominator = vStart + weightedCF;
    const numerator = vEnd - vStart - totalCF;
    const expectedR = numerator / denominator;

    expect(result!.totalReturn).toBeCloseTo(expectedR, 8);
  });

  it("TWR per-account: December annual-summary branch also unions in-kind rows", () => {
    seedSecurity(db, 1, "AAPL");

    // Nov 30 establishes priorMonthTotal for the annual-summary gap check.
    seedSnapshot(db, ACCT_1, "2026-11-30", 100_000);
    // Dec 31: starting_value is far from Nov's total_value (>10% gap) =>
    // isAnnualSummary=true. deposits_withdrawals is treated as CUMULATIVE
    // for the year; with no Jan-Nov rows seeded, janNovDeps=0, so
    // decemberDeposits = -8,000 - 0 = -8,000.
    seedSnapshot(db, ACCT_1, "2026-12-31", 95_000, {
      startingValue: 60_000,
      depositsWithdrawals: -8_000,
    });
    seedInKindTransfer(db, ACCT_1, 1, "2026-12-10", "TRANSFER_OUT", 3_000);

    const result = computeTwr(db, { accountId: ACCT_1 });
    expect(result).not.toBeNull();

    // Hand-computed Modified Dietz for December 2026 (31 days):
    //   Flow 1: decemberDeposits = -8,000, weight 0.5 (existing convention)
    //   Flow 2: in-kind OUT -3,000, weight = daysRemaining/totalDays
    const totalDaysInDec = 31;
    const daysRemaining = daysBetween("2026-12-10", "2026-12-31"); // 21
    const inKindWeight = daysRemaining / totalDaysInDec; // 21/31
    const totalCF = -8_000 + -3_000;
    const weightedCF = -8_000 * 0.5 + -3_000 * inKindWeight;
    const vStart = 100_000;
    const vEnd = 95_000;
    const denominator = vStart + weightedCF;
    const numerator = vEnd - vStart - totalCF;
    const expectedR = numerator / denominator;

    expect(result!.totalReturn).toBeCloseTo(expectedR, 8);
  });

  // ─── 6. XIRR per-account + portfolio: RANGE-wide snapshot preference ──

  it("XIRR: an in-kind OUT in a snapshot-flow-free month still enters as a positive cash flow (per-account AND portfolio)", () => {
    seedSecurity(db, 1, "AAPL");

    // Starting anchor, strictly before effectiveStart.
    seedSnapshot(db, ACCT_1, "2025-12-31", 100_000);
    // Month A: has a real snapshot cash flow (+5,000 deposit) — this is
    // what makes the per-account branch "RANGE-wide snapshot-preferred."
    seedSnapshot(db, ACCT_1, "2026-01-31", 108_000, { depositsWithdrawals: 5_000 });
    // Month B: NO snapshot cash flow (deposits_withdrawals left NULL) but a
    // real in-kind OUT — pre-fix, this vanished entirely because the
    // per-account branch above never falls through to the transaction-level
    // fallback once ANY month in the range has a snapshot flow.
    seedSnapshot(db, ACCT_1, "2026-02-28", 90_000);
    seedInKindTransfer(db, ACCT_1, 1, "2026-02-10", "TRANSFER_OUT", 20_000);

    const opts = { accountId: ACCT_1, startDate: "2026-01-01", endDate: "2026-02-28" };
    const perAccountResult = computeXirr(db, opts);
    expect(perAccountResult).not.toBeNull();
    const acct = perAccountResult!.perAccount[0];

    // The in-kind OUT is money leaving the portfolio — same sign convention
    // as the WITHDRAWAL path (positive cash flow, counted in totalWithdrawn).
    expect(acct.totalInvested).toBeCloseTo(5_000, 2); // Month A deposit only
    expect(acct.totalWithdrawn).toBeCloseTo(20_000, 2); // the in-kind OUT
    // 4 cash-flow events: start, Month A deposit, in-kind OUT, end value.
    expect(acct.cashFlowCount).toBe(4);

    // Hand-computed bracket (NPV sign check at two rates), not an exact
    // float. Cash flows (base = 2025-12-31):
    //   t=0            : -100,000 (starting value)
    //   t=15/365.25     : -5,000   (Month A deposit, midMonth "2026-01-15")
    //   t=41/365.25     : +20,000  (in-kind OUT, trade_date "2026-02-10")
    //   t=59/365.25     : +90,000  (ending value, "2026-02-28")
    // NPV(0)   = -100,000 - 5,000 + 20,000 + 90,000 = +5,000  (> 0)
    // NPV(1.0) ≈ -100,000 - 5,000*2^-0.0411 + 20,000*2^-0.1123 + 90,000*2^-0.1615
    //          ≈ -100,000 - 4,860 + 18,503 + 80,465 = -5,892 (< 0)
    // A sign change between r=0 and r=1 means the true XIRR is in (0, 1).
    expect(acct.xirr).toBeGreaterThan(0.1);
    expect(acct.xirr).toBeLessThan(0.6);

    // Portfolio-wide: only ACCT_1 has any data, so the aggregate cash-flow
    // list is numerically identical to the per-account one above — same
    // totals, same bracket.
    const portfolioResult = computeXirr(db, {
      startDate: "2026-01-01",
      endDate: "2026-02-28",
    });
    expect(portfolioResult).not.toBeNull();
    expect(portfolioResult!.totalInvested).toBeCloseTo(5_000, 2);
    expect(portfolioResult!.totalWithdrawn).toBeCloseTo(20_000, 2);
    expect(portfolioResult!.cashFlowCount).toBe(4);
    expect(portfolioResult!.xirr).toBeGreaterThan(0.1);
    expect(portfolioResult!.xirr).toBeLessThan(0.6);
  });

  // ─── 7-8. Portfolio TWR: unpaired in-kind + carried-deposits ──────────

  it("portfolio TWR: a snapshot-covered month with an unpaired in-kind OUT matches hand-computed Dietz", () => {
    seedSecurity(db, 1, "AAPL");

    // Single-account portfolio (only ACCT_1 has any snapshots — full
    // coverage is trivially satisfied every month).
    seedSnapshot(db, ACCT_1, "2025-12-31", 100_000);
    seedSnapshot(db, ACCT_1, "2026-01-31", 95_000, { depositsWithdrawals: -8_000 });
    seedInKindTransfer(db, ACCT_1, 1, "2026-01-20", "TRANSFER_OUT", 3_000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    // Hand-computed Modified Dietz for January 2026 (31 days):
    //   Flow 1: effectiveDeposits (snapshot cash) = -8,000, weight 0.5
    //   Flow 2: in-kind OUT -3,000, weight = daysRemaining/totalDays
    const totalDaysInJan = 31;
    const daysRemaining = daysBetween("2026-01-20", "2026-01-31"); // 11
    const inKindWeight = daysRemaining / totalDaysInJan; // 11/31
    const totalCF = -8_000 + -3_000;
    const weightedCF = -8_000 * 0.5 + -3_000 * inKindWeight;
    const vStart = 100_000;
    const vEnd = 95_000;
    const denominator = vStart + weightedCF;
    const numerator = vEnd - vStart - totalCF;
    const expectedR = numerator / denominator;

    expect(result!.totalReturn).toBeCloseTo(expectedR, 8);
  });

  it("portfolio TWR: an in-kind flow in a statement-lag SKIPPED month carries forward, not vanishes", () => {
    seedSecurity(db, 1, "AAPL");

    // Both accounts report Nov 30 — establishes expected_accounts=2 for
    // every month from December onward.
    seedSnapshot(db, ACCT_1, "2025-11-30", 50_000);
    seedSnapshot(db, ACCT_2, "2025-11-30", 30_000);

    // December: ACCT_2's statement is late (no row at all) => present=1 <
    // expected=2 => December is SKIPPED from the aggregate. It carries a
    // $500 cash withdrawal AND a $1,000 in-kind OUT (unpaired donation leg).
    seedSnapshot(db, ACCT_1, "2025-12-31", 52_000, { depositsWithdrawals: 500 });
    seedInKindTransfer(db, ACCT_1, 1, "2025-12-15", "TRANSFER_OUT", 1_000);

    // January: both accounts report again => COVERED. No flows of its own —
    // the whole effectiveDeposits comes from what carried over from
    // December.
    seedSnapshot(db, ACCT_1, "2026-01-31", 52_000);
    seedSnapshot(db, ACCT_2, "2026-01-31", 32_000);

    const result = computeTwr(db);
    expect(result).not.toBeNull();

    // Hand-computed Modified Dietz for January 2026 (the only covered
    // sub-period — November has no prior anchor and is skipped):
    //   vStart = Nov total = 50,000 + 30,000 = 80,000
    //   vEnd   = Jan total = 52,000 + 32,000 = 84,000
    //   carried_deposits (Dec, skipped) = 500 (cash d_w only)
    //   carried_inkind (Dec, skipped)  = SIGNED_EXTERNAL_FLOW_SQL(TRANSFER_OUT
    //                                     1,000) = -1,000
    //   effectiveDeposits = 0 (Jan's own d_w) + 500 + (-1,000) = -500
    //   totalCF = -500, weightedCF (weight 0.5) = -250
    //   denominator = 80,000 - 250 = 79,750
    //   numerator = 84,000 - 80,000 - (-500) = 4,500
    //   r = 4,500 / 79,750
    const vStart = 80_000;
    const vEnd = 84_000;
    const carriedDeposits = 500;
    const carriedInKind = -1_000; // TRANSFER_OUT FMV signed negative
    const effectiveDeposits = carriedDeposits + carriedInKind;
    const totalCF = effectiveDeposits;
    const weightedCF = effectiveDeposits * 0.5;
    const denominator = vStart + weightedCF;
    const numerator = vEnd - vStart - totalCF;
    const expectedR = numerator / denominator;

    expect(result!.totalReturn).toBeCloseTo(expectedR, 8);

    // "No vanish" check: had the in-kind carry been dropped (the pre-fix
    // bug), effectiveDeposits would have been just +500 (cash only), giving
    // a visibly different return. Confirm the actual result does NOT match
    // that buggy alternative.
    const buggyEffectiveDeposits = carriedDeposits; // in-kind carry dropped
    const buggyWeightedCF = buggyEffectiveDeposits * 0.5;
    const buggyDenominator = vStart + buggyWeightedCF;
    const buggyNumerator = vEnd - vStart - buggyEffectiveDeposits;
    const buggyR = buggyNumerator / buggyDenominator;
    expect(result!.totalReturn).not.toBeCloseTo(buggyR, 4);
  });
});
