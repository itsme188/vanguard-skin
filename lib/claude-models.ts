/**
 * Legacy single-source constants. Model selection now lives in
 * lib/ai/model-tiers.ts (tier ladders) + the live catalog. These re-exports
 * remain ONLY for non-feature importers; prefer tiers for anything new.
 */
import { TIER_STATIC_FALLBACK } from "@/lib/ai/model-tiers";

export const OPUS_MODEL = TIER_STATIC_FALLBACK.frontier;
export const SONNET_MODEL = TIER_STATIC_FALLBACK.workhorse;
export const HAIKU_MODEL = TIER_STATIC_FALLBACK.cheap;
