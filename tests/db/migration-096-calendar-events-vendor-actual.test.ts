/**
 * Owner ruling 2026-10-08 (recap scoreboard actuals): "the vendor's actual is
 * kept in a new column. Accepting worksheet figures overwrites the vendor
 * actual today, so there was nothing to footnote. A migration preserves it."
 *
 * 096 is the migration half: one nullable TEXT column on calendar_events.
 * Additive only. Build the schema as it stood BEFORE 096, seed a row, apply
 * 096, and prove every earlier column of that row is byte-identical with the
 * new column NULL. Synthetic identifiers and figures only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";

const MIGRATIONS_DIR = path.resolve(process.cwd(), "lib/db/migrations");
const MIGRATION = "096_calendar_events_vendor_actual.sql";

/** Every migration numbered BELOW 096: the schema as it stood at 095. */
function migrationsBefore096(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vgs-mig-095-"));
  for (const f of fs.readdirSync(MIGRATIONS_DIR)) {
    if (!f.endsWith(".sql")) continue;
    if (Number.parseInt(f.slice(0, 3), 10) >= 96) continue;
    fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f));
  }
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function columnsOf(db: Database.Database): string[] {
  return (
    db.prepare(`PRAGMA table_info(calendar_events)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
}

function digest(db: Database.Database, cols: string[]): string[] {
  return (
    db.prepare(`SELECT * FROM calendar_events ORDER BY id`).all() as Array<
      Record<string, unknown>
    >
  ).map((row) => JSON.stringify(Object.fromEntries(cols.map((c) => [c, row[c] ?? null]))));
}

let db: Database.Database;
let workspace: { dir: string; cleanup: () => void };

beforeEach(() => {
  workspace = migrationsBefore096();
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  // PASS 1: the database as it stands at 095, with rows in it.
  runMigrations(db, { migrationsDir: workspace.dir, codeMigrations: {} });
  db.prepare(
    `INSERT INTO calendar_events
       (source, source_key, event_type, event_date, week_of, title, symbol,
        consensus_estimate, actual_value, manual_actuals_at, enriched_at)
     VALUES ('finnhub', 'finnhub:ZZA:2026-01-06', 'earnings', '2026-01-06', '2026-01-05',
             'ZZA earnings', 'ZZA', 'EPS 1.00 · Rev 500000000',
             'EPS 1.10 · Rev 510000000', '2026-01-06 21:30:00', '2026-01-06 21:10:00')`,
  ).run();
  db.prepare(
    `INSERT INTO calendar_events (source, source_key, event_type, event_date, week_of, title)
     VALUES ('fred', 'fred:synthetic:2026-01-07', 'macro', '2026-01-07', '2026-01-05', 'Synthetic release')`,
  ).run();
});

afterEach(() => {
  db.close();
  workspace.cleanup();
});

describe("migration 096: calendar_events.vendor_actual_value", () => {
  it("adds a nullable TEXT column and leaves every existing row untouched, new column NULL", () => {
    const before = columnsOf(db);
    expect(before).not.toContain("vendor_actual_value");
    const beforeDigest = digest(db, before);
    expect(beforeDigest).toHaveLength(2);

    // PASS 2: the real migrations directory, which now carries 096.
    runMigrations(db, { codeMigrations: {} });

    const info = db.prepare(`PRAGMA table_info(calendar_events)`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const col = info.find((c) => c.name === "vendor_actual_value");
    expect(col).toBeDefined();
    expect(col!.type.toUpperCase()).toBe("TEXT");
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();

    // Every pre-096 column survives with identical contents. (Compared by
    // name, not position: sibling migrations add other columns alongside.)
    const after = columnsOf(db);
    for (const c of before) expect(after).toContain(c);
    expect(digest(db, before)).toEqual(beforeDigest);

    const rows = db
      .prepare("SELECT vendor_actual_value FROM calendar_events ORDER BY id")
      .all() as Array<{ vendor_actual_value: string | null }>;
    expect(rows.map((r) => r.vendor_actual_value)).toEqual([null, null]);
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

  it("a fresh database gets the column too", () => {
    const fresh = new Database(":memory:");
    fresh.pragma("foreign_keys = ON");
    runMigrations(fresh);
    expect(columnsOf(fresh)).toContain("vendor_actual_value");
    fresh.close();
  });

  it("the migration file is one additive statement: no rebuild, rewrite, backfill or PRAGMA", () => {
    const sql = fs
      .readFileSync(path.join(MIGRATIONS_DIR, MIGRATION), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(sql.trim()).toBe("ALTER TABLE calendar_events ADD COLUMN vendor_actual_value TEXT;");
  });
});
