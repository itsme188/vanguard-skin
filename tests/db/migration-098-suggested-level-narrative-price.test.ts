/**
 * 098: suggested_level_narratives.detected_price, the security's price (native
 * currency) when the narrative was written, so the card can say "Detected
 * <day> at <price>:". Additive and nullable: rows written before it stay NULL
 * (a default would forge a price). Synthetic figures only.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "lib/db/migrations");

function migrationsBefore098(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vgs-mig-097-"));
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
    if (!f.endsWith(".sql")) continue;
    if (Number.parseInt(f.slice(0, 3), 10) >= 98) continue;
    fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const cols = (db: Database.Database) =>
  (db.prepare("PRAGMA table_info(suggested_level_narratives)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );

describe("migration 098 - suggested_level_narratives.detected_price", () => {
  it("exists on a fresh database as a nullable REAL with no default", () => {
    const db = new Database(":memory:");
    runMigrations(db, { codeMigrations: {} });
    const col = (
      db.prepare("PRAGMA table_info(suggested_level_narratives)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: unknown;
      }>
    ).find((c) => c.name === "detected_price");
    expect(col).toBeDefined();
    expect(col!.type).toBe("REAL");
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
    db.close();
  });

  it("keeps an existing row intact with detected_price NULL", () => {
    const ws = migrationsBefore098();
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db, { migrationsDir: ws.dir, codeMigrations: {} });
    expect(cols(db)).not.toContain("detected_price");
    const secId = db
      .prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('ZZA', 'Synthetic', 'stock')")
      .run().lastInsertRowid as number;
    db.prepare(
      `INSERT INTO suggested_level_narratives (security_id, level_price, direction, narrative, computed_at_day)
       VALUES (?, 50, 'support', 'old sentence', '2026-09-01')`,
    ).run(secId);

    runMigrations(db, { codeMigrations: {} });

    const row = db.prepare("SELECT * FROM suggested_level_narratives").get() as Record<string, unknown>;
    expect(row.narrative).toBe("old sentence");
    expect(row.level_price).toBe(50);
    expect(row.computed_at_day).toBe("2026-09-01");
    expect(row.detected_price).toBeNull();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    ws.cleanup();
    db.close();
  });
});
