import type Database from "better-sqlite3";

export interface CachedMacroThemes {
  scope: string;
  weekOf: string;
  themesJson: string;
  sourceSummary: string | null;
  generatedAt: string;
  modelUsed: string;
}

export interface UpsertMacroThemesInput {
  scope: string;
  weekOf: string;
  themesJson: string;
  sourceSummary: string | null;
  modelUsed: string;
}

export function getCachedMacroThemes(
  db: Database.Database,
  scope: string,
  weekOf: string
): CachedMacroThemes | null {
  const row = db.prepare(
    `SELECT scope, week_of, themes_json, source_summary, generated_at, model_used
     FROM analysis_macro_themes
     WHERE scope = ? AND week_of = ?`
  ).get(scope, weekOf) as
    | { scope: string; week_of: string; themes_json: string; source_summary: string | null; generated_at: string; model_used: string }
    | undefined;
  if (!row) return null;
  return {
    scope: row.scope,
    weekOf: row.week_of,
    themesJson: row.themes_json,
    sourceSummary: row.source_summary,
    generatedAt: row.generated_at,
    modelUsed: row.model_used,
  };
}

export function upsertMacroThemes(
  db: Database.Database,
  input: UpsertMacroThemesInput
): void {
  db.prepare(
    `INSERT INTO analysis_macro_themes
       (scope, week_of, themes_json, source_summary, generated_at, model_used)
     VALUES (?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(week_of, scope) DO UPDATE SET
       themes_json = excluded.themes_json,
       source_summary = excluded.source_summary,
       generated_at = excluded.generated_at,
       model_used = excluded.model_used`
  ).run(input.scope, input.weekOf, input.themesJson, input.sourceSummary, input.modelUsed);
}
