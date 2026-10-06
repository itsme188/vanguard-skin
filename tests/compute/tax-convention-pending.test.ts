/**
 * isTaxConventionPending — the one shared "are these lot-derived dollars
 * still waiting on a recompute?" probe. It fails CLOSED: when the state
 * cannot be read, the cautionary label stays on. It never throws.
 */
import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import {
  bumpTaxInputGeneration,
  isTaxConventionPending,
  stampTaxLotsConvention,
} from "@/lib/compute/tax-convention";
import { getOptionsPnL } from "@/lib/queries/options";
import { getRoundTrips } from "@/lib/compute/trade-roundtrips";

describe("isTaxConventionPending", () => {
  it("follows the recompute marker: pending before a stamp, clear after, pending again after a bump", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
    expect(isTaxConventionPending(db)).toBe(true);
    stampTaxLotsConvention(db);
    expect(isTaxConventionPending(db)).toBe(false);
    bumpTaxInputGeneration(db);
    expect(isTaxConventionPending(db)).toBe(true);
  });

  it("an unreadable settings table reads as pending (fail closed), never throws", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE settings (k TEXT, v TEXT)");
    expect(isTaxConventionPending(db)).toBe(true);
  });

  it("a database that cannot be queried at all reads as pending, never throws", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)");
    stampTaxLotsConvention(db);
    db.close();
    expect(isTaxConventionPending(db)).toBe(true);
  });

  it("a schema with no settings table does not model the marker: not pending", () => {
    const db = new Database(":memory:");
    expect(isTaxConventionPending(db)).toBe(false);
  });
});

describe("consumers keep the cautionary label when the marker is unreadable", () => {
  function brokenSettingsDb() {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    stampTaxLotsConvention(db);
    db.exec("ALTER TABLE settings RENAME COLUMN key TO k");
    return db;
  }

  it("getOptionsPnL still returns its data, labelled pending", () => {
    const db = brokenSettingsDb();
    const result = getOptionsPnL(db);
    expect(result.conventionPending).toBe(true);
    expect(Array.isArray(result.closedTrades)).toBe(true);
  });

  it("getRoundTrips still returns its rows, labelled pending", () => {
    const db = brokenSettingsDb();
    const secId = Number(
      db.prepare("INSERT INTO securities (symbol, security_type) VALUES ('ZZZC', 'Stock')").run().lastInsertRowid
    );
    const txn = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
         VALUES (1, ?, '2026-04-01', 'SELL', 10, 12, 120, 0, 'u12:rt')`
      )
      .run(secId);
    const lot = db
      .prepare(
        `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
         VALUES (1, ?, '2026-01-15', 10, 10, 0, 100)`
      )
      .run(secId);
    db.prepare(
      `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days)
       VALUES (?, ?, '2026-04-01', 10, 12, 120, 100, 20, 0, 76)`
    ).run(lot.lastInsertRowid, txn.lastInsertRowid);
    const rows = getRoundTrips(db, 1, "2026-04-01", "2026-04-30");
    expect(rows).toHaveLength(1);
    expect(rows[0].realizedPnl).toBeCloseTo(20);
    expect(rows[0].conventionPending).toBe(true);
  });
});
