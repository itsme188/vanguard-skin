/**
 * Read side of per-feature AI model overrides.
 *
 * Storage: `settings` table key `feature_model_overrides`, value is a JSON
 * object mapping FeatureKey → "<provider>/<model-id>" (same spec format as
 * FEATURE_MODELS in lib/ai/models.ts). Overrides are consulted FIRST by
 * resolveFeatureModel; absent keys fall back to the code defaults.
 *
 * This file deliberately imports nothing from lib/ai — lib/db.ts imports it
 * to wire the override source, and keeping it dependency-free rules out
 * import cycles (db → queries → ai → … ).
 */

import type Database from "better-sqlite3";

export const FEATURE_MODEL_OVERRIDES_KEY = "feature_model_overrides";

/**
 * Valid "<provider>/<model-id>" spec. The model-id portion allows further
 * slashes and "@" because Workers AI ids look like
 * "@cf/meta/llama-3.3-70b-instruct" (parseModelSpec splits on the FIRST
 * slash only). No whitespace anywhere.
 */
export const MODEL_OVERRIDE_PATTERN = /^[\w-]+\/[\w.:@/-]+$/;

interface SettingRow {
  value: string;
}

/**
 * Current overrides map. Defensive on every layer — missing settings table
 * (in-memory test DBs), missing row, malformed JSON, or non-conforming
 * entries all degrade to "no override" rather than throwing.
 */
export function getFeatureModelOverrides(
  db: Database.Database,
): Record<string, string> {
  let row: SettingRow | undefined;
  try {
    row = db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(FEATURE_MODEL_OVERRIDES_KEY) as SettingRow | undefined;
  } catch {
    return {};
  }
  if (!row) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string" && MODEL_OVERRIDE_PATTERN.test(value)) {
      out[key] = value;
    }
  }
  return out;
}
