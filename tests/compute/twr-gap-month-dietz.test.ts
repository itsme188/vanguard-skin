import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTwr } from "@/lib/compute/twr";

// A month with no statement must not turn its deposit into gain.
//
// When a month's statement is missing, the Modified Dietz month that follows
// opens on the statement BEFORE the gap, so its value change covers both
// months. Before the fix only the later month's own flows were read, and a
// deposit dated inside the missing month read as investment return (+51% on
// a flat book). The fix treats (opening statement, month end] as ONE Dietz
// period: flows dated inside the missing months are read from the ledger and
// weighted by the days left over the WHOLE span. All figures are synthetic.

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEndDate: string,
  totalValue: number,
  opts: { startingValue?: number; twr?: number; depositsWithdrawals?: number; source?: string } = {},
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots
       (account_id, month_end_date, total_value, starting_value, twr, deposits_withdrawals, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    accountId,
    monthEndDate,
    totalValue,
    opts.startingValue ?? null,
    opts.twr ?? null,
    opts.depositsWithdrawals ?? null,
    opts.source ?? "manual",
  );
}

let flowSeq = 0;
function seedFlow(db: Database.Database, accountId: number, date: string, amount: number): void {
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, 'DEPOSIT', ?, 1, ?)`,
  ).run(accountId, date, amount, `gap-flow-${accountId}-${date}-${flowSeq++}`);
}

function seedSecurity(db: Database.Database, id: number, symbol: string): void {
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type) VALUES (?, ?, ?, 'Stock')`,
  ).run(id, symbol, symbol);
}

function seedInKind(
  db: Database.Database,
  accountId: number,
  securityId: number,
  date: string,
  type: "TRANSFER_IN" | "TRANSFER_OUT",
  amount: number,
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, 10, ?, 1, ?)`,
  ).run(accountId, securityId, date, type, amount, `gap-inkind-${accountId}-${date}-${flowSeq++}`);
}

/** Days between two ISO dates, as the compute layer counts them. */
function days(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

describe("TWR across a missing statement month (Modified Dietz over the whole gap)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  // Jan 31 to Mar 31 is 59 days; the Feb 10 deposit has 49 of them left.
  //   r = (151,000 - 100,000 - 50,000) / (100,000 + 50,000 × 49/59)
  //     = 1,000 / 141,525.4237…  = +0.70659…%
  const SINGLE_EXPECTED = 1_000 / (100_000 + (50_000 * 49) / 59);

  it("single account: a deposit inside the missing month is a flow, not gain", () => {
    seedSnapshot(db, 1, "2026-01-31", 100_000);
    seedFlow(db, 1, "2026-02-10", 50_000);
    seedSnapshot(db, 1, "2026-03-31", 151_000);

    const r = computeTwr(db, { startDate: "2026-02-01", accountId: 1 });
    expect(r).not.toBeNull();
    // Before the fix: +51.0% (the deposit read as return).
    expect(days("2026-01-31", "2026-03-31")).toBe(59);
    expect(r!.totalReturn).toBeCloseTo(SINGLE_EXPECTED, 10);
    expect(r!.totalReturn).toBeCloseTo(0.0070659, 6);
    expect(r!.measurementStartDate).toBe("2026-01-31");
    expect(r!.isPartial).toBe(true);
  });

  it("control: with February present the same book returns about +0.71%", () => {
    seedSnapshot(db, 1, "2026-01-31", 100_000);
    seedFlow(db, 1, "2026-02-10", 50_000);
    seedSnapshot(db, 1, "2026-02-28", 150_500);
    seedSnapshot(db, 1, "2026-03-31", 151_000);

    const r = computeTwr(db, { startDate: "2026-02-01", accountId: 1 });
    expect(r!.totalReturn).toBeGreaterThan(0.006);
    expect(r!.totalReturn).toBeLessThan(0.008);
    expect(r!.isPartial).toBe(false);
  });

  // Two accounts, 200,000 at Jan 31, 251,000 at Mar 31, the same 50,000
  // deposit into account 1 on Feb 10:
  //   r = 1,000 / (200,000 + 50,000 × 49/59) = 1,000 / 241,525.4237… = +0.41404…%
  const AGG_EXPECTED = 1_000 / (200_000 + (50_000 * 49) / 59);

  it("two accounts, both missing February (no aggregate row at all)", () => {
    seedSnapshot(db, 1, "2026-01-31", 100_000);
    seedSnapshot(db, 2, "2026-01-31", 100_000);
    seedFlow(db, 1, "2026-02-10", 50_000);
    seedSnapshot(db, 1, "2026-03-31", 151_000);
    seedSnapshot(db, 2, "2026-03-31", 100_000);

    const r = computeTwr(db, { startDate: "2026-02-01" });
    // Before the fix: +25.5%.
    expect(r!.totalReturn).toBeCloseTo(AGG_EXPECTED, 10);
    expect(r!.totalReturn).toBeCloseTo(0.0041404, 6);
    expect(r!.measurementStartDate).toBe("2026-01-31");
    expect(r!.isPartial).toBe(true);
    // Account 1's own row is the single-account case.
    const a1 = r!.perAccount.find((a) => a.accountId === 1)!;
    expect(a1.totalReturn).toBeCloseTo(SINGLE_EXPECTED, 10);
  });

  it("two accounts, only the first missing February (skipped, statement-lag month)", () => {
    seedSnapshot(db, 1, "2026-01-31", 100_000);
    seedSnapshot(db, 2, "2026-01-31", 100_000);
    seedFlow(db, 1, "2026-02-10", 50_000);
    seedSnapshot(db, 2, "2026-02-28", 100_000);
    seedSnapshot(db, 1, "2026-03-31", 151_000);
    seedSnapshot(db, 2, "2026-03-31", 100_000);

    const r = computeTwr(db, { startDate: "2026-02-01" });
    // Before the fix: +25.5%.
    expect(r!.totalReturn).toBeCloseTo(AGG_EXPECTED, 10);
    expect(r!.isPartial).toBe(true);
  });

  it("a skipped month's stated deposit is carried once, never also read from the ledger", () => {
    // Account 2 reports February with a stated 20,000 deposit AND the ledger
    // row behind it; account 1 is missing February. The stated figure rides
    // in carriedDeposits (weight 0.5 of the period); the ledger row of the
    // same account-month must not be added again. Account 1's own ledger
    // deposit (no February row) is read and day-weighted over the span.
    seedSnapshot(db, 1, "2026-01-31", 100_000);
    seedSnapshot(db, 2, "2026-01-31", 100_000);
    seedFlow(db, 1, "2026-02-10", 50_000);
    seedFlow(db, 2, "2026-02-12", 20_000);
    seedSnapshot(db, 2, "2026-02-28", 120_000, { depositsWithdrawals: 20_000 });
    seedSnapshot(db, 1, "2026-03-31", 151_000);
    seedSnapshot(db, 2, "2026-03-31", 121_000);

    const r = computeTwr(db, { startDate: "2026-02-01" });
    //   flows: 20,000 at weight 0.5 (carried statement figure), 50,000 at 49/59
    //   r = (272,000 - 200,000 - 70,000) / (200,000 + 10,000 + 50,000 × 49/59)
    const expected = 2_000 / (200_000 + 10_000 + (50_000 * 49) / 59);
    expect(r!.totalReturn).toBeCloseTo(expected, 10);
  });

  it("an in-kind leg inside a month with no row at all is read once, day-weighted", () => {
    seedSecurity(db, 1, "AAA");
    seedSnapshot(db, 1, "2026-01-31", 100_000);
    seedInKind(db, 1, 1, "2026-02-10", "TRANSFER_OUT", 10_000);
    seedSnapshot(db, 1, "2026-03-31", 91_000);

    const r = computeTwr(db, { startDate: "2026-02-01", accountId: 1 });
    //   r = (91,000 - 100,000 + 10,000) / (100,000 - 10,000 × 49/59)
    const expected = 1_000 / (100_000 - (10_000 * 49) / 59);
    expect(r!.totalReturn).toBeCloseTo(expected, 10);
  });

  it("a gap at the window's start goes through the prior-statement anchor", () => {
    // Window opens Mar 1; the last statement before it is Jan 31 (February
    // missing), so the March period opens on Jan 31.
    seedSnapshot(db, 1, "2026-01-31", 100_000);
    seedFlow(db, 1, "2026-02-10", 50_000);
    seedSnapshot(db, 1, "2026-03-31", 151_000);

    const r = computeTwr(db, { startDate: "2026-03-01", accountId: 1 });
    expect(r!.totalReturn).toBeCloseTo(SINGLE_EXPECTED, 10);
    expect(r!.measurementStartDate).toBe("2026-01-31");
    expect(r!.totalDays).toBe(59);
    expect(r!.isPartial).toBe(true);
  });

  it("stored monthly returns: a month with no stored return is flagged partial, the figure unchanged", () => {
    seedSnapshot(db, 1, "2025-12-31", 100_000);
    seedSnapshot(db, 1, "2026-01-31", 101_000, { twr: 0.01, source: "canonical" });
    // February missing.
    seedSnapshot(db, 1, "2026-03-31", 103_020, { twr: 0.02, source: "canonical" });

    const r = computeTwr(db, { startDate: "2026-01-01", accountId: 1 });
    expect(r!.totalReturn).toBeCloseTo(1.01 * 1.02 - 1, 12);
    expect(r!.isPartial).toBe(true);
  });

  it("stored monthly returns with no missing month INSIDE the window stay complete", () => {
    // The anchor before the window is two months back (December missing),
    // but December is outside a window that opens on Jan 1.
    seedSnapshot(db, 1, "2025-11-30", 100_000);
    seedSnapshot(db, 1, "2026-01-31", 101_000, { twr: 0.01, source: "canonical" });
    seedSnapshot(db, 1, "2026-02-28", 102_010, { twr: 0.01, source: "canonical" });
    const r = computeTwr(db, { startDate: "2026-01-01", accountId: 1 });
    expect(r!.isPartial).toBe(false);
  });
});

describe("TWR gap ending on a December annual-summary row (review defect 1)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  // Oct 31 to Dec 31 is 61 days; the Nov 10 deposit has 51 of them left.
  //   r = (151,000 - 100,000 - 50,000) / (100,000 + 50,000 × 51/61)
  //     = 1,000 / 141,803.2787…  = +0.70520…%
  const ANNUAL_SINGLE = 1_000 / (100_000 + (50_000 * 51) / 61);

  function seedAnnualGap(): void {
    seedSnapshot(db, 1, "2026-10-31", 100_000);
    // No November statement. The December row is an annual summary: a
    // year-start opening value and the year's cumulative deposits.
    seedFlow(db, 1, "2026-11-10", 50_000);
    seedSnapshot(db, 1, "2026-12-31", 151_000, { startingValue: 60_000, depositsWithdrawals: 50_000 });
  }

  it("single account: the November deposit is counted once (ledger only, not also the annual residual)", () => {
    seedAnnualGap();
    const r = computeTwr(db, { startDate: "2026-11-01", accountId: 1 });
    // Before this fix: -29.38% (counted twice). HEAD before the gap fix: +0.80%.
    expect(days("2026-10-31", "2026-12-31")).toBe(61);
    expect(r!.totalReturn).toBeCloseTo(ANNUAL_SINGLE, 10);
    expect(r!.totalReturn).toBeCloseTo(0.0070520, 6);
    expect(r!.isPartial).toBe(true);
  });

  it("aggregate twin: a second flat account, both missing November", () => {
    seedAnnualGap();
    seedSnapshot(db, 2, "2026-10-31", 100_000);
    seedSnapshot(db, 2, "2026-12-31", 100_000);
    const r = computeTwr(db, { startDate: "2026-11-01" });
    //   r = 1,000 / (200,000 + 50,000 × 51/61) = 1,000 / 241,803.2787… = +0.41356…%
    // Before this fix: +0.44% (HEAD) / double count in the gap code.
    expect(r!.totalReturn).toBeCloseTo(1_000 / (200_000 + (50_000 * 51) / 61), 10);
    expect(r!.isPartial).toBe(true);
  });

  it("a December annual row with November present is unchanged (old = new)", () => {
    // Pinned from the code before the gap fix.
    seedSnapshot(db, 1, "2026-10-31", 100_000);
    seedFlow(db, 1, "2026-11-10", 50_000);
    seedSnapshot(db, 1, "2026-11-30", 150_400, { depositsWithdrawals: 50_000 });
    seedSnapshot(db, 1, "2026-12-31", 151_000, { startingValue: 60_000, depositsWithdrawals: 50_000 });
    seedSnapshot(db, 2, "2026-10-31", 100_000);
    seedSnapshot(db, 2, "2026-11-30", 100_000);
    seedSnapshot(db, 2, "2026-12-31", 100_000);
    expect(JSON.stringify(computeTwr(db, { startDate: "2026-11-01", accountId: 1 }))).toBe(PINNED_ANNUAL_NO_GAP.single);
    expect(JSON.stringify(computeTwr(db, { startDate: "2026-11-01" }))).toBe(PINNED_ANNUAL_NO_GAP.aggregate);
  });
});

describe("TWR: a non-positive Dietz denominator gives no figure (review defect 3)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("a large withdrawal inside a gap never prints a return below -100%", () => {
    seedSnapshot(db, 1, "2025-12-31", 100_000);
    seedSnapshot(db, 1, "2026-01-31", 100_000);
    // February missing; 150,000 withdrawn on Feb 2 (57 of 59 days left):
    //   denominator = 100,000 - 150,000 × 57/59 = -44,915.25… (no average capital)
    seedFlow(db, 1, "2026-02-02", -150_000);
    seedSnapshot(db, 1, "2026-03-31", 1_000);
    const r = computeTwr(db, { startDate: "2026-01-01", accountId: 1 });
    // Before this fix: -113.5%. The March span is left out; January (0%) stays.
    expect(r!.totalReturn).toBe(0);
    expect(r!.perAccount[0].monthsIncluded).toBe(1);
    expect(r!.isPartial).toBe(true);
  });
});

// ─── Invariant: every month present → byte-identical output ─────────────
//
// The full output of a multi-month, two-account fixture with snapshot
// deposits, ledger-only months, an in-kind leg, stored monthly returns and a
// December annual-summary row, pinned from the code BEFORE the gap fix.

function seedAllMonthsPresent(db: Database.Database): void {
  seedSecurity(db, 1, "AAA");
  const months = [
    "2025-12-31",
    "2026-01-31",
    "2026-02-28",
    "2026-03-31",
    "2026-04-30",
    "2026-05-31",
    "2026-06-30",
    "2026-07-31",
    "2026-08-31",
    "2026-09-30",
    "2026-10-31",
    "2026-11-30",
  ];
  let v1 = 100_000;
  let v2 = 50_000;
  for (let i = 0; i < months.length; i++) {
    const m = months[i];
    v1 = v1 * (1 + 0.01 * ((i % 3) - 0.5));
    v2 = v2 * (1 + 0.004 * ((i % 4) - 1));
    if (m === "2026-02-28") {
      // Snapshot-stated deposit.
      v1 += 5_000;
      seedSnapshot(db, 1, m, v1, { depositsWithdrawals: 5_000 });
    } else if (m === "2026-04-30") {
      // Ledger-only month (no stated figure).
      v1 -= 2_000;
      seedFlow(db, 1, "2026-04-12", -2_000);
      seedSnapshot(db, 1, m, v1);
    } else if (m === "2026-06-30") {
      v1 -= 3_000;
      seedSnapshot(db, 1, m, v1, { depositsWithdrawals: 1_000 });
      seedInKind(db, 1, 1, "2026-06-20", "TRANSFER_OUT", 4_000);
    } else {
      seedSnapshot(db, 1, m, v1);
    }
    if (i > 0 && i % 2 === 0) {
      seedSnapshot(db, 2, m, v2, { twr: 0.004 * ((i % 4) - 1), source: "canonical" });
    } else {
      seedSnapshot(db, 2, m, v2);
    }
  }
  // December annual-summary row for account 1: a year-start opening value
  // and a cumulative deposit figure.
  v1 = v1 * 1.005;
  seedSnapshot(db, 1, "2026-12-31", v1, { startingValue: 60_000, depositsWithdrawals: 6_000 });
  v2 = v2 * 1.002;
  seedSnapshot(db, 2, "2026-12-31", v2);
  seedFlow(db, 2, "2026-12-15", 0.0);
}

describe("TWR invariant: a scope with every month present is unchanged by the gap fix", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedAllMonthsPresent(db);
  });

  const cases: Array<[string, Parameters<typeof computeTwr>[1]]> = [
    ["aggregate, all history", {}],
    ["aggregate, from Mar 1", { startDate: "2026-03-01" }],
    ["account 1", { accountId: 1 }],
    ["account 2 from Feb 1", { accountId: 2, startDate: "2026-02-01" }],
    ["accounts [1,2] to Sep 30", { accountIds: [1, 2], endDate: "2026-09-30" }],
  ];

  for (const [name, opts] of cases) {
    it(`pins the full output: ${name}`, () => {
      const r = computeTwr(db, opts);
      expect(JSON.stringify(r)).toBe(PINNED[name]);
    });
  }
});

// Captured from the pre-fix code (JSON.stringify of computeTwr's result).
const PINNED: Record<string, string> = {
  "aggregate, all history":
    '{"startDate":"2025-12-31","measurementStartDate":"2025-12-31","endDate":"2026-12-31","totalReturn":0.05785113087078808,"annualizedReturn":0.05789188038221971,"totalDays":365,"perAccount":[{"accountId":1,"accountName":"Vanguard Taxable","startDate":"2025-12-31","measurementStartDate":"2025-12-31","endDate":"2026-12-31","totalReturn":0.07155535930417067,"annualizedReturn":0.07160608411881819,"totalDays":365,"monthsIncluded":12,"isPartial":true},{"accountId":2,"accountName":"Vanguard Roth IRA","startDate":"2025-12-31","measurementStartDate":"2025-12-31","endDate":"2026-12-31","totalReturn":0.030312889808324917,"annualizedReturn":0.030333963826780552,"totalDays":365,"monthsIncluded":12,"isPartial":true}],"isPartial":true}',
  "aggregate, from Mar 1":
    '{"startDate":"2026-03-31","measurementStartDate":"2026-02-28","endDate":"2026-12-31","totalReturn":0.04270453562522558,"annualizedReturn":0.051181675812165484,"totalDays":306,"perAccount":[{"accountId":1,"accountName":"Vanguard Taxable","startDate":"2026-03-31","measurementStartDate":"2026-02-28","endDate":"2026-12-31","totalReturn":0.05084601315199411,"annualizedReturn":0.06098596312420623,"totalDays":306,"monthsIncluded":10,"isPartial":false},{"accountId":2,"accountName":"Vanguard Roth IRA","startDate":"2026-03-31","measurementStartDate":"2026-02-28","endDate":"2026-12-31","totalReturn":0.026208057578013033,"annualizedReturn":0.03136147781446175,"totalDays":306,"monthsIncluded":10,"isPartial":false}],"isPartial":false}',
  "account 1":
    '{"startDate":"2025-12-31","measurementStartDate":"2025-12-31","endDate":"2026-12-31","totalReturn":0.07155535930417067,"annualizedReturn":0.07160608411881819,"totalDays":365,"perAccount":[{"accountId":1,"accountName":"Vanguard Taxable","startDate":"2025-12-31","measurementStartDate":"2025-12-31","endDate":"2026-12-31","totalReturn":0.07155535930417067,"annualizedReturn":0.07160608411881819,"totalDays":365,"monthsIncluded":12,"isPartial":true}],"isPartial":true}',
  "account 2 from Feb 1":
    '{"startDate":"2026-02-28","measurementStartDate":"2026-02-01","endDate":"2026-12-31","totalReturn":0.030312889808324917,"annualizedReturn":0.03329696262845139,"totalDays":333,"perAccount":[{"accountId":2,"accountName":"Vanguard Roth IRA","startDate":"2026-02-28","measurementStartDate":"2026-02-01","endDate":"2026-12-31","totalReturn":0.030312889808324917,"annualizedReturn":0.03329696262845139,"totalDays":333,"monthsIncluded":11,"isPartial":false}],"isPartial":false}',
  "accounts [1,2] to Sep 30":
    '{"startDate":"2025-12-31","measurementStartDate":"2025-12-31","endDate":"2026-09-30","totalReturn":0.03554778390734903,"annualizedReturn":0.047843246152973196,"totalDays":273,"perAccount":[{"accountId":1,"accountName":"Vanguard Taxable","startDate":"2025-12-31","measurementStartDate":"2025-12-31","endDate":"2026-09-30","totalReturn":0.045241024545845,"annualizedReturn":0.060986643429484344,"totalDays":273,"monthsIncluded":9,"isPartial":true},{"accountId":2,"accountName":"Vanguard Roth IRA","startDate":"2025-12-31","measurementStartDate":"2025-12-31","endDate":"2026-09-30","totalReturn":0.016031486212112478,"annualizedReturn":0.021506611352727578,"totalDays":273,"monthsIncluded":9,"isPartial":true}],"isPartial":true}',
};

// Captured from the code before the gap fix (a December annual row whose
// November is present).
const PINNED_ANNUAL_NO_GAP = {
  single:
    '{"startDate":"2026-11-30","measurementStartDate":"2026-10-31","endDate":"2026-12-31","totalReturn":0.007202127659574398,"annualizedReturn":0.04390622619962792,"totalDays":61,"perAccount":[{"accountId":1,"accountName":"Vanguard Taxable","startDate":"2026-11-30","measurementStartDate":"2026-10-31","endDate":"2026-12-31","totalReturn":0.007202127659574398,"annualizedReturn":0.04390622619962792,"totalDays":61,"monthsIncluded":2,"isPartial":false}],"isPartial":false}',
  aggregate:
    '{"startDate":"2026-11-30","measurementStartDate":"2026-10-31","endDate":"2026-12-31","totalReturn":0.004178203762868371,"annualizedReturn":0.025279985122250936,"totalDays":61,"perAccount":[{"accountId":1,"accountName":"Vanguard Taxable","startDate":"2026-11-30","measurementStartDate":"2026-10-31","endDate":"2026-12-31","totalReturn":0.007202127659574398,"annualizedReturn":0.04390622619962792,"totalDays":61,"monthsIncluded":2,"isPartial":false},{"accountId":2,"accountName":"Vanguard Roth IRA","startDate":"2026-11-30","measurementStartDate":"2026-10-31","endDate":"2026-12-31","totalReturn":0,"annualizedReturn":0,"totalDays":61,"monthsIncluded":2,"isPartial":false}],"isPartial":false}',
};
