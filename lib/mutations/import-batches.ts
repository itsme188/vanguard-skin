import type Database from "better-sqlite3";
import type { ImportBatch } from "@/lib/types";

export function createImportBatch(
  db: Database.Database,
  sourceType: string,
  filename?: string
): ImportBatch {
  const result = db
    .prepare("INSERT INTO import_batches (source_type, filename) VALUES (?, ?)")
    .run(sourceType, filename ?? null);

  return db
    .prepare("SELECT * FROM import_batches WHERE id = ?")
    .get(result.lastInsertRowid) as ImportBatch;
}

export function completeImportBatch(
  db: Database.Database,
  batchId: number,
  recordCount: number,
  summary?: string
): void {
  db.prepare(
    "UPDATE import_batches SET status = 'completed', record_count = ?, summary = ? WHERE id = ?"
  ).run(recordCount, summary ?? null, batchId);
}

export function deleteImportBatch(db: Database.Database, batchId: number): void {
  db.transaction(() => {
    // Clear derived data first (tax lots reference transactions via FK)
    // These are fully recomputed by computeTaxLots() and computeDailyValuations()
    db.prepare("DELETE FROM tax_lot_sales").run();
    db.prepare("DELETE FROM tax_lots").run();
    db.prepare("DELETE FROM daily_valuations").run();
    // Delete source data in dependency order (children first)
    db.prepare("DELETE FROM raw_imports WHERE import_batch_id = ?").run(batchId);
    db.prepare("DELETE FROM prices WHERE import_batch_id = ?").run(batchId);
    db.prepare("DELETE FROM holdings WHERE import_batch_id = ?").run(batchId);
    db.prepare("DELETE FROM transactions WHERE import_batch_id = ?").run(batchId);
    db.prepare("DELETE FROM monthly_snapshots WHERE import_batch_id = ?").run(batchId);
    db.prepare("DELETE FROM import_batches WHERE id = ?").run(batchId);
  })();
}
