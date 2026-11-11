/**
 * Monthly performance per account, and the blended figure across a scope.
 *
 * The owner asked to see, after the three monthly statements are imported,
 * "my month's performance blending all three accounts and each account
 * individually", for past months of the year as well as future ones.
 *
 * One formula throughout (lib/compute/monthly-performance.ts):
 *
 *     r = (V_end − V_start − F) / (V_start + Σ w_i·F_i)
 *
 * Modified Dietz. With no flows it collapses to (V_end − V_start)/V_start,
 * so there is never a second formula — only a different set of weights. The
 * blended figure aggregates the accounts' BALANCES and FLOWS and runs that
 * one equation once; it is never the mean of the accounts' percentages.
 *
 * Every figure in this file is invented. Round numbers are chosen so each
 * expected return can be checked by hand.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  computeMonthlyPerformance,
  listStatementMonths,
} from "@/lib/compute/monthly-performance";

const A1 = 1; // "Alpha Taxable"
const A2 = 2; // "Beta Roth IRA"
const A3 = 3; // "Gamma Broker"

const MAR = "2026-03-31";
const FEB = "2026-02-28";

let db: Database.Database;

// Migration 002 seeds ids 1-3 already; rename them so nothing in this file
// leans on the real book's account names.
function seedAccounts(): void {
  db.exec(
    `UPDATE accounts SET name = 'Alpha Taxable' WHERE id = 1;
     UPDATE accounts SET name = 'Beta Roth IRA' WHERE id = 2;
     UPDATE accounts SET name = 'Gamma Broker' WHERE id = 3;`,
  );
}

function seedSnapshot(
  accountId: number,
  monthEndDate: string,
  totalValue: number,
  opts: {
    startingValue?: number | null;
    depositsWithdrawals?: number | null;
    source?: string;
  } = {},
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots
       (account_id, month_end_date, total_value, starting_value, deposits_withdrawals, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    accountId,
    monthEndDate,
    totalValue,
    opts.startingValue ?? null,
    opts.depositsWithdrawals ?? null,
    opts.source ?? "canonical",
  );
}

/** A month pair: the prior month-end and the month-end being measured. */
function seedMonthPair(
  accountId: number,
  beginning: number,
  ending: number,
  opts: { depositsWithdrawals?: number | null } = {},
): void {
  seedSnapshot(accountId, FEB, beginning, { startingValue: null });
  seedSnapshot(accountId, MAR, ending, {
    startingValue: beginning,
    depositsWithdrawals:
      opts.depositsWithdrawals === undefined ? 0 : opts.depositsWithdrawals,
  });
}

function seedCashFlow(
  accountId: number,
  date: string,
  type: string,
  amount: number,
  key: string,
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(accountId, date, type, amount, key);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  seedAccounts();
});

describe("blended monthly performance", () => {
  it("is the balance-weighted result of the one formula, never the mean of the three percentages", () => {
    // +10% on 100k, +3% on 300k, +1% on 100k. No flows anywhere.
    seedMonthPair(A1, 100_000, 110_000);
    seedMonthPair(A2, 300_000, 309_000);
    seedMonthPair(A3, 100_000, 101_000);

    const result = computeMonthlyPerformance(db, [A1, A2, A3], MAR);

    const byId = new Map(result.accounts.map((a) => [a.accountId, a]));
    expect(byId.get(A1)!.returnFraction).toBeCloseTo(0.1, 10);
    expect(byId.get(A2)!.returnFraction).toBeCloseTo(0.03, 10);
    expect(byId.get(A3)!.returnFraction).toBeCloseTo(0.01, 10);

    // 500k → 520k = +4.00%. The mean of the percentages would be 4.6667%.
    expect(result.blended.incomplete).toBe(false);
    expect(result.blended.beginningValue).toBe(500_000);
    expect(result.blended.endingValue).toBe(520_000);
    expect(result.blended.gainLoss).toBeCloseTo(20_000, 6);
    expect(result.blended.returnFraction).toBeCloseTo(0.04, 10);
    expect(result.blended.returnFraction).not.toBeCloseTo(0.0466667, 5);
    expect(result.blended.method).toBe("modified-dietz");
  });

  it("names the account whose statement is missing and still shows the two that are present", () => {
    seedMonthPair(A1, 100_000, 110_000);
    seedMonthPair(A2, 300_000, 309_000);
    // Gamma's February statement is in, its March statement is not.
    seedSnapshot(A3, FEB, 100_000);

    const result = computeMonthlyPerformance(db, [A1, A2, A3], MAR);

    expect(result.blended.incomplete).toBe(true);
    expect(result.blended.returnFraction).toBeNull();
    expect(result.blended.gainLoss).toBeNull();
    expect(result.blended.blockedBy).toEqual([
      { accountId: A3, accountName: "Gamma Broker", refusal: "no-statement" },
    ]);

    // The two present accounts keep their own figures.
    const byId = new Map(result.accounts.map((a) => [a.accountId, a]));
    expect(byId.get(A1)!.returnFraction).toBeCloseTo(0.1, 10);
    expect(byId.get(A2)!.returnFraction).toBeCloseTo(0.03, 10);
    expect(byId.get(A3)!.returnFraction).toBeNull();
    expect(byId.get(A3)!.refusal).toBe("no-statement");
  });

  it("blocks the blend when a present account has no measurable return, naming the reason", () => {
    seedMonthPair(A1, 100_000, 110_000);
    seedMonthPair(A2, 300_000, 309_000);
    // Gamma has a March statement but no February one: nothing to measure from.
    seedSnapshot(A3, MAR, 101_000, { startingValue: 100_000, depositsWithdrawals: 0 });

    const result = computeMonthlyPerformance(db, [A1, A2, A3], MAR);

    expect(result.blended.incomplete).toBe(true);
    expect(result.blended.blockedBy).toEqual([
      { accountId: A3, accountName: "Gamma Broker", refusal: "no-prior-statement" },
    ]);
  });
});

describe("flows are never performance", () => {
  it("excludes a mid-month contribution and weights it by the days it was invested", () => {
    // 100k start, 50k in on the 16th of a 31-day month, 160k end.
    // gain      = 160,000 − 100,000 − 50,000              = 10,000
    // weight    = (31 − 16) / 31                          = 15/31
    // denom     = 100,000 + 50,000 × 15/31                ≈ 124,193.5484
    // r         = 10,000 / 124,193.5484                   ≈ 8.0519%
    seedMonthPair(A1, 100_000, 160_000, { depositsWithdrawals: 50_000 });
    seedCashFlow(A1, "2026-03-16", "DEPOSIT", 50_000, "flow-contribution");

    const row = computeMonthlyPerformance(db, [A1], MAR).accounts[0];

    expect(row.netFlow).toBeCloseTo(50_000, 6);
    expect(row.gainLoss).toBeCloseTo(10_000, 6);
    const denominator = 100_000 + 50_000 * (15 / 31);
    expect(row.returnFraction).toBeCloseTo(10_000 / denominator, 10);
    // The raw balance change would read as +60%: the contribution is not return.
    expect(row.returnFraction).not.toBeCloseTo(0.6, 3);
    expect(row.method).toBe("modified-dietz");
    expect(row.flowSource).toBe("ledger-verified");
  });

  it("excludes a withdrawal the same way", () => {
    // 100k start, 20k out on the 16th, 85k end.
    // gain  = 85,000 − 100,000 − (−20,000) = 5,000
    // denom = 100,000 − 20,000 × 15/31     ≈ 90,322.5806
    seedMonthPair(A1, 100_000, 85_000, { depositsWithdrawals: -20_000 });
    seedCashFlow(A1, "2026-03-16", "WITHDRAWAL", -20_000, "flow-withdrawal");

    const row = computeMonthlyPerformance(db, [A1], MAR).accounts[0];

    expect(row.gainLoss).toBeCloseTo(5_000, 6);
    expect(row.returnFraction).toBeCloseTo(5_000 / (100_000 - 20_000 * (15 / 31)), 10);
  });

  it("blends the flows, not the returns, when one account took a contribution", () => {
    seedMonthPair(A1, 100_000, 160_000, { depositsWithdrawals: 50_000 });
    seedCashFlow(A1, "2026-03-16", "DEPOSIT", 50_000, "flow-contribution");
    seedMonthPair(A2, 300_000, 309_000);
    seedMonthPair(A3, 100_000, 101_000);

    const blended = computeMonthlyPerformance(db, [A1, A2, A3], MAR).blended;

    // begin 500,000 · end 570,000 · flow +50,000 on the 16th
    // gain  = 570,000 − 500,000 − 50,000     = 20,000
    // denom = 500,000 + 50,000 × 15/31      ≈ 524,193.5484
    expect(blended.netFlow).toBeCloseTo(50_000, 6);
    expect(blended.gainLoss).toBeCloseTo(20_000, 6);
    expect(blended.returnFraction).toBeCloseTo(
      20_000 / (500_000 + 50_000 * (15 / 31)),
      10,
    );
  });
});

describe("a down month", () => {
  it("renders a negative return and a negative gain", () => {
    seedMonthPair(A1, 200_000, 180_000);

    const row = computeMonthlyPerformance(db, [A1], MAR).accounts[0];

    expect(row.returnFraction).toBeCloseTo(-0.1, 10);
    expect(row.gainLoss).toBeCloseTo(-20_000, 6);
  });

  it("blends down months with up months on balances, not on percentages", () => {
    seedMonthPair(A1, 100_000, 90_000); // −10%
    seedMonthPair(A2, 300_000, 315_000); // +5%
    seedMonthPair(A3, 100_000, 100_000); // flat

    const blended = computeMonthlyPerformance(db, [A1, A2, A3], MAR).blended;

    // 500,000 → 505,000 = +1.00%. The mean of the percentages is −1.6667%.
    expect(blended.returnFraction).toBeCloseTo(0.01, 10);
    expect(blended.gainLoss).toBeCloseTo(5_000, 6);
  });
});

describe("flow evidence", () => {
  it("marks the month unverified when the statement reports no flow total", () => {
    // The IBKR activity statements carry no month deposits/withdrawals total
    // for part of the year; the dated ledger flows are then all there is.
    seedMonthPair(A1, 100_000, 110_000, { depositsWithdrawals: null });

    const row = computeMonthlyPerformance(db, [A1], MAR).accounts[0];

    expect(row.returnFraction).toBeCloseTo(0.1, 10);
    expect(row.flowSource).toBe("ledger-unverified");
    expect(row.method).toBe("modified-dietz");
  });

  it("refuses when the dated flows and the statement's own total disagree", () => {
    // Statement says 50k came in; the ledger has a dated 20k. Which is right
    // is unknowable, and the 30k difference would otherwise read as return.
    seedMonthPair(A1, 100_000, 155_000, { depositsWithdrawals: 50_000 });
    seedCashFlow(A1, "2026-03-16", "DEPOSIT", 20_000, "flow-partial");

    const row = computeMonthlyPerformance(db, [A1], MAR).accounts[0];

    expect(row.refusal).toBe("flows-disagree");
    expect(row.returnFraction).toBeNull();
  });

  it("falls back to the statement's own month total, undated, when the ledger has no dated row at all", () => {
    // The statement reports 50k moving and the ledger has nothing dated for
    // it (a ledger gap). The statement is the only evidence of how much
    // moved and does not say when, so every weight is zero and the
    // denominator is the opening balance.
    seedMonthPair(A1, 100_000, 155_000, { depositsWithdrawals: 50_000 });

    const row = computeMonthlyPerformance(db, [A1], MAR).accounts[0];

    expect(row.flowSource).toBe("statement-total");
    expect(row.method).toBe("undated-flows");
    expect(row.netFlow).toBeCloseTo(50_000, 6);
    expect(row.gainLoss).toBeCloseTo(5_000, 6);
    expect(row.returnFraction).toBeCloseTo(0.05, 10);
  });

  it("carries the weakest account's flow evidence into the blended figure", () => {
    seedMonthPair(A1, 100_000, 110_000, { depositsWithdrawals: 0 });
    seedMonthPair(A2, 300_000, 309_000, { depositsWithdrawals: null });

    const blended = computeMonthlyPerformance(db, [A1, A2], MAR).blended;

    expect(blended.flowSource).toBe("ledger-unverified");
    expect(blended.returnFraction).toBeCloseTo((419_000 - 400_000) / 400_000, 10);
  });

  it("drops the whole blend to the undated form when any account's flows are undated", () => {
    seedMonthPair(A1, 100_000, 155_000, { depositsWithdrawals: 50_000 });
    seedMonthPair(A2, 300_000, 309_000);

    const blended = computeMonthlyPerformance(db, [A1, A2], MAR).blended;

    expect(blended.method).toBe("undated-flows");
    expect(blended.flowSource).toBe("statement-total");
    // begin 400,000 · end 464,000 · flow 50,000 · denominator = 400,000
    expect(blended.gainLoss).toBeCloseTo(14_000, 6);
    expect(blended.returnFraction).toBeCloseTo(14_000 / 400_000, 10);
  });
});

describe("refusals", () => {
  it("refuses a December annual-summary row rather than reading its year figures as a month", () => {
    seedSnapshot(A1, "2025-11-30", 100_000);
    // starting_value is the YEAR start, not November's close.
    seedSnapshot(A1, "2025-12-31", 120_000, {
      startingValue: 50_000,
      depositsWithdrawals: 0,
    });

    const row = computeMonthlyPerformance(db, [A1], "2025-12-31").accounts[0];

    expect(row.refusal).toBe("annual-summary-row");
    expect(row.returnFraction).toBeNull();
  });

  it("refuses when the statement's own beginning balance does not match the prior close", () => {
    seedSnapshot(A1, FEB, 100_000);
    seedSnapshot(A1, MAR, 110_000, { startingValue: 95_000, depositsWithdrawals: 0 });

    const row = computeMonthlyPerformance(db, [A1], MAR).accounts[0];

    expect(row.refusal).toBe("statements-do-not-chain");
    expect(row.returnFraction).toBeNull();
  });

  it("refuses a month with no measurable base", () => {
    seedMonthPair(A1, 0, 10_000);

    const row = computeMonthlyPerformance(db, [A1], MAR).accounts[0];

    expect(row.refusal).toBe("no-measurable-base");
    expect(row.returnFraction).toBeNull();
  });

  it("never reads a live broker snapshot as a month-end statement", () => {
    seedSnapshot(A1, FEB, 100_000);
    seedSnapshot(A1, MAR, 999_999, { source: "plaid" });

    const row = computeMonthlyPerformance(db, [A1], MAR).accounts[0];

    expect(row.refusal).toBe("no-statement");
  });
});

describe("the month list", () => {
  it("lists the statement months newest first and leaves live snapshots out", () => {
    seedSnapshot(A1, "2026-01-31", 100_000);
    seedSnapshot(A1, FEB, 101_000);
    seedSnapshot(A2, FEB, 200_000);
    seedSnapshot(A1, MAR, 102_000);
    seedSnapshot(A1, "2026-04-15", 103_000, { source: "plaid" });
    seedSnapshot(A3, "2026-04-20", 104_000, { source: "tws" });

    expect(listStatementMonths(db, [A1, A2, A3])).toEqual([
      MAR,
      FEB,
      "2026-01-31",
    ]);
  });

  it("respects the scope", () => {
    seedSnapshot(A1, "2026-01-31", 100_000);
    seedSnapshot(A2, FEB, 200_000);

    expect(listStatementMonths(db, [A2])).toEqual([FEB]);
  });

  it("treats an undefined scope as every account and an empty list as none", () => {
    seedSnapshot(A1, "2026-01-31", 100_000);
    seedSnapshot(A2, FEB, 200_000);

    expect(listStatementMonths(db, undefined)).toEqual([FEB, "2026-01-31"]);
    expect(listStatementMonths(db, [])).toEqual([]);
  });

  it("blends nothing for an empty scope", () => {
    seedMonthPair(A1, 100_000, 110_000);

    const result = computeMonthlyPerformance(db, [], MAR);

    expect(result.accounts).toEqual([]);
    expect(result.blended.incomplete).toBe(true);
    expect(result.blended.returnFraction).toBeNull();
  });
});
