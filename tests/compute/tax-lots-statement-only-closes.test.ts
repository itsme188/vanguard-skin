/**
 * Statement-only synthetic closes (spec
 * docs/superpowers/specs/2026-10-02-statement-only-synthetic-closes-design.md,
 * user ruling 2026-10-02, option A).
 *
 * computeTaxLots' broker-close pass anchors on the pair's NEWEST
 * STATEMENT-GRADE holdings row (statement prefix, `:stmt` tombstone or legacy
 * unsuffixed tombstone). Only when that row is flat does it mint a
 * RECONCILE_CLOSE. A position that went flat only in a live snapshot (TWS /
 * IBKR Web API / Plaid, or a `:live` tombstone) keeps its open lots.
 *
 * Synthetic tickers and round numbers only.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { ledgerDigest } from "../setup/ledger-digest";

// Migrations seed the account rows; the existing tests use id 1.
const ACCOUNT = 1;
let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function sec(symbol: string, type = "Stock"): number {
  return (
    db
      .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?) RETURNING id")
      .get(symbol, `${symbol} Corp`, type) as { id: number }
  ).id;
}

let seq = 0;
function txn(securityId: number, date: string, type: string, qty: number, price: number): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(ACCOUNT, securityId, date, type, qty, price, (type === "SELL" ? 1 : -1) * qty * price, `zz:${type}:${date}:${seq++}`);
}

type Origin = "stmt-row" | "stmt-tomb" | "legacy-tomb" | "live-tomb" | "tws" | "plaid";
function hold(securityId: number, qty: number, date: string, origin: Origin): void {
  const key = {
    "stmt-row": `ibkr:pos:${ACCOUNT}:${securityId}:${date}`,
    "stmt-tomb": `recon:closed-equity:${ACCOUNT}:${securityId}:${date}:stmt`,
    "legacy-tomb": `recon:closed-equity:${ACCOUNT}:${securityId}:${date}`,
    "live-tomb": `recon:closed-equity:${ACCOUNT}:${securityId}:${date}:live`,
    tws: `tws-${ACCOUNT}-${securityId}-${date}`,
    plaid: `plaid:${ACCOUNT}:${securityId}:${date}`,
  }[origin];
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, 0, ?, ?)`,
  ).run(ACCOUNT, securityId, qty, date, key);
}

function price(securityId: number, date: string, p: number): void {
  db.prepare("INSERT OR REPLACE INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')").run(
    securityId,
    date,
    p,
  );
}

function synthetic(securityId: number) {
  return db
    .prepare(
      "SELECT trade_date, quantity, price_per_share, source_key FROM transactions WHERE type = 'RECONCILE_CLOSE' AND security_id = ?",
    )
    .all(securityId) as { trade_date: string; quantity: number; price_per_share: number; source_key: string }[];
}

function openQty(securityId: number): number {
  return (
    db
      .prepare("SELECT COALESCE(SUM(quantity_remaining), 0) AS q FROM tax_lots WHERE security_id = ?")
      .get(securityId) as { q: number }
  ).q;
}

describe("engine gate: statement evidence only", () => {
  it("invariant 1 — a live-only flat (:live tombstone newest) mints nothing; lots stay open", () => {
    const s = sec("ZZLIVE");
    txn(s, "2026-01-05", "BUY", 100, 10);
    hold(s, 100, "2026-01-31", "stmt-row");
    hold(s, 0, "2026-02-10", "live-tomb");
    price(s, "2026-02-10", 12);

    computeTaxLots(db);

    expect(synthetic(s)).toEqual([]);
    expect(openQty(s)).toBe(100);
  });

  it.each(["tws", "plaid"] as const)("a live %s zero row as newest mints nothing", (origin) => {
    const s = sec(`ZZ${origin.toUpperCase()}`);
    txn(s, "2026-01-05", "BUY", 100, 10);
    hold(s, 100, "2026-01-31", "stmt-row");
    hold(s, 0, "2026-02-10", origin);

    computeTaxLots(db);

    expect(synthetic(s)).toEqual([]);
    expect(openQty(s)).toBe(100);
  });

  it.each(["stmt-tomb", "legacy-tomb", "stmt-row"] as const)(
    "invariant 2 — a statement-grade zero (%s) as the newest statement-grade row mints a close at its date",
    (origin) => {
      const s = sec("ZZFLAT");
      txn(s, "2026-01-05", "BUY", 100, 10);
      hold(s, 100, "2026-01-31", "stmt-row");
      hold(s, 0, "2026-02-28", origin);
      price(s, "2026-02-27", 12);

      computeTaxLots(db);

      expect(synthetic(s)).toEqual([
        {
          trade_date: "2026-02-28",
          quantity: 100,
          price_per_share: 12,
          source_key: `reconcile:close:${ACCOUNT}:${s}:2026-02-28`,
        },
      ]);
      expect(openQty(s)).toBe(0);
    },
  );

  it("a statement showing the position HELD after an older statement zero mints nothing", () => {
    const s = sec("ZZBACK");
    txn(s, "2026-01-05", "BUY", 100, 10);
    hold(s, 0, "2026-01-31", "stmt-tomb");
    hold(s, 100, "2026-02-28", "stmt-row");

    computeTaxLots(db);

    expect(synthetic(s)).toEqual([]);
    expect(openQty(s)).toBe(100);
  });

  it("invariant 3 — statement zero older, live re-buy row newer, no imported fill after: close still minted at the statement date", () => {
    const s = sec("ZZREBUY");
    txn(s, "2026-01-05", "BUY", 100, 10);
    hold(s, 0, "2026-01-31", "stmt-tomb");
    hold(s, 50, "2026-02-15", "tws"); // live re-buy, fills not imported
    price(s, "2026-01-30", 11);

    computeTaxLots(db);

    expect(synthetic(s).map((r) => r.trade_date)).toEqual(["2026-01-31"]);
    expect(openQty(s)).toBe(0);
  });

  it("a live :live tombstone newer than a statement zero does not move the close date", () => {
    const s = sec("ZZMOVE");
    txn(s, "2026-01-05", "BUY", 100, 10);
    hold(s, 0, "2026-01-31", "stmt-tomb");
    hold(s, 50, "2026-02-10", "plaid");
    hold(s, 0, "2026-02-20", "live-tomb");

    computeTaxLots(db);

    expect(synthetic(s).map((r) => r.trade_date)).toEqual(["2026-01-31"]);
  });

  it("an imported fill after the statement zero still suppresses the close (guard unchanged)", () => {
    const s = sec("ZZFRESH");
    txn(s, "2026-01-05", "BUY", 100, 10);
    hold(s, 0, "2026-01-31", "stmt-tomb");
    txn(s, "2026-02-05", "BUY", 10, 11);

    computeTaxLots(db);

    expect(synthetic(s)).toEqual([]);
    expect(openQty(s)).toBe(110);
  });

  it("invariant 4 — the real SELL arriving self-heals the synthetic close", () => {
    const s = sec("ZZHEAL");
    txn(s, "2026-01-05", "BUY", 100, 10);
    hold(s, 0, "2026-01-31", "stmt-tomb");
    computeTaxLots(db);
    expect(synthetic(s)).toHaveLength(1);

    txn(s, "2026-01-20", "SELL", 100, 12);
    computeTaxLots(db);

    expect(synthetic(s)).toEqual([]);
    expect(openQty(s)).toBe(0);
  });

  it("scope unchanged: options and bonds never mint from a statement zero", () => {
    const opt = sec("ZZOPT 260320C00010000", "Option");
    const bond = sec("ZZBOND", "Bond");
    for (const s of [opt, bond]) {
      txn(s, "2026-01-05", "BUY", 1, 5);
      hold(s, 0, "2026-01-31", "stmt-tomb");
    }
    computeTaxLots(db);
    expect(synthetic(opt)).toEqual([]);
    expect(synthetic(bond)).toEqual([]);
  });

  it("invariant 8 — conservation holds per pair: acquired = open + sold (real + synthetic)", () => {
    const flat = sec("ZZCONS");
    const live = sec("ZZCONL");
    for (const s of [flat, live]) {
      txn(s, "2026-01-05", "BUY", 100, 10);
      txn(s, "2026-01-10", "BUY", 50, 11);
      txn(s, "2026-01-15", "SELL", 30, 12);
    }
    hold(flat, 0, "2026-01-31", "stmt-tomb");
    hold(live, 0, "2026-01-31", "live-tomb");

    computeTaxLots(db);

    for (const s of [flat, live]) {
      const acquired = (
        db.prepare("SELECT SUM(quantity_acquired) AS q FROM tax_lots WHERE security_id = ?").get(s) as { q: number }
      ).q;
      const sold = (
        db
          .prepare(
            `SELECT COALESCE(SUM(tls.quantity_sold), 0) AS q FROM tax_lot_sales tls
               JOIN tax_lots tl ON tl.id = tls.tax_lot_id WHERE tl.security_id = ?`,
          )
          .get(s) as { q: number }
      ).q;
      expect(acquired).toBe(150);
      expect(openQty(s) + sold).toBe(acquired);
    }
    expect(openQty(flat)).toBe(0);
    expect(openQty(live)).toBe(120);
  });

  it("two runs on one database are identical by a source_key-keyed digest", () => {
    const a = sec("ZZDIGA");
    const b = sec("ZZDIGB");
    txn(a, "2026-01-05", "BUY", 100, 10);
    txn(b, "2026-01-05", "BUY", 100, 10);
    hold(a, 0, "2026-01-31", "stmt-tomb");
    hold(b, 0, "2026-02-10", "live-tomb");
    price(a, "2026-01-31", 12);

    computeTaxLots(db);
    const first = ledgerDigest(db);
    computeTaxLots(db);
    expect(ledgerDigest(db)).toBe(first);
  });
});
