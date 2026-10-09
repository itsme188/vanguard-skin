/**
 * Migration 097 (owner rulings 2026-10-08): two nullable columns on
 * calendar_events.
 *
 *   actual_refused_reason  why a macro actual was refused and stored empty
 *   reference_period       the data period the actual refers to, from FRED's
 *                          observation date ("2026-08", "2026-Q2", or a
 *                          week-ending date)
 *
 * Additive only. The rehearsal below builds the schema as it stood BEFORE
 * 097, seeds a row, applies 097, and proves the old row survives with every
 * old column unchanged and both new columns NULL. Synthetic values only.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "lib/db/migrations");
const MIGRATION = "097_calendar_events_macro_basis.sql";
const NEW_COLUMNS = ["actual_refused_reason", "reference_period"];

/** Every .sql migration numbered BELOW 097, copied to a temp directory. */
function migrationsBefore097(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vgs-mig-096-"));
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
    if (!f.endsWith(".sql")) continue;
    if (Number.parseInt(f.slice(0, 3), 10) >= 97) continue;
    fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function columnsOf(db: Database.Database): Array<{ name: string; notnull: number; dflt_value: unknown }> {
  return db.prepare(`PRAGMA table_info(calendar_events)`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: unknown;
  }>;
}

function digest(db: Database.Database, cols: string[]): string[] {
  return (
    db.prepare(`SELECT * FROM calendar_events ORDER BY id`).all() as Array<Record<string, unknown>>
  ).map((row) => JSON.stringify(Object.fromEntries(cols.map((c) => [c, row[c] ?? null]))));
}

let db: Database.Database;
let workspace: { dir: string; cleanup: () => void };

beforeEach(() => {
  workspace = migrationsBefore097();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  // PASS 1: the database as it stands before 097, with a row in the table.
  runMigrations(db, { migrationsDir: workspace.dir, codeMigrations: {} });
  db.prepare(
    `INSERT INTO calendar_events
       (source, event_type, event_date, event_time, release_time, title,
        consensus_estimate, previous_value, actual_value, source_key, week_of)
     VALUES ('claude_macro', 'cpi', '2026-01-14', '08:30', '08:30', 'Synthetic Price Index',
             '0.3%', '0.2%', '0.4%', 'fred:46:2026-01-14', '2026-01-12')`,
  ).run();
});

afterEach(() => {
  db.close();
  workspace.cleanup();
});

describe("migration 097: calendar_events macro basis columns", () => {
  it("adds both columns as nullable with no default, leaving the old row intact", () => {
    const before = columnsOf(db).map((c) => c.name);
    for (const col of NEW_COLUMNS) expect(before).not.toContain(col);
    const beforeDigest = digest(db, before);

    // PASS 2: the real migrations directory, which carries 097.
    runMigrations(db, { codeMigrations: {} });

    const after = columnsOf(db);
    const afterNames = after.map((c) => c.name);
    for (const col of NEW_COLUMNS) {
      expect(afterNames).toContain(col);
      const info = after.find((c) => c.name === col)!;
      expect(info.notnull).toBe(0);
      expect(info.dflt_value).toBeNull();
    }
    // Every earlier column keeps its contents.
    expect(digest(db, before)).toEqual(beforeDigest);
    expect(db.prepare("SELECT COUNT(*) AS n FROM calendar_events").get()).toEqual({ n: 1 });

    const row = db
      .prepare("SELECT actual_value, actual_refused_reason, reference_period FROM calendar_events")
      .get();
    expect(row).toEqual({
      actual_value: "0.4%",
      actual_refused_reason: null,
      reference_period: null,
    });
  });

  it("is recorded in schema_migrations and leaves the schema sound", () => {
    runMigrations(db, { codeMigrations: {} });
    const applied = (
      db.prepare("SELECT filename FROM schema_migrations").all() as Array<{ filename: string }>
    ).map((r) => r.filename);
    expect(applied).toContain(MIGRATION);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("lands on a fresh database and both columns accept text", () => {
    const fresh = new Database(":memory:");
    fresh.pragma("foreign_keys = ON");
    runMigrations(fresh);
    fresh
      .prepare(
        `INSERT INTO calendar_events
           (source, event_type, event_date, title, source_key, actual_refused_reason, reference_period)
         VALUES ('claude_macro', 'cpi', '2026-01-14', 'Synthetic Price Index', 'fred:46:2026-01-14',
                 'synthetic reason', '2025-12')`,
      )
      .run();
    expect(
      fresh.prepare("SELECT actual_refused_reason, reference_period FROM calendar_events").get(),
    ).toEqual({ actual_refused_reason: "synthetic reason", reference_period: "2025-12" });
    fresh.close();
  });

  it("is a plain column append: no table rebuild, no data statement, no PRAGMA", () => {
    const sql = fs
      .readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    const statements = sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2);
    for (const s of statements) {
      expect(s).toMatch(/^ALTER TABLE calendar_events ADD COLUMN \w+ TEXT$/);
    }
  });
});
