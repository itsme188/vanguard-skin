/**
 * The year's gain so far, in dollars: value now, minus each account's
 * Dec 31 statement total, minus the year's net external flows in USD.
 *
 * A missing input refuses the figure (gainUsd null, the account named):
 * a missing deposit would otherwise read as gain.
 *
 * Every figure here is invented; round numbers so each expectation can be
 * checked by hand. ZZ* currencies and tickers do not exist.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeYearGain } from "@/lib/compute/year-gain";

const A1 = 1; // "Alpha Taxable"
const A2 = 2; // "Beta Roth IRA"
const A3 = 3; // "Gamma Broker"
const TODAY = "2026-06-15";
const BASE = "2025-12-31";

let db: Database.Database;

function seedSnapshot(
  accountId: number,
  monthEndDate: string,
  totalValue: number,
  opts: { startingValue?: number | null; depositsWithdrawals?: number | null; source?: string } = {},
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

function seedDaily(accountId: number, date: string, total: number): void {
  db.prepare(
    `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
     VALUES (?, ?, 0, ?, ?)`,
  ).run(accountId, date, total, total);
}

function seedSecurity(symbol: string, currency: string): number {
  return Number(
    db
      .prepare(`INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'Stock', ?)`)
      .run(symbol, symbol, currency).lastInsertRowid,
  );
}

function seedRate(currency: string, usdPerUnit: number): void {
  db.prepare(`INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES (?, ?, '2026-01-02', 'ibkr_ledger')`).run(
    currency,
    usdPerUnit,
  );
}

let flowKey = 0;
function seedFlow(
  accountId: number,
  date: string,
  type: string,
  amount: number,
  opts: { securityId?: number; notes?: string } = {},
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, amount, is_external_flow, source_key, notes)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(accountId, opts.securityId ?? null, date, type, amount, `flow-${++flowKey}`, opts.notes ?? null);
}

/** Dec 31 base plus Jan..May statements for A1, chained, +1_000 a month of market gain. */
function seedStatementYear(opts: { marchDepositInLedger: boolean; skipFeb?: boolean }): void {
  seedSnapshot(A1, BASE, 100_000);
  const months: [string, number, number][] = [
    ["2026-01-31", 101_000, 0],
    ["2026-02-28", 102_000, 0],
    ["2026-03-31", 113_000, 10_000],
    ["2026-04-30", 114_000, 0],
    ["2026-05-31", 115_000, 0],
  ];
  let prior = 100_000;
  for (const [date, total, dw] of months) {
    if (!(opts.skipFeb && date === "2026-02-28")) {
      seedSnapshot(A1, date, total, { startingValue: prior, depositsWithdrawals: dw });
    }
    prior = total;
  }
  if (opts.marchDepositInLedger) seedFlow(A1, "2026-03-02", "DEPOSIT", 10_000);
  seedDaily(A1, "2026-06-12", 116_000);
}

/**
 * A1: Dec 31 base 100_000, Jan..May statements chained (+1_000 a month by
 * default), each month's flow total from `dw` (default 0), month totals
 * overridable. A current value on 2026-06-12 one month-step above May.
 */
function buildYear(opts: {
  dw?: (monthEnd: string) => number | null;
  totals?: Record<string, number>;
} = {}): void {
  seedSnapshot(A1, BASE, 100_000);
  const defaults: [string, number][] = [
    ["2026-01-31", 101_000],
    ["2026-02-28", 102_000],
    ["2026-03-31", 103_000],
    ["2026-04-30", 104_000],
    ["2026-05-31", 105_000],
  ];
  let prior = 100_000;
  for (const [date, def] of defaults) {
    const total = opts.totals?.[date] ?? def;
    const dw = opts.dw ? opts.dw(date) : 0;
    seedSnapshot(A1, date, total, { startingValue: prior, depositsWithdrawals: dw });
    prior = total;
  }
  seedDaily(A1, "2026-06-12", prior + 1_000);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  db.exec(`UPDATE accounts SET name = 'Alpha Taxable' WHERE id = 1;
           UPDATE accounts SET name = 'Beta Roth IRA' WHERE id = 2;
           UPDATE accounts SET name = 'Gamma Broker' WHERE id = 3;`);
});

describe("computeYearGain", () => {
  it("value now minus the Dec 31 statement minus the year's USD flows", () => {
    seedSnapshot(A1, BASE, 100_000);
    seedFlow(A1, "2026-03-02", "DEPOSIT", 10_000);
    seedDaily(A1, "2026-06-12", 125_000);

    const r = computeYearGain(db, { accountIds: [A1], today: TODAY });
    expect(r.baseDate).toBe(BASE);
    expect(r.valueNowUsd).toBe(125_000);
    expect(r.baseValueUsd).toBe(100_000);
    expect(r.netFlowsUsd).toBe(10_000);
    expect(r.gainUsd).toBe(15_000);
    expect(r.missingBaseAccounts).toEqual([]);
    expect(r.unusableCurrentAccounts).toEqual([]);
    expect(r.unconvertedFlowAccounts).toEqual([]);
    expect(r.accounts).toEqual([
      { accountId: A1, name: "Alpha Taxable", valueUsd: 125_000, asOfDate: "2026-06-12" },
    ]);
  });

  it("a withdrawal noted as an internal transfer to another account is an ordinary withdrawal", () => {
    seedSnapshot(A1, BASE, 100_000);
    seedFlow(A1, "2026-04-01", "WITHDRAWAL", -20_000, { notes: "Internal transfer to account ZZ-OTHER" });
    seedDaily(A1, "2026-06-12", 90_000);

    const r = computeYearGain(db, { accountIds: [A1], today: TODAY });
    expect(r.netFlowsUsd).toBe(-20_000);
    expect(r.gainUsd).toBe(10_000);
  });

  it("a foreign in-kind transfer is converted", () => {
    const zzd = seedSecurity("ZZDX", "ZZD");
    seedRate("ZZD", 0.5);
    seedSnapshot(A1, BASE, 100_000);
    seedFlow(A1, "2026-02-10", "TRANSFER_OUT", 4_000, { securityId: zzd });
    seedDaily(A1, "2026-06-12", 100_000);

    const r = computeYearGain(db, { accountIds: [A1], today: TODAY });
    expect(r.netFlowsUsd).toBe(-2_000);
    expect(r.gainUsd).toBe(2_000);
  });

  it("a flow with no rate prints no gain and names the account", () => {
    const zzq = seedSecurity("ZZQX", "ZZQ");
    seedSnapshot(A1, BASE, 100_000);
    seedFlow(A1, "2026-02-10", "TRANSFER_IN", 4_000, { securityId: zzq });
    seedDaily(A1, "2026-06-12", 110_000);

    const r = computeYearGain(db, { accountIds: [A1], today: TODAY });
    expect(r.gainUsd).toBeNull();
    expect(r.unconvertedFlowAccounts).toEqual([{ accountId: A1, name: "Alpha Taxable", count: 1 }]);
  });

  it("a live snapshot on Dec 31 is not a base", () => {
    seedSnapshot(A1, BASE, 100_000, { source: "tws" });
    seedDaily(A1, "2026-06-12", 110_000);

    const r = computeYearGain(db, { accountIds: [A1], today: TODAY });
    expect(r.gainUsd).toBeNull();
    expect(r.missingBaseAccounts).toEqual([{ accountId: A1, name: "Alpha Taxable" }]);
  });

  it("an account with no current value, or valued before Jan 1, prints no gain", () => {
    seedSnapshot(A1, BASE, 100_000);
    seedDaily(A1, "2026-06-12", 110_000);
    // A2: nothing on record at all.
    // A3: only the Dec 31 statement, so its "current" value is dated last year.
    seedSnapshot(A3, BASE, 50_000);

    const r = computeYearGain(db, { accountIds: [A1, A2, A3], today: TODAY });
    expect(r.gainUsd).toBeNull();
    expect(r.unusableCurrentAccounts).toEqual([
      { accountId: A2, name: "Beta Roth IRA", reason: "no-current-value" },
      { accountId: A3, name: "Gamma Broker", reason: "value-before-year" },
    ]);
    expect(r.missingBaseAccounts).toEqual([{ accountId: A2, name: "Beta Roth IRA" }]);
  });

  it("empty scope reads nothing", () => {
    const spy = vi.spyOn(db, "prepare");
    const r = computeYearGain(db, { accountIds: [], today: TODAY });
    expect(r.gainUsd).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    expect(r).toEqual({
      gainUsd: null,
      valueNowUsd: 0,
      baseValueUsd: 0,
      netFlowsUsd: 0,
      baseDate: BASE,
      accounts: [],
      missingBaseAccounts: [],
      unusableCurrentAccounts: [],
      unconvertedFlowAccounts: [],
      reconciliation: { status: "not-checked", throughMonth: null, differenceUsd: null },
    });
  });

  it("equals the sum of the monthly gains through the last statement month-end", () => {
    seedStatementYear({ marchDepositInLedger: true });

    const r = computeYearGain(db, { accountIds: [A1], today: TODAY });
    expect(r.gainUsd).toBe(6_000);
    expect(r.reconciliation.status).toBe("agrees");
    expect(r.reconciliation.throughMonth).toBe("2026-05-31");
    expect(r.reconciliation.differenceUsd).toBeCloseTo(0, 6);
  });

  it("differs when the statement shows a deposit the ledger lacks", () => {
    seedStatementYear({ marchDepositInLedger: false });

    const r = computeYearGain(db, { accountIds: [A1], today: TODAY });
    expect(r.reconciliation.status).toBe("differs");
    expect(r.reconciliation.throughMonth).toBe("2026-05-31");
    // Statement gain 15_000 (no ledger deposit) minus monthly sum 5_000.
    expect(r.reconciliation.differenceUsd).toBe(10_000);
  });

  it("not checked when a month has no figure", () => {
    seedStatementYear({ marchDepositInLedger: true, skipFeb: true });

    const r = computeYearGain(db, { accountIds: [A1], today: TODAY });
    expect(r.reconciliation.status).toBe("not-checked");
    expect(r.reconciliation.reason).toBe("month-without-figure");
    expect(r.reconciliation.differenceUsd).toBeNull();
    // The year's gain itself does not need the monthly statements.
    expect(r.gainUsd).toBe(6_000);
  });

  it("R1: a ledger with no statement figure behind it is never 'agrees'", () => {
    // No statement carries a month flow total; a bogus 50_000 ledger deposit
    // would check itself against itself.
    buildYear({ dw: () => null });
    seedFlow(A1, "2026-03-02", "DEPOSIT", 50_000);

    const r = computeYearGain(db, { accountIds: [A1], today: TODAY });
    expect(r.reconciliation.status).toBe("not-checked");
    expect(r.reconciliation.reason).toBe("ledger-unverified");
    expect(r.reconciliation.differenceUsd).toBeNull();
  });

  it("R2: a foreign in-kind leg in the span is not-checked, never a false 'differs'", () => {
    const zzd = seedSecurity("ZZDX", "ZZD");
    seedRate("ZZD", 0.5);
    // Correct book: March gains 1_000 of market plus a 1_000 USD in-kind arrival.
    buildYear({ totals: { "2026-03-31": 104_000, "2026-04-30": 105_000, "2026-05-31": 106_000 } });
    seedFlow(A1, "2026-03-02", "TRANSFER_IN", 2_000, { securityId: zzd });

    const r = computeYearGain(db, { accountIds: [A1], today: TODAY });
    expect(r.reconciliation.status).toBe("not-checked");
    expect(r.reconciliation.reason).toBe("foreign-in-kind");
    expect(r.reconciliation.differenceUsd).toBeNull();
  });

  it("R3: ledger and statement flow totals that disagree are 'differs', with no figure", () => {
    buildYear({ dw: (m) => (m === "2026-03-31" ? 10_000 : 0), totals: { "2026-03-31": 113_000, "2026-04-30": 114_000, "2026-05-31": 115_000 } });
    seedFlow(A1, "2026-03-02", "DEPOSIT", 10_001.5);

    const r = computeYearGain(db, { accountIds: [A1], today: TODAY });
    expect(r.reconciliation.status).toBe("differs");
    expect(r.reconciliation.reason).toBe("flows-disagree");
    expect(r.reconciliation.differenceUsd).toBeNull();
    expect(r.reconciliation.throughMonth).toBe("2026-05-31");
  });

  it("precedence: flows-disagree, then foreign-in-kind, then ledger-unverified, then month-without-figure", () => {
    const zzd = seedSecurity("ZZDX", "ZZD");
    seedRate("ZZD", 0.5);
    // Jan: no statement flow total (ledger-unverified). Mar: flows disagree.
    // Apr: a foreign in-kind leg. Feb missing for A2 (month without figure).
    buildYear({
      dw: (m) => (m === "2026-01-31" ? null : m === "2026-03-31" ? 10_000 : 0),
      totals: { "2026-03-31": 113_000, "2026-04-30": 115_000, "2026-05-31": 116_000 },
    });
    seedFlow(A1, "2026-03-02", "DEPOSIT", 10_001.5);
    seedFlow(A1, "2026-04-02", "TRANSFER_IN", 2_000, { securityId: zzd });
    seedSnapshot(A2, BASE, 50_000);
    seedSnapshot(A2, "2026-01-31", 50_000, { startingValue: 50_000, depositsWithdrawals: 0 });
    for (const m of ["2026-03-31", "2026-04-30", "2026-05-31"]) {
      seedSnapshot(A2, m, 50_000, { startingValue: 50_000, depositsWithdrawals: 0 });
    }
    const run = () => computeYearGain(db, { accountIds: [A1, A2], today: TODAY }).reconciliation;

    expect(run()).toEqual({ status: "differs", throughMonth: "2026-05-31", differenceUsd: null, reason: "flows-disagree" });

    db.prepare(`DELETE FROM transactions WHERE trade_date = '2026-03-02'`).run();
    db.prepare(`UPDATE monthly_snapshots SET deposits_withdrawals = 0 WHERE account_id = ? AND month_end_date = '2026-03-31'`).run(A1);
    expect(run().reason).toBe("foreign-in-kind");

    db.prepare(`DELETE FROM transactions WHERE trade_date = '2026-04-02'`).run();
    expect(run().reason).toBe("ledger-unverified");

    db.prepare(`UPDATE monthly_snapshots SET deposits_withdrawals = 0 WHERE month_end_date = '2026-01-31'`).run();
    expect(run().reason).toBe("month-without-figure");
    expect(run().status).toBe("not-checked");
  });

  it("not checked when no month-end of the year has a statement for every account", () => {
    seedStatementYear({ marchDepositInLedger: true });
    seedSnapshot(A2, BASE, 50_000);
    seedDaily(A2, "2026-06-12", 50_000);

    const r = computeYearGain(db, { accountIds: [A1, A2], today: TODAY });
    expect(r.gainUsd).toBe(6_000);
    expect(r.reconciliation).toEqual({ status: "not-checked", throughMonth: null, differenceUsd: null });
  });

  it("each account's flows stop at its own as-of date; accounts carry their value dates", () => {
    seedSnapshot(A1, BASE, 100_000);
    seedDaily(A1, "2026-04-10", 105_000);
    seedFlow(A1, "2026-05-05", "DEPOSIT", 5_000); // after A1's value date: not yet in its value

    seedSnapshot(A2, BASE, 50_000);
    seedDaily(A2, "2026-06-12", 60_000);
    seedFlow(A2, "2026-05-05", "DEPOSIT", 5_000);

    const r = computeYearGain(db, { accountIds: [A1, A2], today: TODAY });
    expect(r.netFlowsUsd).toBe(5_000);
    expect(r.gainUsd).toBe(10_000);
    expect(r.accounts).toEqual([
      { accountId: A1, name: "Alpha Taxable", valueUsd: 105_000, asOfDate: "2026-04-10" },
      { accountId: A2, name: "Beta Roth IRA", valueUsd: 60_000, asOfDate: "2026-06-12" },
    ]);
  });
});
