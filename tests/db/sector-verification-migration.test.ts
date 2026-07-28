// tests/db/sector-verification-migration.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

describe("migration 071 sector verification columns", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
  });

  it("adds nullable sector_source and sector_verified_at to securities", () => {
    const cols = db
      .prepare("SELECT name, [notnull] FROM pragma_table_info('securities')")
      .all() as { name: string; notnull: number }[];
    const byName = new Map(cols.map((c) => [c.name, c]));
    expect(byName.get("sector_source")?.notnull).toBe(0);
    expect(byName.get("sector_verified_at")?.notnull).toBe(0);
  });
});
