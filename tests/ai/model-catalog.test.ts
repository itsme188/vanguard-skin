import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  getModelCatalog,
  setModelCatalog,
  isModelCatalogStale,
} from "@/lib/ai/model-catalog";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)",
  );
  return db;
}

describe("model-catalog", () => {
  let db: Database.Database;
  beforeEach(() => { db = freshDb(); });

  it("returns [] when unset", () => {
    expect(getModelCatalog(db)).toEqual([]);
  });
  it("returns [] (not throw) when settings table is missing", () => {
    const bare = new Database(":memory:");
    expect(getModelCatalog(bare)).toEqual([]);
  });
  it("round-trips a catalog and reports fresh", () => {
    setModelCatalog(db, ["claude-opus-4-8", "claude-sonnet-4-6"]);
    expect(getModelCatalog(db)).toEqual(["claude-opus-4-8", "claude-sonnet-4-6"]);
    expect(isModelCatalogStale(db)).toBe(false);
  });
  it("is stale when never set", () => {
    expect(isModelCatalogStale(db)).toBe(true);
  });
  it("is stale when older than the guard window", () => {
    setModelCatalog(db, ["claude-opus-4-8"]);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'model_catalog_updated_at'")
      .run(new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString());
    expect(isModelCatalogStale(db)).toBe(true);
  });
});
