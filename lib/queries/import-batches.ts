import type Database from "better-sqlite3";
import type { ImportBatch } from "@/lib/types";

export function getAllImportBatches(db: Database.Database): ImportBatch[] {
  return db
    .prepare("SELECT * FROM import_batches ORDER BY created_at DESC")
    .all() as ImportBatch[];
}

export function getImportBatchById(db: Database.Database, id: number): ImportBatch | null {
  return (db.prepare("SELECT * FROM import_batches WHERE id = ?").get(id) as ImportBatch) ?? null;
}
