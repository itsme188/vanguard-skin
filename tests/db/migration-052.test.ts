import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

describe("migration 052: analysis_narratives", () => {
  it("creates the analysis_narratives table with the expected schema", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    // Verify table columns
    const cols = db
      .prepare("PRAGMA table_info(analysis_narratives)")
      .all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

    // runMigrations applies EVERY migration, so this list is the table's
    // present-day shape, not 052's original one. 087 appended the nullable
    // input_fingerprint column (cache-invalidation-on-drift).
    expect(cols.map((c) => c.name)).toEqual([
      "id",
      "scope",
      "surface_key",
      "week_of",
      "narrative_md",
      "generated_at",
      "model_used",
      "input_fingerprint",
    ]);

    // Verify id is primary key
    const idCol = cols.find((c) => c.name === "id");
    expect(idCol?.pk).toBe(1);

    // Verify NOT NULL constraints on required columns
    expect(cols.find((c) => c.name === "scope")?.notnull).toBe(1);
    expect(cols.find((c) => c.name === "surface_key")?.notnull).toBe(1);
    expect(cols.find((c) => c.name === "week_of")?.notnull).toBe(1);
    expect(cols.find((c) => c.name === "narrative_md")?.notnull).toBe(1);
    expect(cols.find((c) => c.name === "generated_at")?.notnull).toBe(1);
    expect(cols.find((c) => c.name === "model_used")?.notnull).toBe(1);
  });

  it("creates the idx_analysis_narratives_scope_week index", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    const indexes = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='analysis_narratives'"
      )
      .all() as Array<{ name: string }>;

    expect(indexes.some((i) => i.name === "idx_analysis_narratives_scope_week"))
      .toBe(true);
  });

  it("enforces UNIQUE (scope, surface_key, week_of) constraint", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    const insert = db.prepare(
      `INSERT INTO analysis_narratives (scope, surface_key, week_of, narrative_md, generated_at, model_used)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    insert.run("all", "factor-analysis", "2026-05-05", "Test narrative", "2026-05-10T00:00:00Z", "sonnet-4.6");

    // Second insert with same (scope, surface_key, week_of) should fail
    expect(() => {
      insert.run("all", "factor-analysis", "2026-05-05", "Another narrative", "2026-05-10T00:00:00Z", "sonnet-4.6");
    }).toThrow();
  });

  it("allows inserts with different (scope, surface_key, week_of) combinations", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    const insert = db.prepare(
      `INSERT INTO analysis_narratives (scope, surface_key, week_of, narrative_md, generated_at, model_used)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    insert.run("all", "factor-analysis", "2026-05-05", "Narrative 1", "2026-05-10T00:00:00Z", "sonnet-4.6");
    insert.run("vanguard", "factor-analysis", "2026-05-05", "Narrative 2", "2026-05-10T00:00:00Z", "sonnet-4.6");
    insert.run("all", "risk-metrics", "2026-05-05", "Narrative 3", "2026-05-10T00:00:00Z", "sonnet-4.6");
    insert.run("all", "factor-analysis", "2026-05-12", "Narrative 4", "2026-05-10T00:00:00Z", "sonnet-4.6");

    const rows = db
      .prepare("SELECT COUNT(*) as count FROM analysis_narratives")
      .get() as { count: number };

    expect(rows.count).toBe(4);
  });
});
