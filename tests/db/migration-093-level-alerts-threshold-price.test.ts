/**
 * Ledger finding
 * alerts-inbox--ma-alert-card-shows-stale-creation-price-and-ai-repeats-it-regression-1
 * (user ruling 2026-09-14): "Moving-average alerts store the resolved
 * threshold at fire time (migration + alert-insert mutation); old rows render
 * effective_price; stale AI sentences age out, no repair script."
 *
 * 093 is the migration half of that ruling: one nullable REAL column on
 * level_alerts. Nullable on purpose — an alert fired before this migration
 * has no recorded fire-time threshold and must stay NULL so the read side can
 * tell "not recorded" apart from a real figure and say so on the card. A
 * DEFAULT would forge one.
 *
 * Additive-migration rehearsal, in miniature (the table-rebuild recipe in
 * CLAUDE.md, applied to an ALTER … ADD COLUMN): build the schema as it stood
 * BEFORE 093, seed rows, apply 093, and prove every pre-existing column of
 * every pre-existing row is byte-identical afterwards, with the new column
 * NULL. Synthetic identifiers and figures only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "lib/db/migrations");
const MIGRATION = "093_level_alerts_threshold_price.sql";

/**
 * The migrations directory truncated to everything numbered BELOW 093 — i.e.
 * the schema as it stood at 092. Filtering by numeric prefix rather than by
 * filename keeps this test stable while sibling branches add 094+.
 */
function migrationsBefore093(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vgs-mig-092-"));
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
    if (!f.endsWith(".sql")) continue;
    if (Number.parseInt(f.slice(0, 3), 10) >= 93) continue;
    fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  ).map((c) => c.name);
}

/** One JSON line per row over the NAMED columns only, so the new column
 *  cannot mask a change to an old one. */
function digest(db: Database.Database, cols: string[]): string[] {
  return (
    db
      .prepare(`SELECT * FROM level_alerts ORDER BY id`)
      .all() as Array<Record<string, unknown>>
  ).map((row) =>
    JSON.stringify(Object.fromEntries(cols.map((c) => [c, row[c] ?? null]))),
  );
}

let db: Database.Database;
let workspace: { dir: string; cleanup: () => void };

beforeEach(() => {
  workspace = migrationsBefore093();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  // PASS 1 — the database as it stands at 092, with rows in it.
  runMigrations(db, { migrationsDir: workspace.dir, codeMigrations: {} });

  const secId = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type) VALUES ('QSYNTH', 'Synthetic Co', 'stock')",
    )
    .run().lastInsertRowid as number;
  const levelId = db
    .prepare(
      `INSERT INTO security_levels (security_id, level_type, price, price_source)
       VALUES (?, 'support', 40, 'sma_9')`,
    )
    .run(secId).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price, suggested_action)
     VALUES (?, ?, '2026-01-02T15:00:00.000Z', 41, 'synthetic sentence')`,
  ).run(levelId, secId);
});

afterEach(() => {
  db.close();
  workspace.cleanup();
});

describe("migration 093 — level_alerts.threshold_price", () => {
  it("adds a nullable threshold_price column, leaving pre-existing rows NULL", () => {
    const before = columnsOf(db, "level_alerts");
    expect(before).not.toContain("threshold_price");
    const beforeDigest = digest(db, before);

    // PASS 2 — the real migrations directory, which now carries 093.
    runMigrations(db, { codeMigrations: {} });

    const after = columnsOf(db, "level_alerts");
    expect(after).toContain("threshold_price");
    // Every pre-093 column survives, in place, with identical contents.
    expect(after.slice(0, before.length)).toEqual(before);
    expect(digest(db, before)).toEqual(beforeDigest);

    const row = db
      .prepare("SELECT threshold_price FROM level_alerts ORDER BY id LIMIT 1")
      .get() as { threshold_price: number | null };
    expect(row.threshold_price).toBeNull();
  });

  it("is recorded in schema_migrations and leaves the schema sound", () => {
    runMigrations(db, { codeMigrations: {} });

    const applied = (
      db.prepare("SELECT filename FROM schema_migrations").all() as Array<{
        filename: string;
      }>
    ).map((r) => r.filename);
    expect(applied).toContain(MIGRATION);

    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("accepts a stored threshold and reads it back as a real number", () => {
    runMigrations(db, { codeMigrations: {} });
    db.prepare("UPDATE level_alerts SET threshold_price = 39.5").run();
    const row = db
      .prepare("SELECT threshold_price FROM level_alerts ORDER BY id LIMIT 1")
      .get() as { threshold_price: number | null };
    expect(row.threshold_price).toBeCloseTo(39.5, 6);
  });
});
