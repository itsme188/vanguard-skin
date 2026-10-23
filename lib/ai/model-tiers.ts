/**
 * Tier policy + pure resolver for AI model selection.
 *
 * The ONE human-editable piece of domain knowledge: the ordered family ladder
 * per capability tier (the Anthropic Models API lists which models EXIST but
 * does not rank them, so ordering must live in code). A version bump within a
 * family and a model pull are both handled automatically; only a brand-new
 * FAMILY NAME requires editing FAMILY_LADDERS — deliberately, so a new flagship
 * is reviewed before production spend routes to it.
 *
 * resolveTier is pure: (tier, available-model-ids, excluded?) → concrete id.
 */

// Org data retention: Fable 5 requires the Anthropic org to be on >=30-day
// retention (ZDR/under-30d → every Fable request 400s). Confirm in the
// Anthropic Console before frontier routes to Fable. (Operational, not enforced here.)

export type Tier = "frontier" | "workhorse" | "cheap";

/** Capability order, highest first, per tier. Values are model *families*. */
export const FAMILY_LADDERS: Record<Tier, string[]> = {
  frontier: ["fable", "opus", "sonnet"],
  workhorse: ["sonnet", "haiku"],
  cheap: ["haiku"],
};

/**
 * Used only when the live catalog is empty/unknown. Must be a reliably-available
 * model: frontier is OPUS (not Fable) because Fable's availability is exactly
 * what's uncertain.
 */
export const TIER_STATIC_FALLBACK: Record<Tier, string> = {
  frontier: "claude-opus-4-8",
  workhorse: "claude-sonnet-4-6",
  cheap: "claude-haiku-4-5-20251001",
};

export interface ParsedModel {
  family: string;
  version: number[];
}

/**
 * "claude-opus-4-8" → { family: "opus", version: [4, 8] }
 * "claude-fable-5"  → { family: "fable", version: [5] }
 * "claude-haiku-4-5-20251001" → { family: "haiku", version: [4, 5] } (date dropped)
 * Returns null for any non-"claude-<family>-<ver>" id (e.g. Workers-AI models).
 */
export function parseModelId(id: string): ParsedModel | null {
  const m = /^claude-([a-z]+)-(\d+(?:-\d+)*)/.exec(id);
  if (!m) return null;
  const family = m[1];
  // Drop any trailing segment that looks like a YYYYMMDD date (8 digits).
  const parts = m[2].split("-");
  const versionParts = parts.filter((p) => p.length !== 8);
  const version = versionParts.map((n) => parseInt(n, 10));
  if (version.length === 0 || version.some((n) => !Number.isFinite(n))) return null;
  return { family, version };
}

/** Compare version tuples: [4,10] > [4,8] > [4,7]; longer wins on shared prefix. */
function compareVersions(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * Resolve a tier to a concrete model id, given the available-model catalog.
 * Walks the family ladder; for the first family with ≥1 available (non-excluded)
 * model, returns the newest version. Empty result → TIER_STATIC_FALLBACK[tier].
 *
 * `excluded` lets reactive failover drop a model that just 404'd so the retry
 * skips it even before the catalog cache refreshes.
 */
export function resolveTier(
  tier: Tier,
  catalogIds: string[],
  excluded: Set<string> = new Set(),
): string {
  const available = catalogIds
    .filter((id) => !excluded.has(id))
    .map((id) => ({ id, parsed: parseModelId(id) }))
    .filter((x): x is { id: string; parsed: ParsedModel } => x.parsed !== null);

  for (const family of FAMILY_LADDERS[tier]) {
    const hits = available.filter((x) => x.parsed.family === family);
    if (hits.length === 0) continue;
    hits.sort((a, b) => compareVersions(b.parsed.version, a.parsed.version));
    return hits[0].id;
  }
  return TIER_STATIC_FALLBACK[tier];
}
