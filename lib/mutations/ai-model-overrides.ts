/**
 * Write side of per-feature AI model overrides.
 *
 * setFeatureModelOverride(db, key, model) stores (or, with model = null,
 * clears) one override in the `feature_model_overrides` JSON object inside
 * the settings key-value table, then invalidates the resolver's 30s cache so
 * the change applies to the very next AI call.
 */

import type Database from "better-sqlite3";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { FEATURE_MODELS, parseModelSpec } from "@/lib/ai/models";
import { invalidateFeatureModelOverridesCache } from "@/lib/ai/override-source";
import {
  getFeatureModelOverrides,
  FEATURE_MODEL_OVERRIDES_KEY,
  MODEL_OVERRIDE_PATTERN,
} from "@/lib/queries/ai-model-overrides";

/**
 * Set or clear (model = null) the override for one feature key.
 * Throws on an unknown feature key, a spec that doesn't match
 * "<provider>/<model-id>", or an unsupported provider.
 * Returns the updated overrides map.
 */
export function setFeatureModelOverride(
  db: Database.Database,
  key: FeatureKey,
  model: string | null,
): Record<string, string> {
  if (!(key in FEATURE_MODELS)) {
    throw new Error(`Unknown feature key "${key}"`);
  }

  if (model !== null) {
    if (typeof model !== "string" || !MODEL_OVERRIDE_PATTERN.test(model)) {
      throw new Error(
        `Invalid model format "${model}" — expected "<provider>/<model-id>" with no whitespace`,
      );
    }
    // Stronger check: parseModelSpec enforces the provider whitelist
    // (anthropic | openai | workers-ai) and throws a descriptive error.
    parseModelSpec(model);
  }

  const overrides = getFeatureModelOverrides(db);
  if (model === null) {
    delete overrides[key];
  } else {
    overrides[key] = model;
  }

  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE
       SET value = excluded.value,
           updated_at = excluded.updated_at`,
  ).run(FEATURE_MODEL_OVERRIDES_KEY, JSON.stringify(overrides));

  invalidateFeatureModelOverridesCache();
  return overrides;
}
