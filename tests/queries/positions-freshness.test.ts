/**
 * "Positions as of" (Analysis trust strip, 2026-11-23): the reader reports how
 * old the rows are that the Analysis readers count as held. A live row left
 * behind by an earlier sync (the reconciler's shrink guard refused its
 * zero-quantity tombstone) still counts as held, so the label must name the
 * OLDEST counted live date, not only the newest.
 *
 * Migrated in-memory schema; synthetic symbols and round numbers only.
 * Accounts 1 (Vanguard Taxable), 2 (Vanguard Roth IRA), 3 (IBKR) come from
 * migration 002.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getPositionsFreshness } from "@/lib/queries/positions-freshness";
import { getAnalysisTrustState } from "@/lib/queries/analysis-trust-state";

// Monday. The previous trading session is Friday 2026-11-20.
const TODAY = "2026-11-23";

let db: Database.Database;
let nextSecurityId = 100;

function security(
  symbol: string,
  opts: { type?: string; maturity?: string; expiration?: string } = {},
): number {
  const id = nextSecurityId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, maturity_date, expiration_date)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, symbol, opts.type ?? "Stock", opts.maturity ?? null, opts.expiration ?? null);
  return id;
}

function hold(accountId: number, securityId: number, date: string, sourceKey: string, quantity = 100): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(accountId, securityId, date, quantity, sourceKey);
}

const tws = (acct: number, sec: number, date: string) => `tws-${acct}-${sec}-${date}`;
const plaid = (acct: number, sec: number, date: string) => `plaid:${acct}:${sec}:${date}`;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  nextSecurityId = 100;
});

describe("getPositionsFreshness", () => {
  it("all rows on one live date reads good, with the broker sync as source", () => {
    const a = security("AAA");
    const b = security("BBB");
    hold(3, a, TODAY, tws(3, a, TODAY));
    hold(3, b, TODAY, tws(3, b, TODAY));

    const f = getPositionsFreshness(db, undefined, TODAY);
    expect(f.accounts).toHaveLength(1);
    const acct = f.accounts[0];
    expect(acct.accountId).toBe(3);
    expect(acct.accountName).toBeTruthy();
    expect(acct.newestLiveDate).toBe(TODAY);
    expect(acct.liveRowCount).toBe(2);
    expect(acct.liveSource).toBe("broker sync");
    expect(acct.leftover.count).toBe(0);
    expect(acct.leftover.symbols).toEqual([]);
    expect(acct.statementRows.count).toBe(0);
    expect(f.newestDate).toBe(TODAY);
    expect(f.oldestCountedLiveDate).toBe(TODAY);
    expect(f.leftoverCount).toBe(0);
    expect(f.level).toBe("good");
  });

  it("live rows from an earlier sync still counted are leftovers: bad, with their symbols and date", () => {
    const a = security("AAA");
    const b = security("BBB");
    const c = security("CCC");
    const d = security("DDD");
    hold(3, a, TODAY, tws(3, a, TODAY));
    hold(3, b, TODAY, tws(3, b, TODAY));
    // The previous session's sync held CCC and DDD; today's sync did not
    // report them and no tombstone was written, so they still read latest.
    hold(3, c, "2026-11-20", tws(3, c, "2026-11-20"));
    hold(3, d, "2026-11-20", tws(3, d, "2026-11-20"));

    const f = getPositionsFreshness(db, [3], TODAY);
    const acct = f.accounts[0];
    expect(acct.newestLiveDate).toBe(TODAY);
    expect(acct.liveRowCount).toBe(4);
    expect(acct.leftover.count).toBe(2);
    expect(acct.leftover.oldestDate).toBe("2026-11-20");
    expect(acct.leftover.symbols).toEqual(["CCC", "DDD"]);
    expect(acct.leftover.items).toEqual([
      { symbol: "CCC", asOfDate: "2026-11-20" },
      { symbol: "DDD", asOfDate: "2026-11-20" },
    ]);
    expect(f.leftoverCount).toBe(2);
    expect(f.oldestCountedLiveDate).toBe("2026-11-20");
    expect(f.newestDate).toBe(TODAY);
    expect(f.level).toBe("bad");
  });

  it("a Plaid-fed account's statement bond and cash rows are statement rows, not leftovers", () => {
    const a = security("AAA", { type: "ETF" });
    const bond = security("BND1", { type: "Bond", maturity: "2030-06-30" });
    const mmf = security("MMF1", { type: "Money Market" });
    hold(1, a, TODAY, plaid(1, a, TODAY));
    hold(1, bond, "2026-10-31", "canonical:hold:1:BND1:2026-10-31", 10);
    hold(1, mmf, "2026-10-31", "vanguard-pdf:holding:1:MMF1:2026-10-31", 1000);

    const f = getPositionsFreshness(db, [1], TODAY);
    const acct = f.accounts[0];
    expect(acct.liveSource).toBe("Plaid");
    expect(acct.newestLiveDate).toBe(TODAY);
    expect(acct.liveRowCount).toBe(1);
    expect(acct.leftover.count).toBe(0);
    expect(acct.statementRows.count).toBe(2);
    expect(acct.statementRows.oldestDate).toBe("2026-10-31");
    expect(acct.statementRows.newestDate).toBe("2026-10-31");
    expect(acct.statementRows.symbols).toEqual(["BND1", "MMF1"]);
    expect(f.statementRowCount).toBe(2);
    expect(f.leftoverCount).toBe(0);
    expect(f.oldestCountedLiveDate).toBe(TODAY);
    expect(f.level).toBe("good");
  });

  it("a defined empty scope reads no account", () => {
    const a = security("AAA");
    hold(3, a, TODAY, tws(3, a, TODAY));
    const f = getPositionsFreshness(db, [], TODAY);
    expect(f.accounts).toEqual([]);
    expect(f.newestDate).toBeNull();
    expect(f.oldestCountedLiveDate).toBeNull();
    expect(f.leftoverCount).toBe(0);
    expect(f.statementRowCount).toBe(0);
  });

  it("an expired option, a matured bond and a zero-quantity tombstone are not counted", () => {
    const a = security("AAA");
    const opt = security("AAA   261113C00100000", { type: "Option", expiration: "2026-11-13" });
    const bond = security("BND2", { type: "Bond", maturity: "2026-11-15" });
    const c = security("CCC");
    hold(3, a, TODAY, tws(3, a, TODAY));
    // Expired option left from an older sync: not a held name.
    hold(3, opt, "2026-11-12", tws(3, opt, "2026-11-12"), 1);
    // Matured bond on the statement: not a held name.
    hold(3, bond, "2026-10-31", "ibkr:pos:3:BND2:2026-10-31", 10);
    // CCC was closed and the reconciler wrote its tombstone today.
    hold(3, c, "2026-11-20", tws(3, c, "2026-11-20"));
    hold(3, c, TODAY, `recon:closed-equity:3:${c}:${TODAY}:live`, 0);

    const f = getPositionsFreshness(db, [3], TODAY);
    const acct = f.accounts[0];
    expect(acct.liveRowCount).toBe(1);
    expect(acct.leftover.count).toBe(0);
    expect(acct.statementRows.count).toBe(0);
    expect(f.level).toBe("good");
  });

  it("a multi-account scope reads each listed account and no other", () => {
    const a = security("AAA");
    const b = security("BBB");
    const c = security("CCC");
    hold(1, a, TODAY, plaid(1, a, TODAY));
    hold(3, b, TODAY, tws(3, b, TODAY));
    hold(3, c, "2026-11-19", tws(3, c, "2026-11-19"));
    // Account 2 is outside the scope: its old row must not show.
    const d = security("DDD");
    hold(2, d, "2026-11-02", plaid(2, d, "2026-11-02"));

    const f = getPositionsFreshness(db, [1, 3], TODAY);
    expect(f.accounts.map((x) => x.accountId)).toEqual([1, 3]);
    expect(f.leftoverCount).toBe(1);
    expect(f.oldestCountedLiveDate).toBe("2026-11-19");
    expect(f.level).toBe("bad");

    const every = getPositionsFreshness(db, undefined, TODAY);
    expect(every.accounts.map((x) => x.accountId)).toEqual([1, 2, 3]);
  });

  it("a live date from the previous trading session is still good (weekend between)", () => {
    const a = security("AAA");
    hold(3, a, "2026-11-20", tws(3, a, "2026-11-20"));
    const f = getPositionsFreshness(db, [3], TODAY);
    expect(f.level).toBe("good");
  });

  it("a live date older than the previous trading session reads warn", () => {
    const a = security("AAA");
    hold(3, a, "2026-11-18", tws(3, a, "2026-11-18"));
    const f = getPositionsFreshness(db, [3], TODAY);
    expect(f.accounts[0].level).toBe("warn");
    expect(f.level).toBe("warn");
  });

  it("a scope with only statement rows reads warn", () => {
    const bond = security("BND1", { type: "Bond", maturity: "2030-06-30" });
    hold(2, bond, "2026-10-31", "vanguard-pdf:holding:2:BND1:2026-10-31", 10);
    const f = getPositionsFreshness(db, [2], TODAY);
    expect(f.accounts[0].newestLiveDate).toBeNull();
    expect(f.accounts[0].liveSource).toBeNull();
    expect(f.statementRowCount).toBe(1);
    expect(f.newestDate).toBe("2026-10-31");
    expect(f.level).toBe("warn");
  });

  it("is carried on the Analysis trust state", () => {
    const a = security("AAA");
    hold(3, a, TODAY, tws(3, a, TODAY));
    const state = getAnalysisTrustState(db, [3], TODAY);
    expect(state.positionsFreshness.accounts[0].accountId).toBe(3);
    expect(state.positionsFreshness.level).toBe("good");
  });
});
