/**
 * fetchNetFlowsUsdByDate: the same window and scope rule as
 * fetchNetFlowsByDate, with every amount read in USD through the one
 * transaction-currency rule (lib/queries/transaction-amount-currency.ts).
 *
 * Every figure here is invented; ZZ* currencies do not exist.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  fetchNetFlowsByDate,
  fetchNetFlowsUsdByDate,
} from "@/lib/compute/flow-adjusted";

const A1 = 1;

let db: Database.Database;

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

function seedFlow(
  date: string,
  type: string,
  amount: number,
  key: string,
  securityId: number | null = null,
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, ?, 1, ?)`,
  ).run(A1, securityId, date, type, amount, key);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  db.exec(`UPDATE accounts SET name = 'Alpha Taxable' WHERE id = 1;
           UPDATE accounts SET name = 'Beta Roth IRA' WHERE id = 2;
           UPDATE accounts SET name = 'Gamma Broker' WHERE id = 3;`);
});

describe("fetchNetFlowsUsdByDate", () => {
  it("a native in-kind leg is converted once", () => {
    const zzd = seedSecurity("ZZDX", "ZZD");
    seedRate("ZZD", 0.5);
    seedFlow("2026-03-02", "TRANSFER_IN", 10_000, "k1", zzd);

    const out = fetchNetFlowsUsdByDate(db, [A1], "2025-12-31", "2026-06-15");
    expect(out.unconvertedCount).toBe(0);
    expect(out.flows).toEqual([{ date: "2026-03-02", net: 5_000 }]);
  });

  it("a USD-stored row on a foreign security is not converted again", () => {
    const zzd = seedSecurity("ZZDX", "ZZD");
    seedRate("ZZD", 0.5);
    seedFlow("2026-03-02", "DEPOSIT", 1_000, "k1", zzd);

    const out = fetchNetFlowsUsdByDate(db, [A1], "2025-12-31", "2026-06-15");
    expect(out.unconvertedCount).toBe(0);
    expect(out.flows).toEqual([{ date: "2026-03-02", net: 1_000 }]);
  });

  it("a native row with no rate is counted, not summed", () => {
    const zzq = seedSecurity("ZZQX", "ZZQ");
    seedFlow("2026-03-02", "TRANSFER_IN", 10_000, "k1", zzq);
    seedFlow("2026-03-02", "DEPOSIT", 2_000, "k2");

    const out = fetchNetFlowsUsdByDate(db, [A1], "2025-12-31", "2026-06-15");
    expect(out.unconvertedCount).toBe(1);
    expect(out.flows).toEqual([{ date: "2026-03-02", net: 2_000 }]);
  });

  it("a TRANSFER_OUT is signed negative, and the window is (start, end]", () => {
    const zzd = seedSecurity("ZZDX", "ZZD");
    seedRate("ZZD", 0.5);
    seedFlow("2025-12-31", "DEPOSIT", 7_000, "on-start");
    seedFlow("2026-02-10", "TRANSFER_OUT", 4_000, "k1", zzd);
    seedFlow("2026-06-15", "WITHDRAWAL", -1_000, "on-end");
    seedFlow("2026-06-16", "DEPOSIT", 9_000, "after-end");

    const out = fetchNetFlowsUsdByDate(db, [A1], "2025-12-31", "2026-06-15");
    expect(out.flows).toEqual([
      { date: "2026-02-10", net: -2_000 },
      { date: "2026-06-15", net: -1_000 },
    ]);
  });

  it("an empty scope reads nothing", () => {
    seedFlow("2026-03-02", "DEPOSIT", 1_000, "k1");
    expect(fetchNetFlowsUsdByDate(db, [], "2025-12-31", "2026-06-15")).toEqual({
      flows: [],
      unconvertedCount: 0,
    });
    // undefined is every account
    expect(fetchNetFlowsUsdByDate(db, undefined, "2025-12-31", "2026-06-15").flows).toEqual([
      { date: "2026-03-02", net: 1_000 },
    ]);
  });

  it("fetchNetFlowsByDate is unchanged", () => {
    const zzd = seedSecurity("ZZDX", "ZZD");
    seedRate("ZZD", 0.5);
    seedFlow("2026-03-02", "TRANSFER_IN", 10_000, "k1", zzd);

    expect(fetchNetFlowsByDate(db, [A1], "2025-12-31", "2026-06-15")).toEqual([
      { date: "2026-03-02", net: 10_000 },
    ]);
  });
});
