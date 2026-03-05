import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  createImportBatch,
  completeImportBatch,
  deleteImportBatch,
} from "@/lib/mutations/import-batches";
import { computeTaxLots } from "@/lib/compute/tax-lots";

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
