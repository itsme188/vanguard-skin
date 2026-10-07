/**
 * Migration 095: lot_basis_verifications.
 *
 * One row per acquisition transaction whose (very small) basis the owner has
 * checked against a source document. Additive and data-free: a new table, no
 * existing row touched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const FILE = "095_lot_basis_verifications.sql";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

function seedTxn(sourceKey: string): number {
  const sec = db.prepare("INSERT INTO securities (symbol, currency) VALUES (?, 'USD')").run(`ZZ${sourceKey}`)
    .lastInsertRowid as number;
  return db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (1, ?, '2010-01-10', 'TRANSFER_IN', 100, 0.01, 1, 0, ?)`
    )
    .run(sec, sourceKey).lastInsertRowid as number;
}

const insert = (txnId: number, note: string | null) =>
  db
    .prepare("INSERT INTO lot_basis_verifications (acquisition_transaction_id, source_note) VALUES (?, ?)")
    .run(txnId, note);

describe("migration 095", () => {
  it("is recorded as applied", () => {
    const row = db.prepare("SELECT filename FROM schema_migrations WHERE filename LIKE '095%'").get() as
      | { filename: string }
      | undefined;
    expect(row?.filename).toBe(FILE);
  });

  it("creates the approved columns", () => {
    const cols = db.prepare("PRAGMA table_info(lot_basis_verifications)").all() as {
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }[];
    expect(cols.map((c) => [c.name, c.type, c.notnull, c.pk])).toEqual([
      ["id", "INTEGER", 0, 1],
      ["acquisition_transaction_id", "INTEGER", 1, 0],
      ["source_note", "TEXT", 1, 0],
      ["verified_amount", "REAL", 0, 0],
      ["verified_quantity", "REAL", 0, 0],
      ["verified_at", "TEXT", 1, 0],
    ]);
  });

  it("stamps the verification time itself, in SQLite's datetime shape", () => {
    insert(seedTxn("A"), "synthetic source");
    const row = db.prepare("SELECT verified_at, verified_amount, verified_quantity FROM lot_basis_verifications").get() as {
      verified_at: string;
      verified_amount: number | null;
      verified_quantity: number | null;
    };
    expect(row.verified_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(row.verified_amount).toBeNull();
    expect(row.verified_quantity).toBeNull();
  });

  it("allows one marker per acquisition transaction", () => {
    const txn = seedTxn("A");
    insert(txn, "first");
    expect(() => insert(txn, "second")).toThrow(/UNIQUE constraint failed/i);
  });

  it("refuses a missing, empty or whitespace-only note", () => {
    const txn = seedTxn("A");
    expect(() => insert(txn, null)).toThrow(/NOT NULL constraint failed/i);
    expect(() => insert(txn, "")).toThrow(/CHECK constraint failed/i);
    expect(() => insert(txn, "    ")).toThrow(/CHECK constraint failed/i);
  });

  it("refuses a marker for a transaction that does not exist", () => {
    expect(() => insert(999999, "synthetic source")).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("deleting the transaction removes its marker (ON DELETE CASCADE)", () => {
    const keep = seedTxn("A");
    const drop = seedTxn("B");
    insert(keep, "kept");
    insert(drop, "dropped");
    db.prepare("DELETE FROM transactions WHERE id = ?").run(drop);
    expect(db.prepare("SELECT acquisition_transaction_id AS id FROM lot_basis_verifications").all()).toEqual([
      { id: keep },
    ]);
  });

  it("applies on a database that already holds data, and changes none of it", () => {
    // Roll this database back to "094 applied", fill it, then migrate again.
    db.exec("DROP TABLE lot_basis_verifications");
    db.prepare("DELETE FROM schema_migrations WHERE filename = ?").run(FILE);
    const txn = seedTxn("A");
    seedTxn("B");
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as { name: string }[]
    )
      .map((t) => t.name)
      .filter((name) => name !== "schema_migrations");
    const digest = () => JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()]));
    const before = digest();
    // Autoincrement counters of every data table (the runner's own bookkeeping
    // table gains a row, and the new table gains a counter only on first insert).
    const sequences = () =>
      db
        .prepare(
          "SELECT name, seq FROM sqlite_sequence WHERE name NOT IN ('schema_migrations', 'lot_basis_verifications') ORDER BY name"
        )
        .all();
    const sequenceBefore = sequences();

    runMigrations(db);

    expect(digest()).toBe(before);
    expect(sequences()).toEqual(sequenceBefore);
    expect(db.prepare("SELECT COUNT(*) AS c FROM lot_basis_verifications").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM schema_migrations WHERE filename = ?").get(FILE)).toEqual({ c: 1 });
    expect(() => insert(txn, "synthetic source")).not.toThrow();
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
  });
});
