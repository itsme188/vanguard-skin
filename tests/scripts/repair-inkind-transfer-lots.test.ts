import { describe, it, expect } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import type Database from "better-sqlite3";
import {
  applyInKindLots,
  canonicalKey,
  planInKindLots,
  validateConfig,
  type InKindLotConfig,
} from "@/scripts/repair-inkind-transfer-lots";

// Minimal schema: only the tables the planner and applier touch.
function fresh(): Database.Database {
  const db = new BetterSqlite3(":memory:");
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE securities (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, name TEXT, security_type TEXT);
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, security_id INTEGER,
      import_batch_id INTEGER, trade_date TEXT NOT NULL, settlement_date TEXT, type TEXT NOT NULL,
      quantity REAL, amount REAL, price_per_share REAL, fees REAL, is_external_flow INTEGER DEFAULT 0,
      source_key TEXT UNIQUE, notes TEXT
    );
    CREATE TABLE donation_lots (id INTEGER PRIMARY KEY AUTOINCREMENT, donation_id INTEGER NOT NULL,
      acquisition_transaction_id INTEGER NOT NULL, quantity REAL NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO settings (key, value) VALUES ('tax_input_generation', '5');
    INSERT INTO accounts (id, name) VALUES (1, 'Taxable');
    INSERT INTO securities (id, symbol, name, security_type) VALUES (10, 'ZBAS', 'Zbas Inc', 'Stock');
  `);
  return db;
}

// Synthetic figures only.
const CONFIG: InKindLotConfig = {
  account: "Taxable",
  symbol: "ZBAS",
  existingTransactionId: 1,
  source: "fund tax estimate (synthetic)",
  lots: [
    { acquisitionDate: "2012-01-10", quantity: 500, basisPerShare: 0.02 },
    { acquisitionDate: "2013-06-01", quantity: 80, basisPerShare: 0.5 },
    { acquisitionDate: "2016-03-15", quantity: 40, basisPerShare: 25 },
  ],
};

function seedExisting(db: Database.Database, quantity = 300): void {
  db.prepare(
    `INSERT INTO transactions (id, account_id, security_id, import_batch_id, trade_date, type, quantity, amount, price_per_share, is_external_flow, source_key, notes)
     VALUES (1, 1, 10, 7, '2012-01-10', 'TRANSFER_IN', ?, ?, 0.02, 1, ?, 'guessed')`
  ).run(quantity, Math.round(quantity * 0.02 * 100) / 100, canonicalKey("Taxable", "ZBAS", "2012-01-10", quantity * 0.02));
}

describe("validateConfig", () => {
  it("accepts the documented shape and rejects duplicate lot dates", () => {
    expect(validateConfig(CONFIG)).toEqual(CONFIG);
    expect(() =>
      validateConfig({ ...CONFIG, lots: [CONFIG.lots[0], { ...CONFIG.lots[0] }] })
    ).toThrow(/distinct/);
    expect(() => validateConfig({ ...CONFIG, lots: [] })).toThrow(/non-empty/);
  });
});

describe("planInKindLots", () => {
  it("plans an in-place update to lot[0] plus one insert per further lot, keyed canonically", () => {
    const db = fresh();
    seedExisting(db);
    const plan = planInKindLots(db, CONFIG);
    expect(plan.ok).toBe(true);
    expect(plan.status).toBe("repair");
    expect(plan.update).toMatchObject({ id: 1, quantity: 500, price: 0.02, amount: 10 });
    expect(plan.update!.sourceKey).toBe("canonical:txn:Taxable:ZBAS:2012-01-10:TRANSFER_IN:1000");
    expect(plan.inserts).toHaveLength(2);
    expect(plan.inserts![0]).toMatchObject({ tradeDate: "2013-06-01", quantity: 80, amount: 40 });
    expect(plan.inserts![1]).toMatchObject({ tradeDate: "2016-03-15", quantity: 40, amount: 1000 });
    expect(plan.inserts![1].sourceKey).toBe("canonical:txn:Taxable:ZBAS:2016-03-15:TRANSFER_IN:100000");
  });

  it("refuses when the existing row is not a TRANSFER_IN, is the wrong instrument, or is dated off lot[0]", () => {
    const db = fresh();
    seedExisting(db);
    db.prepare("UPDATE transactions SET type = 'BUY' WHERE id = 1").run();
    expect(planInKindLots(db, CONFIG)).toMatchObject({ ok: false, reason: expect.stringMatching(/not TRANSFER_IN/) });
    db.prepare("UPDATE transactions SET type = 'TRANSFER_IN' WHERE id = 1").run();
    expect(planInKindLots(db, { ...CONFIG, symbol: "QXTT" })).toMatchObject({ ok: false, reason: expect.stringMatching(/config says/) });
    expect(
      planInKindLots(db, { ...CONFIG, lots: [{ ...CONFIG.lots[1] }, CONFIG.lots[0], CONFIG.lots[2]] })
    ).toMatchObject({ ok: false, reason: expect.stringMatching(/lots\[0\] must be the existing row/) });
  });

  it("refuses when donation assignments already exceed lot[0]", () => {
    const db = fresh();
    seedExisting(db);
    db.prepare("INSERT INTO donation_lots (donation_id, acquisition_transaction_id, quantity) VALUES (1, 1, 501)").run();
    expect(planInKindLots(db, CONFIG)).toMatchObject({ ok: false, reason: expect.stringMatching(/assignments/) });
  });

  it("refuses when a target source_key already belongs to a different-quantity row", () => {
    const db = fresh();
    seedExisting(db);
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, price_per_share, source_key)
       VALUES (1, 10, '2013-06-01', 'TRANSFER_IN', 79, 40, 0.5, ?)`
    ).run(canonicalKey("Taxable", "ZBAS", "2013-06-01", 40));
    expect(planInKindLots(db, CONFIG)).toMatchObject({ ok: false, reason: expect.stringMatching(/exists on transaction/) });
  });
});

describe("applyInKindLots", () => {
  it("rewrites the row set, keeps the existing id (so assignments stay valid), bumps the generation, and is idempotent", () => {
    const db = fresh();
    seedExisting(db);
    db.prepare("INSERT INTO donation_lots (donation_id, acquisition_transaction_id, quantity) VALUES (1, 1, 250)").run();

    const plan = planInKindLots(db, CONFIG);
    const result = applyInKindLots(db, CONFIG, plan);
    expect(result).toEqual({ updated: 1, inserted: 2 });

    const rows = db
      .prepare(`SELECT id, trade_date, quantity, amount, price_per_share, import_batch_id, is_external_flow FROM transactions WHERE security_id = 10 ORDER BY trade_date`)
      .all() as { id: number; trade_date: string; quantity: number; amount: number; price_per_share: number; import_batch_id: number; is_external_flow: number }[];
    expect(rows.map((r) => [r.trade_date, r.quantity, r.amount])).toEqual([
      ["2012-01-10", 500, 10],
      ["2013-06-01", 80, 40],
      ["2016-03-15", 40, 1000],
    ]);
    expect(rows[0].id).toBe(1);
    // inserted rows inherit the batch and external-flow flag of the original
    expect(rows[1].import_batch_id).toBe(7);
    expect(rows[1].is_external_flow).toBe(1);
    // total shares equal the fund's distribution
    expect(rows.reduce((s, r) => s + r.quantity, 0)).toBe(620);
    expect((db.prepare("SELECT value FROM settings WHERE key = 'tax_input_generation'").get() as { value: string }).value).toBe("6");

    expect(planInKindLots(db, CONFIG)).toMatchObject({ ok: true, status: "already-repaired" });
  });
});
