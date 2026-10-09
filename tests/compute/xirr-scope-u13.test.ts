/**
 * U13 — the money-weighted return (XIRR) covers the WHOLE selected scope.
 *
 * Defect: computeXirr took one `accountId`, so a scope of two or more
 * accounts was collapsed to its first account by every caller (the
 * Performance view and /api/compute/xirr). A scope's money-weighted return
 * is ONE rate over the summed cash flows of every account in it.
 *
 * The expected rate below is worked by hand. Every figure is invented.
 *
 *   Accounts 1 and 2 are the scope; account 3 is outside it.
 *   Opening statement 2025-03-31, one deposit, closing statement 2025-04-30.
 *   A statement's deposit is dated mid-month (the 15th), so the deposit sits
 *   exactly 15 days after the opening and 15 days before the closing.
 *
 *     account 1: opens 100,000, deposits 30,000, closes 134,640
 *     account 2: opens  50,000, no deposit,      closes  48,675
 *     scope:     opens 150,000, deposits 30,000, closes 183,315
 *
 *   Let g be the growth factor over one 15-day half. The rate solves
 *     150,000 * g^2 + 30,000 * g = 183,315
 *   and g = 1.01 does:  150,000 * 1.0201 = 153,015 ; 30,000 * 1.01 = 30,300 ;
 *   153,015 + 30,300 = 183,315.
 *   Annualized (the engine's 365.25-day year): 1.01^(365.25 / 15) - 1.
 *
 *   Account 1 alone solves 100,000 * g^2 + 30,000 * g = 134,640 at g = 1.02
 *   (104,040 + 30,600), so the old first-account answer was
 *   1.02^(365.25 / 15) - 1: about double the scope's.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeXirr } from "@/lib/compute/xirr";

const A = 1;
const B = 2;
const OUTSIDE = 3;
const RANGE = { startDate: "2025-04-01", endDate: "2025-04-30" };
const HALF_YEARS = 15 / 365.25;

function annualized(growthPerHalf: number): number {
  return Math.pow(growthPerHalf, 1 / HALF_YEARS) - 1;
}

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

describe("computeXirr — a multi-account scope is one return over the whole scope", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    seedSnapshot(db, A, "2025-03-31", 100000);
    seedSnapshot(db, A, "2025-04-30", 134640, 30000);
    seedSnapshot(db, B, "2025-03-31", 50000);
    seedSnapshot(db, B, "2025-04-30", 48675);
    // Outside the scope: 200,000 * 1.03^2 + 10,000 * 1.03 = 222,480.
    seedSnapshot(db, OUTSIDE, "2025-03-31", 200000);
    seedSnapshot(db, OUTSIDE, "2025-04-30", 222480, 10000);
  });

  it("the hand-worked rate: 150,000 in, 30,000 mid-month, 183,315 out is 1% per half", () => {
    const scope = computeXirr(db, { ...RANGE, accountIds: [A, B] });
    expect(scope).not.toBeNull();
    expect(scope!.xirr).toBeCloseTo(annualized(1.01), 6);
    expect(scope!.currentValue).toBe(183315);
    expect(scope!.totalInvested).toBe(30000);
    expect(scope!.totalWithdrawn).toBe(0);
    expect(scope!.startDate).toBe("2025-03-31");
    expect(scope!.endDate).toBe("2025-04-30");
    expect(scope!.perAccount.map((a) => a.accountId)).toEqual([A, B]);
  });

  it("is not the first account's return, and not the whole portfolio's", () => {
    const scope = computeXirr(db, { ...RANGE, accountIds: [A, B] })!;
    const first = computeXirr(db, { ...RANGE, accountId: A })!;
    const everything = computeXirr(db, RANGE)!;

    // The old answer for this scope: account 1 alone, 2% per half.
    expect(first.xirr).toBeCloseTo(annualized(1.02), 6);
    expect(scope.xirr).toBeLessThan(first.xirr - 0.1);

    // The account outside the scope (3% per half) lifts the all-accounts
    // rate above the scope's and adds its value and deposit.
    expect(everything.currentValue).toBe(405795);
    expect(everything.totalInvested).toBe(40000);
    expect(everything.xirr).toBeGreaterThan(scope.xirr + 0.1);
  });

  it("the order of the ids does not matter", () => {
    const ab = computeXirr(db, { ...RANGE, accountIds: [A, B] })!;
    const ba = computeXirr(db, { ...RANGE, accountIds: [B, A] })!;
    expect(ba.xirr).toBeCloseTo(ab.xirr, 10);
    expect(ba.currentValue).toBe(ab.currentValue);
  });

  it("a one-account scope is exactly the single-account result", () => {
    const viaList = computeXirr(db, { ...RANGE, accountIds: [B] });
    const viaId = computeXirr(db, { ...RANGE, accountId: B });
    expect(viaList).toEqual(viaId);
    // Account 2 alone lost money: 50,000 became 48,675 with no flow.
    expect(viaList!.xirr).toBeCloseTo(Math.pow(48675 / 50000, 365.25 / 30) - 1, 6);
  });

  it("an empty scope is no result, never the whole portfolio", () => {
    expect(computeXirr(db, { ...RANGE, accountIds: [] })).toBeNull();
  });

  it("a month one scope account has not reported is not used as the closing value", () => {
    // Account 1 has a May statement, account 2 does not yet. The scope's
    // closing value must stay the last month BOTH reported (April), even
    // though the account outside the scope has no May statement either.
    seedSnapshot(db, A, "2025-05-31", 140000);
    const scope = computeXirr(db, { startDate: "2025-04-01", endDate: "2025-05-31", accountIds: [A, B] })!;
    expect(scope.currentValue).toBe(183315);
    expect(scope.xirr).toBeCloseTo(annualized(1.01), 6);
  });

  it("the opening value falls back to the scope's own daily values, not another account's", () => {
    // No statement before the window for the scope: only daily values.
    db.prepare("DELETE FROM monthly_snapshots WHERE month_end_date = '2025-03-31'").run();
    const seedDaily = (accountId: number, value: number) =>
      db
        .prepare(
          `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
           VALUES (?, '2025-03-31', 0, ?, ?)`,
        )
        .run(accountId, value, value);
    seedDaily(A, 100000);
    seedDaily(B, 50000);
    seedDaily(OUTSIDE, 200000);
    const scope = computeXirr(db, { ...RANGE, accountIds: [A, B] })!;
    expect(scope.startDate).toBe("2025-03-31");
    expect(scope.xirr).toBeCloseTo(annualized(1.01), 6);
  });
});

describe("callers hand computeXirr the whole scope", () => {
  // Both callers open the production db at import and the repo has no DOM
  // harness, so the wiring is pinned by reading the source.
  const flat = (path: string) => readFileSync(path, "utf8").replace(/\s+/g, " ");

  it("the XIRR route resolves the full scope, never its first account", () => {
    const route = flat("app/api/compute/xirr/route.ts");
    expect(route).not.toContain("resolveScopeToSingleId");
    expect(route).toContain("resolveScope(db, scope)");
    expect(route).toContain("accountIds");
  });

  it("the Performance view passes the scope's id list", () => {
    const view = flat("app/dashboard/components/PerformanceView.tsx");
    expect(view).toContain(
      "computeXirr(db, { startDate: chainStart, endDate: chainEnd, accountIds: scopeAccountIds })",
    );
    expect(view).not.toContain("scopeAccountIds?.[0]");
  });
});
