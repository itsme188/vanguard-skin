import type Database from "better-sqlite3";

export interface NarrativeRecord {
  scope: string;
  surfaceKey: string;
  weekOf: string; // YYYY-MM-DD Monday
  narrativeMd: string;
  modelUsed: string;
  /**
   * sha256 hex digest of the inputs the prose was generated from
   * (fingerprintNarrativeInputs in lib/compute/analysis-narratives.ts).
   * Omitted/undefined writes NULL — read back as "drifted" (unknown inputs).
   */
  inputFingerprint?: string | null;
}

export interface NarrativeRow extends NarrativeRecord {
  id: number;
  generatedAt: string;
  inputFingerprint: string | null;
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
              model_used AS modelUsed, input_fingerprint AS inputFingerprint
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
    `INSERT INTO analysis_narratives (scope, surface_key, week_of, narrative_md, generated_at, model_used, input_fingerprint)
     VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
     ON CONFLICT(scope, surface_key, week_of) DO UPDATE SET
       narrative_md = excluded.narrative_md,
       generated_at = excluded.generated_at,
       model_used = excluded.model_used,
       input_fingerprint = excluded.input_fingerprint`
  ).run(
    rec.scope,
    rec.surfaceKey,
    rec.weekOf,
    rec.narrativeMd,
    rec.modelUsed,
    rec.inputFingerprint ?? null
  );
}

/**
 * Has the world moved since this narrative was written?
 *
 * The cache is keyed on (scope, surface, week) only, so a Monday narrative is
 * served all week even after the hedge book changes underneath it — the
 * defect behind the "cached narrative says 30% protected, card says 11%"
 * finding. Comparing the stored fingerprint against a freshly-computed one
 * detects that without regenerating anything.
 *
 * Fail-safe by design — "drifted" is the answer whenever freshness cannot be
 * PROVEN:
 *   - no cached row        → false (nothing stale is on screen to warn about)
 *   - stored NULL          → true  (legacy row; its inputs were never recorded)
 *   - current unknown/null → true  (inputs couldn't be recomputed; never claim
 *                                   fresh on unverified evidence)
 *   - otherwise            → string inequality
 */
export function isNarrativeDrifted(
  row: Pick<NarrativeRow, "inputFingerprint"> | null | undefined,
  currentFingerprint: string | null | undefined
): boolean {
  if (!row) return false;
  if (row.inputFingerprint == null) return true;
  if (currentFingerprint == null) return true;
  return row.inputFingerprint !== currentFingerprint;
}
