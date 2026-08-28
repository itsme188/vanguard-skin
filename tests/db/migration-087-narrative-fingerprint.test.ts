import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

describe("migration 087: analysis_narratives.input_fingerprint", () => {
  it("adds a nullable input_fingerprint column to analysis_narratives", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(analysis_narratives)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const col = cols.find((c) => c.name === "input_fingerprint");
    expect(col).toBeDefined();
    expect(col?.notnull).toBe(0);
    expect(col?.dflt_value).toBeNull();
  });

  it("leaves pre-migration rows NULL (no backfill — legacy rows read as drifted)", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    db.prepare(
      `INSERT INTO analysis_narratives (scope, surface_key, week_of, narrative_md, generated_at, model_used)
       VALUES ('all','defense','2026-08-24','Legacy prose.', datetime('now'), 'anthropic/claude-sonnet-4-6')`,
    ).run();

    const row = db
      .prepare(
        `SELECT input_fingerprint FROM analysis_narratives WHERE scope='all' AND surface_key='defense'`,
      )
      .get() as { input_fingerprint: string | null };
    expect(row.input_fingerprint).toBeNull();
  });

  it("upgrades a POPULATED database cleanly", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
