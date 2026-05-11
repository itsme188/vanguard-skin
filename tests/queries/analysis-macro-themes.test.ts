import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getCachedMacroThemes,
  upsertMacroThemes,
} from "@/lib/queries/analysis-macro-themes";

describe("migration 053", () => {
  it("creates analysis_macro_themes table with UNIQUE (week_of, scope)", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info(analysis_macro_themes)").all();
    const names = cols.map((c: any) => c.name);
    expect(names).toEqual(expect.arrayContaining([
      "id", "week_of", "scope", "themes_json",
      "source_summary", "generated_at", "model_used",
    ]));
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='analysis_macro_themes'").all();
    expect(JSON.stringify(idx)).toContain("week_of");
  });
});

describe("analysis-macro-themes queries", () => {
  function fresh() {
    const db = new Database(":memory:");
    runMigrations(db);
    return db;
  }

  it("returns null when nothing cached", () => {
    const db = fresh();
    expect(getCachedMacroThemes(db, "all", "2026-05-04")).toBeNull();
  });

  it("inserts then reads back", () => {
    const db = fresh();
    upsertMacroThemes(db, {
      scope: "all", weekOf: "2026-05-04",
      themesJson: '[{"name":"X","direction":"risk-on"}]',
      sourceSummary: '{"articles":[]}',
      modelUsed: "claude-sonnet-4-6",
    });
    const got = getCachedMacroThemes(db, "all", "2026-05-04");
    expect(got).not.toBeNull();
    expect(got!.themesJson).toContain("risk-on");
    expect(got!.modelUsed).toBe("claude-sonnet-4-6");
  });

  it("UPSERT updates an existing (scope, week) row", () => {
    const db = fresh();
    upsertMacroThemes(db, { scope: "all", weekOf: "2026-05-04", themesJson: "[]", sourceSummary: null, modelUsed: "v1" });
    upsertMacroThemes(db, { scope: "all", weekOf: "2026-05-04", themesJson: '[{"name":"Y"}]', sourceSummary: null, modelUsed: "v2" });
    const rows = db.prepare("SELECT COUNT(*) as n FROM analysis_macro_themes WHERE scope='all' AND week_of='2026-05-04'").get() as { n: number };
    expect(rows.n).toBe(1);
    const got = getCachedMacroThemes(db, "all", "2026-05-04");
    expect(got!.modelUsed).toBe("v2");
    expect(got!.themesJson).toContain("Y");
  });
});
