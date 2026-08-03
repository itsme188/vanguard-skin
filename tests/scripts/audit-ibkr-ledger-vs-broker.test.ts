import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { auditLedgerVsBroker } from "@/scripts/audit-ibkr-ledger-vs-broker";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db); // seeds accounts: 'Vanguard Taxable', 'Vanguard Roth IRA', 'IBKR'
  return db;
}

function getIbkrAccountId(db: Database.Database): number {
  return (
    db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }
  ).id;
}

function ensureSecurity(db: Database.Database, symbol: string): number {
  db.prepare(
    "INSERT OR IGNORE INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')"
  ).run(symbol, symbol);
  return (
    db.prepare("SELECT id FROM securities WHERE symbol = ?").get(symbol) as {
      id: number;
    }
  ).id;
}

let txnCounter = 0;

/** Inserts one transaction row with an auto-generated unique source_key
 * (transactions.source_key is UNIQUE) — quantity/type/trade_date are the
 * only columns the audit reads. */
function txn(
  db: Database.Database,
  accountId: number,
  securityId: number,
  tradeDate: string,
  type: string,
  quantity: number
): void {
  txnCounter++;
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(accountId, securityId, tradeDate, type, quantity, `test:txn:${txnCounter}`);
}

/** Inserts one broker-shaped holdings row. Caller controls the source_key
 * prefix so tests can exercise the tws-/ibkr:/recon:/plaid: filter. */
function holding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
  sourceKey: string
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, asOfDate, sourceKey);
}

describe("auditLedgerVsBroker", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    txnCounter = 0;
  });

  it("splits a clean pair from a gapped pair", () => {
    const ibkr = getIbkrAccountId(db);
    const clean = ensureSecurity(db, "CLN");
    const gap = ensureSecurity(db, "GAP");

    // CLN: bought 100 well before the broker snapshot — reconciles exactly.
    txn(db, ibkr, clean, "2026-01-01", "BUY", 100);
    holding(db, ibkr, clean, 100, "2026-03-01", `tws-${ibkr}-${clean}-2026-03-01`);

    // GAP: ledger only shows 40 bought, but broker reports 100 — a real gap.
    txn(db, ibkr, gap, "2026-01-01", "BUY", 40);
    holding(db, ibkr, gap, 100, "2026-03-01", `tws-${ibkr}-${gap}-2026-03-01`);

    const r = auditLedgerVsBroker(db);

    expect(r.pairs).toBe(2);
    expect(r.clean).toBe(1);
    expect(r.gapped).toHaveLength(1);
    expect(r.gapped[0]).toMatchObject({
      symbol: "GAP",
      date: "2026-03-01",
      broker: 100,
      ledger: 40,
      gap: 60,
    });
  });

  it("tolerates same-day trade ambiguity", () => {
    // broker row 2026-04-22 qty -1000; trades: SELL 1000 on 04-21, BUY 1000 on 04-22
    // include-04-22 -> 0, exclude-04-22 -> -1000: matches broker -> clean
    const ibkr = getIbkrAccountId(db);
    const aal = ensureSecurity(db, "AAL");

    txn(db, ibkr, aal, "2026-04-21", "SELL", 1000);
    txn(db, ibkr, aal, "2026-04-22", "BUY", 1000);
    holding(db, ibkr, aal, -1000, "2026-04-22", `ibkr:pos:2026-04-22:AAL`);

    const r = auditLedgerVsBroker(db);

    expect(r.gapped).toHaveLength(0);
    expect(r.pairs).toBe(1); // AAL has only one broker row -> one evaluation point
    expect(r.clean).toBe(1);
  });

  it("does NOT paper over a genuine same-day mismatch (both variants wrong)", () => {
    // broker row says -500, but neither including nor excluding the
    // same-day trade gets anywhere close — this must still be reported.
    const ibkr = getIbkrAccountId(db);
    const sym = ensureSecurity(db, "BAD");

    txn(db, ibkr, sym, "2026-05-01", "BUY", 100); // long before the broker row
    txn(db, ibkr, sym, "2026-05-10", "BUY", 50); // same-day trade
    holding(db, ibkr, sym, -500, "2026-05-10", `tws-${ibkr}-${sym}-2026-05-10`);

    const r = auditLedgerVsBroker(db);

    // include: 100+50=150; exclude: 100. Neither is close to broker's -500.
    expect(r.gapped).toHaveLength(1);
    expect(r.gapped[0].symbol).toBe("BAD");
    // exclude (100) is the closer of the two -> reported ledger/gap use it
    expect(r.gapped[0].ledger).toBe(100);
    expect(r.gapped[0].gap).toBe(-600);
  });

  it("excludes recon: tombstones and plaid: rows from the broker-row universe", () => {
    const ibkr = getIbkrAccountId(db);
    const reconSym = ensureSecurity(db, "RECON");
    const plaidSym = ensureSecurity(db, "PLAID");

    // Ledger disagrees with BOTH of these rows on purpose — if either were
    // treated as a genuine broker row, it would produce a gapped entry.
    txn(db, ibkr, reconSym, "2026-01-01", "BUY", 75);
    holding(db, ibkr, reconSym, 0, "2026-04-01", "recon:closed-equity:1:2:2026-04-01");

    txn(db, ibkr, plaidSym, "2026-01-01", "BUY", 30);
    holding(db, ibkr, plaidSym, 999, "2026-04-01", "plaid:acct:sec:2026-04-01");

    const r = auditLedgerVsBroker(db);

    expect(r.pairs).toBe(0);
    expect(r.clean).toBe(0);
    expect(r.gapped).toHaveLength(0);
  });

  it("evaluates exactly the latest row and the row nearest 2026-06-30, ignoring others", () => {
    const ibkr = getIbkrAccountId(db);
    const sym = ensureSecurity(db, "MULTI");

    // Ledger: 100 shares by 2026-01-15, +50 more by 2026-07-15 (total 150).
    txn(db, ibkr, sym, "2026-01-15", "BUY", 100);
    txn(db, ibkr, sym, "2026-07-15", "BUY", 50);

    // Middle row is deliberately WRONG (ledger@02-01 is already 100, not
    // 50) — if the audit mistakenly evaluated every broker row instead of
    // just latest + nearest-to-06-30, this would surface as a spurious gap.
    holding(db, ibkr, sym, 50, "2026-02-01", `tws-${ibkr}-${sym}-2026-02-01`);
    // Nearest to 2026-06-30 (2 days away) — matches ledger (100).
    holding(db, ibkr, sym, 100, "2026-06-28", `tws-${ibkr}-${sym}-2026-06-28`);
    // Latest (also matches ledger: 150).
    holding(db, ibkr, sym, 150, "2026-08-01", `tws-${ibkr}-${sym}-2026-08-01`);

    const r = auditLedgerVsBroker(db);

    expect(r.pairs).toBe(2);
    expect(r.clean).toBe(2);
    expect(r.gapped).toHaveLength(0);
  });

  it("dedupes when the latest row is also the row nearest 2026-06-30 (single broker row)", () => {
    const ibkr = getIbkrAccountId(db);
    const sym = ensureSecurity(db, "ONE");

    txn(db, ibkr, sym, "2026-01-01", "BUY", 10);
    holding(db, ibkr, sym, 10, "2026-03-01", `tws-${ibkr}-${sym}-2026-03-01`);

    const r = auditLedgerVsBroker(db);

    expect(r.pairs).toBe(1);
    expect(r.clean).toBe(1);
  });

  it("--as-of tolerates lag since the last statement (excludes later broker rows)", () => {
    const ibkr = getIbkrAccountId(db);
    const sym = ensureSecurity(db, "LAG");

    // Reconciles cleanly through the last full statement...
    txn(db, ibkr, sym, "2026-01-01", "BUY", 100);
    holding(db, ibkr, sym, 100, "2026-06-30", `tws-${ibkr}-${sym}-2026-06-30`);

    // ...but a later TWS row is deliberately WRONG (ledger hasn't caught up
    // to August activity yet) — this would gate-fail without --as-of.
    holding(db, ibkr, sym, 999, "2026-08-01", `tws-${ibkr}-${sym}-2026-08-01`);

    const withoutAsOf = auditLedgerVsBroker(db);
    expect(withoutAsOf.gapped).toHaveLength(1);
    expect(withoutAsOf.gapped[0].date).toBe("2026-08-01");

    const withAsOf = auditLedgerVsBroker(db, { asOf: "2026-07-31" });
    expect(withAsOf.gapped).toHaveLength(0);
    expect(withAsOf.pairs).toBe(1);
  });

  it("rejects a malformed --as-of value", () => {
    expect(() => auditLedgerVsBroker(db, { asOf: "07/31/2026" })).toThrow(/YYYY-MM-DD/);
  });

  it("returns zero results when no IBKR-named account exists", () => {
    db.prepare("DELETE FROM accounts WHERE name = 'IBKR'").run();
    const r = auditLedgerVsBroker(db);
    expect(r).toEqual({ pairs: 0, clean: 0, gapped: [] });
  });

  it("sorts gapped rows by |gap| descending", () => {
    const ibkr = getIbkrAccountId(db);
    const small = ensureSecurity(db, "SMALL");
    const big = ensureSecurity(db, "BIG");

    txn(db, ibkr, small, "2026-01-01", "BUY", 90);
    holding(db, ibkr, small, 100, "2026-03-01", `tws-${ibkr}-${small}-2026-03-01`); // gap 10

    txn(db, ibkr, big, "2026-01-01", "BUY", 10);
    holding(db, ibkr, big, 100, "2026-03-01", `tws-${ibkr}-${big}-2026-03-01`); // gap 90

    const r = auditLedgerVsBroker(db);

    expect(r.gapped).toHaveLength(2);
    expect(r.gapped[0].symbol).toBe("BIG");
    expect(r.gapped[1].symbol).toBe("SMALL");
  });
});
