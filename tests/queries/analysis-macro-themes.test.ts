import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

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
