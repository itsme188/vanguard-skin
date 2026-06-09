/**
 * Injection seam + cache for per-feature AI model overrides.
 *
 * Why a registered source instead of importing the lib/db singleton here:
 * lib/ai/models.ts is imported by nearly every AI-calling module (some at
 * module top-level, e.g. vanguard-pdf.ts), and nothing under lib/ currently
 * imports the lib/db singleton — every lib function takes a `db` parameter.
 * A static (or lazy-require) import of lib/db from the resolver would open
 * the real data/vanguard.db as a side effect of importing any of those
 * modules in tests / Workers-adjacent contexts. Instead, lib/db.ts registers
 * the SQLite-backed reader after the singleton is created — production code
 * always imports lib/db before making AI calls, while in-memory test DBs and
 * any context without the singleton silently fall back to FEATURE_MODELS
 * (same resilience precedent as getRiskFreeRate).
 *
 * Cache: 30s TTL so the resolver doesn't hit SQLite on every AI call, plus
 * explicit invalidation from setFeatureModelOverride so a settings save
 * applies immediately.
 */

export type FeatureModelOverridesReader = () => Record<string, string>;

const OVERRIDES_TTL_MS = 30_000;

let reader: FeatureModelOverridesReader | null = null;
let cache: { value: Record<string, string>; readAt: number } | null = null;

/**
 * Register (or clear, with null) the function that reads the current
 * overrides map. Called once from lib/db.ts at singleton creation; tests
 * inject a stub directly. Resets the cache.
 */
export function setFeatureModelOverrideSource(
  fn: FeatureModelOverridesReader | null,
): void {
  reader = fn;
  cache = null;
}

/** Drop the cached overrides so the next resolve re-reads the source. */
export function invalidateFeatureModelOverridesCache(): void {
  cache = null;
}

/**
 * Current overrides map (featureKey → "<provider>/<model-id>"), cached for
 * OVERRIDES_TTL_MS. Returns {} when no source is registered or the source
 * throws (e.g. missing settings table) — callers fall back to FEATURE_MODELS.
 */
export function getCachedFeatureModelOverrides(): Record<string, string> {
  if (!reader) return {};
  const now = Date.now();
  if (cache && now - cache.readAt < OVERRIDES_TTL_MS) return cache.value;
  let value: Record<string, string> = {};
  try {
    value = reader() ?? {};
  } catch {
    value = {};
  }
  cache = { value, readAt: now };
  return value;
}
