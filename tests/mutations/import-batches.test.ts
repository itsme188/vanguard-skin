import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  createImportBatch,
  completeImportBatch,
  deleteImportBatch,
} from "@/lib/mutations/import-batches";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";

function seedFullImport(db: Database.Database): number {
  const batch = createImportBatch(db, "test-import", "test.csv");

  // Add a security
  db.prepare(
    "INSERT OR IGNORE INTO securities (symbol, name) VALUES (?, ?)"
  ).run("VTI", "Vanguard Total Market");
  const secId = (
    db.prepare("SELECT id FROM securities WHERE symbol = ?").get("VTI") as {
      id: number;
    }
  ).id;

  // Add a BUY transaction
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, import_batch_id, trade_date, type, quantity, price_per_share, amount, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(1, secId, batch.id, "2025-01-15", "BUY", 100, 200, -20000, "txn-test-buy");

  // Add holdings
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, import_batch_id, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(1, secId, 100, "2025-01-31", batch.id, "hold-test-1");

  // Add price
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, import_batch_id) VALUES (?, ?, ?, ?)"
  ).run(secId, "2025-01-31", 210, batch.id);

  // Add snapshot
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, import_batch_id)
     VALUES (?, ?, ?, ?)`
  ).run(1, "2025-01-31", 21000, batch.id);

  completeImportBatch(db, batch.id, 4, "Test import");

  return batch.id;
}

describe("deleteImportBatch", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("removes transactions and associated data", () => {
    const batchId = seedFullImport(db);

    // Verify data exists
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM transactions").get() as any).c
    ).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM holdings").get() as any).c
    ).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM prices").get() as any).c
    ).toBe(1);

    deleteImportBatch(db, batchId);

    // Verify all data removed
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM transactions").get() as any).c
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM holdings").get() as any).c
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM prices").get() as any).c
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM monthly_snapshots").get() as any).c
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM import_batches").get() as any).c
    ).toBe(0);
  });

  it("succeeds even when tax_lots reference the transactions", () => {
    const batchId = seedFullImport(db);

    // Compute tax lots — this creates tax_lots with FK to transactions
    const result = computeTaxLots(db);
    expect(result.lotsCreated).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM tax_lots").get() as any).c
    ).toBe(1);

    // Undo should NOT throw FK violation
    expect(() => deleteImportBatch(db, batchId)).not.toThrow();

    // All data should be gone
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM tax_lots").get() as any).c
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM transactions").get() as any).c
    ).toBe(0);
  });

  it("clears daily_valuations", () => {
    const batchId = seedFullImport(db);

    // Manually insert a daily valuation
    db.prepare(
      "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (?, ?, ?, ?, ?)"
    ).run(1, "2025-01-31", 0, 21000, 21000);
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM daily_valuations").get() as any).c
    ).toBe(1);

    deleteImportBatch(db, batchId);

    expect(
      (db.prepare("SELECT COUNT(*) as c FROM daily_valuations").get() as any).c
    ).toBe(0);
  });

  it("allows re-import and recompute after undo", () => {
    const batchId = seedFullImport(db);
    computeTaxLots(db);
    deleteImportBatch(db, batchId);

    // Re-import same data
    const newBatchId = seedFullImport(db);
    expect(newBatchId).toBeGreaterThan(batchId);

    // Recompute tax lots
    const result = computeTaxLots(db);
    expect(result.lotsCreated).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) as c FROM tax_lots").get() as any).c
    ).toBe(1);
  });
});

/**
 * Task 4 (reconciler hardening, spec §4): `deleteImportBatch` owns BOTH the
 * holdings and the price side of tax-generation invalidation, so every caller
 * — undoImport AND the scripts that call it directly (e.g.
 * scripts/rebuild-ibkr-ledger.ts) — is covered. Holdings rows feed
 * computeTaxLots' RECONCILE_CLOSE synthesis (a deleted holdings row can
 * create or destroy a synthetic close); a deleted `prices` row can change the
 * price that synthetic close is struck at.
 */
describe("deleteImportBatch — tax generation invalidation", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function seedSecurity(symbol: string): number {
    return db
      .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')")
      .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
  }

  it("bumps the tax generation when it deletes holdings rows", () => {
    const batch = createImportBatch(db, "test-import", "holdings-only.csv");
    const secId = seedSecurity("VTI");
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, import_batch_id, source_key)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(1, secId, 100, "2026-06-30", batch.id, "canonical:hold:t:VTI:2026-06-30");
    completeImportBatch(db, batch.id, 1, "1 holdings");

    const before = getTaxInputGeneration(db);
    deleteImportBatch(db, batch.id);
    expect(getTaxInputGeneration(db)).toBe(before + 1);
  });

  it("does not bump when the batch carried nothing tax-relevant", () => {
    const batch = createImportBatch(db, "test-import", "snapshot-only.csv");
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, import_batch_id)
       VALUES (?, ?, ?, ?)`
    ).run(1, "2026-06-30", 12345, batch.id);
    completeImportBatch(db, batch.id, 1, "1 snapshots");

    const before = getTaxInputGeneration(db);
    deleteImportBatch(db, batch.id);
    expect(getTaxInputGeneration(db)).toBe(before);
  });

  it("bumps when a deleted price could re-strike a tombstoned security's synthetic close", () => {
    const secId = seedSecurity("SOLD");
    // Latest holdings row for (account 1, SOLD) is a tombstone: the security
    // is in synthetic-close state, priced off the latest price at-or-before
    // the zero date.
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 0, ?, ?)`
    ).run(1, secId, "2026-06-30", "recon:closed-equity:1:1:2026-06-30:stmt");

    const batch = createImportBatch(db, "test-import", "prices-only.csv");
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, import_batch_id) VALUES (?, ?, ?, ?)"
    ).run(secId, "2026-06-15", 42, batch.id);
    completeImportBatch(db, batch.id, 1, "1 prices");

    const before = getTaxInputGeneration(db);
    deleteImportBatch(db, batch.id);
    expect(getTaxInputGeneration(db)).toBe(before + 1);
  });

  it("does not bump when the deleted price belongs to a still-held security", () => {
    const secId = seedSecurity("HELD");
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 100, ?, ?)`
    ).run(1, secId, "2026-06-30", "canonical:hold:t:HELD:2026-06-30");

    const batch = createImportBatch(db, "test-import", "prices-only.csv");
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, import_batch_id) VALUES (?, ?, ?, ?)"
    ).run(secId, "2026-06-15", 42, batch.id);
    completeImportBatch(db, batch.id, 1, "1 prices");

    const before = getTaxInputGeneration(db);
    deleteImportBatch(db, batch.id);
    expect(getTaxInputGeneration(db)).toBe(before);
  });
});
