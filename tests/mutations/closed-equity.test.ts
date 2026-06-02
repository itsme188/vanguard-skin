import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { reconcileClosedEquityHoldings } from "@/lib/mutations/closed-equity";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function acct(name: string): number {
  return (
    db.prepare(
      `INSERT INTO accounts (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id`,
    ).get(name) as { id: number }
  ).id;
}
function sec(symbol: string, type = "stock"): number {
  return (
    db.prepare(
      `INSERT INTO securities (symbol, security_type) VALUES (?, ?) RETURNING id`,
    ).get(symbol, type) as { id: number }
  ).id;
}
function hold(a: number, s: number, qty: number, date: string): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(a, s, qty, date, `seed:${a}:${s}:${date}`);
}
function latestQty(a: number, s: number): { q: number; d: string } {
  return db.prepare(
    `SELECT quantity q, as_of_date d FROM holdings WHERE account_id=? AND security_id=? ORDER BY as_of_date DESC LIMIT 1`,
  ).get(a, s) as { q: number; d: string };
}

describe("reconcileClosedEquityHoldings", () => {
  it("marks an equity absent from the latest snapshot flat (zero-row at snapshot date)", () => {
    const a = acct("IBKR");
    const held = sec("HELD");
    const gone = sec("GONE");
    // prior snapshot 05-01: both held
    hold(a, held, 100, "2026-05-01");
    hold(a, gone, 50, "2026-05-01");
    // latest snapshot 06-02: only HELD present (GONE was sold → absent)
    hold(a, held, 100, "2026-06-02");

    const n = reconcileClosedEquityHoldings(db);
    expect(n).toBe(1);
    // GONE now has a zero-qty row dated to the latest snapshot
    const g = latestQty(a, gone);
    expect(g.q).toBe(0);
    expect(g.d).toBe("2026-06-02");
    // HELD untouched
    expect(latestQty(a, held).q).toBe(100);
  });

  it("does not touch a position present in the latest snapshot", () => {
    const a = acct("IBKR");
    const held = sec("HELD");
    hold(a, held, 100, "2026-05-01");
    hold(a, held, 120, "2026-06-02");
    expect(reconcileClosedEquityHoldings(db)).toBe(0);
    expect(latestQty(a, held).q).toBe(120);
  });

  it("SHRINK GUARD: skips when the latest snapshot is <50% of the prior (partial/failed sync)", () => {
    const a = acct("IBKR");
    const ids = Array.from({ length: 10 }, (_, i) => sec(`S${i}`));
    // prior 05-01: all 10 held
    ids.forEach((s) => hold(a, s, 100, "2026-05-01"));
    // latest 06-02: only 2 present (looks like a broken/partial snapshot)
    hold(a, ids[0], 100, "2026-06-02");
    hold(a, ids[1], 100, "2026-06-02");

    expect(reconcileClosedEquityHoldings(db)).toBe(0); // refuse to wipe the other 8
    // the 8 absent ones are NOT zeroed — their latest stays the 05-01 row
    expect(latestQty(a, ids[5]).q).toBe(100);
    expect(latestQty(a, ids[5]).d).toBe("2026-05-01");
  });

  it("does NOT touch non-equity (options/bonds handled by sibling purges)", () => {
    const a = acct("IBKR");
    const held = sec("HELD");
    const held2 = sec("HELD2");
    const opt = sec("OPT1", "option");
    const bond = sec("BOND1", "bond");
    // prior 05-01: 2 stocks + opt + bond (4). latest 06-02: both stocks (2) →
    // 2 of 4 is not below the 50% shrink floor, so reconciliation runs; the
    // absent opt + bond must be ignored purely on the equity-type filter.
    hold(a, held, 100, "2026-05-01");
    hold(a, held2, 100, "2026-05-01");
    hold(a, opt, 5, "2026-05-01");
    hold(a, bond, 10, "2026-05-01");
    hold(a, held, 100, "2026-06-02");
    hold(a, held2, 100, "2026-06-02");
    expect(reconcileClosedEquityHoldings(db)).toBe(0); // opt + bond absent but not equities
    expect(latestQty(a, opt).q).toBe(5);
    expect(latestQty(a, bond).q).toBe(10);
  });

  it("is idempotent — a second run makes no further changes", () => {
    const a = acct("IBKR");
    const held = sec("HELD");
    const gone = sec("GONE");
    hold(a, held, 100, "2026-05-01");
    hold(a, gone, 50, "2026-05-01");
    hold(a, held, 100, "2026-06-02");
    expect(reconcileClosedEquityHoldings(db)).toBe(1);
    expect(reconcileClosedEquityHoldings(db)).toBe(0);
  });

  it("treats ETF like stock", () => {
    const a = acct("IBKR");
    const held = sec("HELD");
    const etf = sec("ARKK", "etf");
    hold(a, held, 100, "2026-05-01");
    hold(a, etf, 500, "2026-05-01");
    hold(a, held, 100, "2026-06-02");
    expect(reconcileClosedEquityHoldings(db)).toBe(1);
    expect(latestQty(a, etf).q).toBe(0);
  });

  it("scopes to a single account when accountId is given", () => {
    const ibkr = acct("IBKR");
    const van = acct("Vanguard Taxable");
    const g1 = sec("GONE1");
    const g2 = sec("GONE2");
    const h1 = sec("HELD1");
    const h2 = sec("HELD2");
    // IBKR: GONE1 dropped from latest
    hold(ibkr, g1, 50, "2026-05-01"); hold(ibkr, h1, 100, "2026-05-01"); hold(ibkr, h1, 100, "2026-06-02");
    // Vanguard: GONE2 dropped from latest
    hold(van, g2, 50, "2026-05-01"); hold(van, h2, 100, "2026-05-01"); hold(van, h2, 100, "2026-06-02");
    expect(reconcileClosedEquityHoldings(db, { accountId: ibkr })).toBe(1);
    expect(latestQty(ibkr, g1).q).toBe(0);
    expect(latestQty(van, g2).q).toBe(50); // untouched — different account
  });

  it("no-ops on an account with only one snapshot (nothing absent)", () => {
    const a = acct("IBKR");
    const s1 = sec("A"); const s2 = sec("B");
    hold(a, s1, 100, "2026-06-02"); hold(a, s2, 50, "2026-06-02");
    expect(reconcileClosedEquityHoldings(db)).toBe(0);
  });
});
