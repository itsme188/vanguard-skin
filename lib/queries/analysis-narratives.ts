import type Database from "better-sqlite3";

export interface NarrativeRecord {
  scope: string;
  surfaceKey: string;
  weekOf: string; // YYYY-MM-DD Monday
  narrativeMd: string;
  modelUsed: string;
}

export interface NarrativeRow extends NarrativeRecord {
  id: number;
  generatedAt: string;
}

/**
 * Returns the cached narrative for (scope, surfaceKey, weekOf) or null.
 */
export function getCachedNarrative(
  db: Database.Database,
  scope: string,
  surfaceKey: string,
  weekOf: string
): NarrativeRow | null {
  const row = db
    .prepare(
      `SELECT id, scope, surface_key AS surfaceKey, week_of AS weekOf,
              narrative_md AS narrativeMd, generated_at AS generatedAt,
              model_used AS modelUsed
         FROM analysis_narratives
        WHERE scope = ? AND surface_key = ? AND week_of = ?`
    )
    .get(scope, surfaceKey, weekOf) as NarrativeRow | undefined;
  return row ?? null;
}

/**
 * Idempotent UPSERT — second write replaces first.
 * Sets generated_at = datetime('now').
 */
export function upsertNarrative(
  db: Database.Database,
  rec: NarrativeRecord
): void {
  db.prepare(
    `INSERT INTO analysis_narratives (scope, surface_key, week_of, narrative_md, generated_at, model_used)
     VALUES (?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(scope, surface_key, week_of) DO UPDATE SET
       narrative_md = excluded.narrative_md,
       generated_at = excluded.generated_at,
       model_used = excluded.model_used`
  ).run(rec.scope, rec.surfaceKey, rec.weekOf, rec.narrativeMd, rec.modelUsed);
}
