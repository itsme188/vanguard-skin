import type { FeatureKey } from "@/lib/ai/feature-keys";
import { getCachedFeatureModelOverrides } from "@/lib/ai/override-source";
import { getCachedModelCatalog } from "@/lib/ai/catalog-source";
import { resolveTier, type Tier } from "@/lib/ai/model-tiers";

const TIER_TOKENS: Record<string, Tier> = {
  "$frontier": "frontier",
  "$workhorse": "workhorse",
  "$cheap": "cheap",
};

const lastResolvedByTier = new Map<Tier, string>();
/** test-only: reset the per-tier last-resolved tracking map */
export function __resetTierLog(): void { lastResolvedByTier.clear(); }

/**
 * Policy plane for AI model selection.
 *
 * Each feature key maps to a provider-qualified model string:
 *   "<provider>/<model-id>"  — explicit concrete id, or
 *   "<provider>/$<tier>"     — tier token expanded via the live catalog
 *
 * Tier tokens: $frontier (best available), $workhorse (Sonnet-class),
 * $cheap (Haiku-class). Expansion is handled by resolveFeatureModel via
 * lib/ai/model-tiers.ts + the live catalog in lib/ai/catalog-source.ts.
 *
 * Supported providers (resolved by lib/ai/provider.ts):
 *   - "anthropic"   — Claude via @ai-sdk/anthropic, routes through Gateway if configured
 *   - "openai"      — GPT via @ai-sdk/openai, routes through Gateway if configured
 *   - "workers-ai"  — Cloudflare Workers AI via Gateway universal endpoint
 *                     (uses OpenAI-compatible API surface)
 *
 * To try a new model on one feature:
 *   1. Change its value below (e.g., "workers-ai/@cf/meta/llama-3.3-70b-instruct").
 *   2. Restart the dev server / re-deploy.
 *   3. Watch the Gateway dashboard — cost, latency, and quality observable per call.
 *   4. Roll back by reverting the string if quality drops.
 */
export const FEATURE_MODELS: Record<FeatureKey, string> = {
  // frontier (was Opus)
  chat: "anthropic/$frontier",
  briefing: "anthropic/$frontier",
  tradeReviewMain: "anthropic/$frontier",
  pdfParsing: "anthropic/$frontier",

  // workhorse (was Sonnet)
  dailyDigestSynthesis: "anthropic/$workhorse",
  tradeReviewMainLarge: "anthropic/$workhorse",
  tradeReviewQA: "anthropic/$workhorse",
  newsletterLevelExtraction: "anthropic/$workhorse",
  newsletterProcessing: "anthropic/$workhorse",
  factorClassification: "anthropic/$workhorse",
  securityClassification: "anthropic/$workhorse",
  analysisFactorNarrative: "anthropic/$workhorse",
  // Weekly macro-themes generation for the Analysis Workspace + Sunday
  // briefing. ~$0.85/month at 4 scopes × 1/wk.
  analysisMacroThemes: "anthropic/$workhorse",
  macroEnrichment: "anthropic/$workhorse",

  // Must stay on Anthropic — uses Claude-native web_search tool.
  scheduleVerification: "anthropic/$workhorse",

  // 10-K / 10-Q section summarization.
  filingSectionExtraction: "anthropic/$workhorse",

  // Research PDF knowledge base — extracts metadata + raw text from uploaded
  // analyst reports / research notes. Anthropic's native PDF content block
  // handles layout + tables.
  researchDocumentExtraction: "anthropic/$workhorse",

  // Earnings preview/recap emails. Must stay on Anthropic — uses
  // Claude-native web_search to fill consensus + sell-side commentary gaps.
  earningsPreview: "anthropic/$workhorse",
  earningsRecap: "anthropic/$workhorse",

  // Multi-symbol earnings bogeys PDF (e.g., TMT Breakout's weekly preview).
  // Must stay on Anthropic — native PDF content block.
  earningsBogeysExtraction: "anthropic/$workhorse",

  // Newsletter-text bogey extraction (EPS/revenue consensus + whisper for
  // upcoming reporters) — sibling of newsletterLevelExtraction but for
  // earnings numbers instead of price levels.
  newsletterBogeyExtraction: "anthropic/$workhorse",

  // Per-ETF GICS sector-weight look-through. Must stay on Anthropic — uses
  // Claude-native web_search (Finnhub ETF data is premium-gated).
  etfSectorWeights: "anthropic/$workhorse",

  // cheap (was Haiku)
  // Post-extraction verification of ticker mentions. Haiku is plenty for
  // yes/no judgments with short context snippets.
  researchMentionVerification: "anthropic/$cheap",

  // One-sentence narrative per suggested S/R level on the chart. Cached per
  // (security_id, level_price, day) so a single call amortizes across same-day views.
  suggestedLevelNarrative: "anthropic/$cheap",
  // 1-2 sentence overnight-session extract from VK Dawn for the morning
  // digest's Overnight block — pure extraction over ≤12k chars, Haiku-grade.
  overnightCommentary: "anthropic/$cheap",

  // explicit experiment — NOT tiered; Workers AI cost experiment
  alertSuggestion: "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct",
};

export interface ResolvedModel {
  provider: "anthropic" | "openai" | "workers-ai";
  modelId: string;
}

export function parseModelSpec(spec: string): ResolvedModel {
  const slash = spec.indexOf("/");
  if (slash === -1) {
    throw new Error(
      `Invalid model spec "${spec}": expected "<provider>/<model-id>"`
    );
  }
  const provider = spec.slice(0, slash);
  const modelId = spec.slice(slash + 1);
  if (provider !== "anthropic" && provider !== "openai" && provider !== "workers-ai") {
    throw new Error(
      `Unknown provider "${provider}" in model spec "${spec}". Supported: anthropic, openai, workers-ai`
    );
  }
  return { provider, modelId };
}

/** Expand a "<provider>/<spec>" where spec may be a $tier token or a concrete id. */
function expandSpec(spec: string): ResolvedModel {
  const slash = spec.indexOf("/");
  const maybeToken = slash === -1 ? "" : spec.slice(slash + 1);
  const tier = TIER_TOKENS[maybeToken];
  if (tier) {
    const provider = spec.slice(0, slash);
    const resolvedId = resolveTier(tier, getCachedModelCatalog());
    const prev = lastResolvedByTier.get(tier);
    if (prev !== resolvedId) {
      if (prev !== undefined) {
        console.log(`[ai] tier "${tier}" now resolves to ${resolvedId} (was ${prev})`);
      }
      lastResolvedByTier.set(tier, resolvedId);
    }
    return parseModelSpec(`${provider}/${resolvedId}`);
  }
  return parseModelSpec(spec);
}

/**
 * Resolve a feature's logical model to its concrete (provider, modelId) pair.
 *
 * User overrides (settings-table key `feature_model_overrides`, edited via
 * Settings → AI Models) are consulted FIRST; FEATURE_MODELS is the fallback.
 * The override read goes through lib/ai/override-source.ts — a 30s-TTL cache
 * over a reader registered by lib/db.ts, so this stays cheap on hot paths and
 * silently resolves to the defaults in contexts without the DB singleton
 * (in-memory test DBs, Workers). A stored override that no longer parses
 * (e.g. provider support removed) also falls back rather than breaking the
 * feature.
 *
 * $frontier/$workhorse/$cheap tier tokens in FEATURE_MODELS are expanded
 * against the live catalog from getCachedModelCatalog(); empty catalog falls
 * back to TIER_STATIC_FALLBACK. A malformed user override also falls through
 * to the tier-aware default (not a literal $-token string).
 *
 * Throws if the feature key isn't configured or the default spec is malformed.
 */
export function resolveFeatureModel(feature: FeatureKey): ResolvedModel {
  const override = getCachedFeatureModelOverrides()[feature];
  if (override) {
    try {
      return expandSpec(override);
    } catch {
      // Malformed/unsupported override — fall through to the code default.
    }
  }
  const def = FEATURE_MODELS[feature];
  if (!def) throw new Error(`No model configured for feature "${feature}"`);
  return expandSpec(def);
}
