import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "@/lib/db/migrate";

const MIGRATIONS_DIR = join(__dirname, "../../lib/db/migrations");

/** Apply migrations strictly below the given number, in order. */
function migrateBelow(db: Database.Database, stopAt: number) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const n = parseInt(f.slice(0, 3), 10);
    if (n >= stopAt) break;
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
  }
}

describe("migration 078: corporate_actions import columns", () => {
  it("applies cleanly over a populated 077 database (upgrade path)", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrateBelow(db, 78);
    // legacy manual row exists BEFORE 078 runs
    db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
    const secId = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source)
       VALUES (?, 'SPLIT', '2026-04-21', 8, 1, 1, 'manual')`,
    ).run(secId);

    db.exec(readFileSync(join(MIGRATIONS_DIR, "078_corporate_actions_import.sql"), "utf-8"));

    const cols = (db.prepare("PRAGMA table_info(corporate_actions)").all() as { name: string }[]).map((c) => c.name);
    for (const col of ["source_key", "import_batch_id", "account_id", "quantity_delta", "reconcile_delta"]) {
      expect(cols).toContain(col);
    }
    // legacy row untouched, new columns NULL
    const row = db.prepare("SELECT source_key, reconcile_delta, ratio_numerator FROM corporate_actions").get() as Record<string, unknown>;
    expect(row.source_key).toBeNull();
    expect(row.reconcile_delta).toBeNull();
    expect(row.ratio_numerator).toBe(8);
    // FK integrity holds after the upgrade
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("full runMigrations path exposes the columns and the partial unique index", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
    const secId = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
    const ins = db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source, source_key)
       VALUES (?, 'SPLIT', ?, 4, 1, 0, 'import', ?)`,
    );
    ins.run(secId, "2026-07-01", "ibkr:ca:split:2026-07-01:AAAA:4:1");
    expect(() => ins.run(secId, "2026-07-02", "ibkr:ca:split:2026-07-01:AAAA:4:1")).toThrow(/UNIQUE/);
    // NULL source_keys coexist (manual rows) — different dates to dodge the business key
    db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source)
       VALUES (?, 'SPLIT', '2026-07-03', 2, 1, 1, 'manual')`,
    ).run(secId);
    db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source)
       VALUES (?, 'SPLIT', '2026-07-04', 2, 1, 1, 'manual')`,
    ).run(secId);
  });
});
