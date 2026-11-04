/**
 * Read side of the provider-failover settings (provider-failover design §7,
 * slice 4). `settings` keys, all absent by default. Failover is ON by default
 * for every ceiling feature (owner directive 2026-11-03); these keys record the
 * owner's explicit choices:
 *
 *   ai_failover_enabled      JSON array of FeatureKey  — the rollout set
 *   ai_failover_fallbacks    JSON object FeatureKey -> ["<provider>/<model-id>", ...]
 *                            — the ordered fallback list per feature
 *
 * Fallback entries are the SAME provider-qualified specs the model overrides
 * use, validated by the same pattern here and by `parseModelSpec` on write.
 * Like lib/queries/ai-model-overrides.ts this file imports nothing from
 * lib/ai (lib/db.ts imports it to wire the executor's sources).
 *
 * This reader is deliberately NOT the ceiling: the executor intersects the
 * set with FAILOVER_ELIGIBLE_CEILING, so even a hand-edited row cannot enable
 * a parked feature.
 */
import type Database from "better-sqlite3";
import { MODEL_OVERRIDE_PATTERN } from "@/lib/queries/ai-model-overrides";

export const FAILOVER_ENABLED_KEY = "ai_failover_enabled";
/** The owner's explicit opt-outs (2026-11-03: failover is on by default inside the ceiling). */
export const FAILOVER_DISABLED_KEY = "ai_failover_disabled";
export const FAILOVER_FALLBACKS_KEY = "ai_failover_fallbacks";

function readJson(db: Database.Database, key: string): unknown {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row ? JSON.parse(row.value) : undefined;
  } catch {
    return undefined;
  }
}

/** Feature keys switched ON. [] when unset, malformed, or the table is missing. */
export function getFailoverEnabledFeatures(db: Database.Database): string[] {
  const parsed = readJson(db, FAILOVER_ENABLED_KEY);
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter((v): v is string => typeof v === "string"))];
}

/**
 * Feature keys the owner explicitly switched OFF. [] when unset or malformed.
 * Since 2026-11-03 failover is on by default inside the ceiling, so "never
 * configured" and "switched off" needed distinct storage: this key is the opt-out.
 * `ai_failover_enabled` above is kept as the explicit opt-in record (what the
 * owner had saved before default-on keeps its meaning: still on).
 */
export function getFailoverDisabledFeatures(db: Database.Database): string[] {
  const parsed = readJson(db, FAILOVER_DISABLED_KEY);
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.filter((v): v is string => typeof v === "string"))];
}

/** Ordered fallback specs per feature. {} when unset or malformed; bad entries are dropped. */
export function getFailoverFallbacks(db: Database.Database): Record<string, string[]> {
  const parsed = readJson(db, FAILOVER_FALLBACKS_KEY);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const specs = value.filter((v): v is string => typeof v === "string" && MODEL_OVERRIDE_PATTERN.test(v));
    if (specs.length > 0) out[key] = specs;
  }
  return out;
}
