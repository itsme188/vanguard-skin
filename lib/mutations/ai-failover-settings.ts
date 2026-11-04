/**
 * Write side of the provider-failover settings (design §7, slice 4).
 *
 * Every write is bounded by the section 4 ceiling: a feature outside
 * FAILOVER_ELIGIBLE_CEILING (the parked ones: native web_search, raw-SDK PDF,
 * the Cloudflare-only feature) is REJECTED here, for the enable flag and for a
 * fallback list alike, so no UI or API call can turn failover on for it. A
 * fallback entry goes through the same validation as a model override:
 * MODEL_OVERRIDE_PATTERN, then `parseModelSpec`'s provider whitelist, then a
 * tier-token expansion check so an unmapped tier cannot be saved.
 *
 * Writing here never touches `feature_model_overrides`, and never enables
 * anything by itself: the defaults stay empty.
 */
import type Database from "better-sqlite3";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { FEATURE_MODELS, expandSpec, parseModelSpec } from "@/lib/ai/models";
import { EARNINGS_PREP_FAILOVER_GROUP, FAILOVER_ELIGIBLE_CEILING } from "@/lib/ai/failover";
import { MODEL_OVERRIDE_PATTERN } from "@/lib/queries/ai-model-overrides";
import {
  FAILOVER_DISABLED_KEY,
  FAILOVER_ENABLED_KEY,
  getFailoverDisabledFeatures,
  FAILOVER_FALLBACKS_KEY,
  getFailoverEnabledFeatures,
  getFailoverFallbacks,
} from "@/lib/queries/ai-failover-settings";

const MAX_FALLBACKS = 3;

function upsert(db: Database.Database, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE
       SET value = excluded.value,
           updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value));
}

/** Throws unless `key` is a known feature inside the section 4 ceiling. */
export function assertFailoverEligible(key: string): asserts key is FeatureKey {
  if (!(key in FEATURE_MODELS)) throw new Error(`Unknown feature key "${key}"`);
  if (!FAILOVER_ELIGIBLE_CEILING.has(key as FeatureKey)) {
    throw new Error(
      `"${key}" cannot fail over: it stays parked on its own provider (native web search, PDF input, or the last-resort route)`,
    );
  }
}

/**
 * Record an explicit choice for one feature. Failover is ON by default inside
 * the ceiling, so "off" is an explicit opt-out that stays off; "on" records an
 * explicit opt-in (and lifts any opt-out). Both lists are rewritten in one
 * transaction. Returns the effective-on list is NOT returned: callers re-read the view.
 */
function applyChoice(db: Database.Database, keys: readonly string[], enabled: boolean): void {
  db.transaction(() => {
    const on = new Set(getFailoverEnabledFeatures(db));
    const off = new Set(getFailoverDisabledFeatures(db));
    for (const key of keys) {
      if (enabled) {
        on.add(key);
        off.delete(key);
      } else {
        off.add(key);
        on.delete(key);
      }
    }
    upsert(db, FAILOVER_ENABLED_KEY, [...on].sort());
    upsert(db, FAILOVER_DISABLED_KEY, [...off].sort());
  })();
}

/** Switch failover on/off for one feature (explicit choice). */
export function setFailoverEnabled(db: Database.Database, key: string, enabled: boolean): void {
  assertFailoverEligible(key);
  applyChoice(db, [key], enabled);
}

/** Switch the whole earnings print-prep group on/off in ONE write. */
export function setFailoverGroupEnabled(db: Database.Database, enabled: boolean): void {
  for (const key of EARNINGS_PREP_FAILOVER_GROUP) assertFailoverEligible(key);
  applyChoice(db, EARNINGS_PREP_FAILOVER_GROUP, enabled);
}

/**
 * Set (or clear, with null/[]) a feature's ordered fallback list. Entries are
 * provider-qualified specs ("openai/$workhorse", "workers-ai/@cf/..."); the
 * primary provider (Anthropic) is not a fallback, and a provider appears once.
 */
export function setFailoverFallbacks(
  db: Database.Database,
  key: string,
  specs: string[] | null,
): Record<string, string[]> {
  assertFailoverEligible(key);
  const all = getFailoverFallbacks(db);
  if (specs === null || specs.length === 0) {
    delete all[key];
  } else {
    if (specs.length > MAX_FALLBACKS) throw new Error(`At most ${MAX_FALLBACKS} fallbacks per feature`);
    const providers = new Set<string>();
    for (const spec of specs) {
      if (typeof spec !== "string" || !MODEL_OVERRIDE_PATTERN.test(spec)) {
        throw new Error(
          `Invalid fallback "${String(spec)}" — expected "<provider>/<model-id>" with no whitespace`,
        );
      }
      const { provider } = parseModelSpec(spec); // provider whitelist
      if (provider === "anthropic") {
        throw new Error(`"${spec}": Anthropic is the primary provider, not a fallback`);
      }
      if (providers.has(provider)) throw new Error(`"${provider}" appears twice in the fallback list`);
      providers.add(provider);
      expandSpec(spec); // a tier token with no table for that provider throws here
    }
    all[key] = specs;
  }
  upsert(db, FAILOVER_FALLBACKS_KEY, all);
  return all;
}
