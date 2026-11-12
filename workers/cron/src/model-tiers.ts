/**
 * Tier policy + pure resolver for AI model selection — Worker-side mirror.
 *
 * Byte-for-byte copy of lib/ai/model-tiers.ts below the header doc comment.
 * Self-contained: no @/ imports, no Node.js dependencies — runs in the Worker
 * runtime without modification.
 *
 * UPDATE BOTH FILES together whenever the tier policy changes.
 */

// Model policy (owner ruling 2026-11-07): Sonnet is the app default and the
// FRONTIER TIER MEANS OPUS. Fable is not a rung on any ladder — not for cost
// (it lists at 2.5x Opus per token) and not for availability (it needs the
// Anthropic org on >=30-day retention, so a ZDR/under-30d org 400s every
// request). Only a feature whose own code asks for the top tier by name uses
// $frontier; everything else is $workhorse. See lib/ai/models.ts.

export type Tier = "frontier" | "workhorse" | "cheap";

/**
 * Capability order, highest first, per tier. Values are model *families*.
 * Frontier tops out at Opus (2026-11-07); Sonnet stays its last rung so an
 * Opus outage degrades to a live model instead of TIER_STATIC_FALLBACK.
 */
export const FAMILY_LADDERS: Record<Tier, string[]> = {
  frontier: ["opus", "sonnet"],
  workhorse: ["sonnet", "haiku"],
  cheap: ["haiku"],
};

/**
 * The newest model of each class a ladder uses (owner ruling 2026-11-12:
 * "always use the latest version of a class of model"). Ids verified
 * 2026-11-12 against Anthropic's model table and pricing page.
 *
 * Two jobs:
 *   1. A FLOOR: a catalog id OLDER than its class's entry here is never
 *      selected, neither as the first pick nor after reactive failover drops
 *      the newest one (failover moves to the next class on the ladder, never
 *      to an older generation of the same class). A NEWER catalog id of the
 *      class is still followed automatically.
 *   2. The static fallback below, used when the catalog is empty (a fresh
 *      database, a Worker snapshot that carries no catalog).
 * When a class ships a new version, move its entry here AND in the mirror.
 */
export const CURRENT_CLASS_MODELS: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-5-5",
};

/**
 * Used only when the live catalog has nothing current for a tier: the current
 * id of the tier's top class. Frontier is OPUS, the top of the frontier ladder.
 */
export const TIER_STATIC_FALLBACK: Record<Tier, string> = {
  frontier: CURRENT_CLASS_MODELS.opus,
  workhorse: CURRENT_CLASS_MODELS.sonnet,
  cheap: CURRENT_CLASS_MODELS.haiku,
};

export interface ParsedModel {
  family: string;
  version: number[];
}

/**
 * "claude-opus-4-8" → { family: "opus", version: [4, 8] }
 * "claude-sonnet-5-5" → { family: "sonnet", version: [5, 5] }
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

function currentIdOfClass(family: string): string | null {
  return Object.prototype.hasOwnProperty.call(CURRENT_CLASS_MODELS, family)
    ? CURRENT_CLASS_MODELS[family]
    : null;
}

/**
 * False only for an OLDER version of a class listed in CURRENT_CLASS_MODELS
 * ("claude-sonnet-4-6" while Sonnet 5.5 is current). A newer version, an id
 * of an unlisted class, or a non-Claude id is left alone (true).
 */
export function isCurrentGeneration(id: string): boolean {
  const parsed = parseModelId(id);
  if (!parsed) return true;
  const current = currentIdOfClass(parsed.family);
  const floor = current ? parseModelId(current) : null;
  if (!floor) return true;
  return compareVersions(parsed.version, floor.version) >= 0;
}

/**
 * An older generation of a listed class becomes that class's current id
 * ("claude-sonnet-4-6" → "claude-sonnet-5-5"); any other id is returned
 * unchanged. For concrete ids that bypass the tier ladder (a stored override).
 */
export function upgradeToCurrentGeneration(id: string): string {
  if (isCurrentGeneration(id)) return id;
  const parsed = parseModelId(id);
  return (parsed && currentIdOfClass(parsed.family)) ?? id;
}

/**
 * Resolve a tier to a concrete model id, given the available-model catalog.
 * Walks the family ladder; for the first family with ≥1 available (non-excluded)
 * CURRENT-generation model, returns the newest version. Older generations are
 * never candidates (CURRENT_CLASS_MODELS). Empty result → TIER_STATIC_FALLBACK[tier].
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
    .filter((x): x is { id: string; parsed: ParsedModel } => x.parsed !== null)
    .filter((x) => isCurrentGeneration(x.id));

  for (const family of FAMILY_LADDERS[tier]) {
    const hits = available.filter((x) => x.parsed.family === family);
    if (hits.length === 0) continue;
    hits.sort((a, b) => compareVersions(b.parsed.version, a.parsed.version));
    return hits[0].id;
  }
  return TIER_STATIC_FALLBACK[tier];
}

/**
 * Per-provider tier tables for the non-Anthropic providers (provider-failover
 * design, 2026-11-02:
 * docs/superpowers/specs/2026-11-02-provider-failover-design.md).
 *
 * Anthropic tiers resolve through the live catalog + FAMILY_LADDERS above.
 * The other providers have no equivalent live catalog in this app, so their
 * tier mappings are static tables — verified against the providers' public
 * docs on 2026-11-02 (OpenAI: platform.openai.com/docs/models; Workers AI:
 * developers.cloudflare.com/workers-ai/models). Review an edit here like a
 * new FAMILY_LADDERS entry: deliberately, before spend routes to it.
 */
export const PROVIDER_TIER_MODELS: Record<string, Record<Tier, string>> = {
  openai: {
    frontier: "gpt-6-astra",
    workhorse: "gpt-6.1-sol",
    cheap: "gpt-6-luna",
  },
  "workers-ai": {
    frontier: "@cf/openai/gpt-oss-120b",
    workhorse: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    cheap: "@cf/meta/llama-4-scout-17b-16e-instruct",
  },
};

/**
 * The concrete model id for a non-Anthropic provider's tier, or null when the
 * provider has no table. Anthropic always returns null here — its tiers
 * resolve via resolveTier against the live catalog.
 */
export function resolveProviderTierModel(provider: string, tier: Tier): string | null {
  return PROVIDER_TIER_MODELS[provider]?.[tier] ?? null;
}
