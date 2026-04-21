import { OPUS_MODEL, SONNET_MODEL } from "@/lib/claude-models";
import type { FeatureKey } from "@/lib/ai/feature-keys";

/**
 * Policy plane for AI model selection.
 *
 * Each feature key maps to a provider-qualified model string:
 *   "<provider>/<model-id>"
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
 *
 * All feature entries default to Anthropic today. Phase 2 experiments flip
 * specific entries to Workers AI / OpenAI once real cost data identifies the
 * best candidates.
 */
export const FEATURE_MODELS: Record<FeatureKey, string> = {
  // Reasoning-heavy features — stay on Opus.
  chat: `anthropic/${OPUS_MODEL}`,
  briefing: `anthropic/${OPUS_MODEL}`,
  tradeReviewMain: `anthropic/${OPUS_MODEL}`,
  pdfParsing: `anthropic/${OPUS_MODEL}`,

  // Large trade reviews (>20 trades) use Sonnet to avoid Opus timeout risk.
  tradeReviewMainLarge: `anthropic/${SONNET_MODEL}`,

  // Structured / lower-stakes Claude work — stay on Sonnet today.
  // Phase 2 candidates to flip to workers-ai/Kimi or Llama.
  tradeReviewQA: `anthropic/${SONNET_MODEL}`,
  alertSuggestion: `anthropic/${SONNET_MODEL}`,
  newsletterLevelExtraction: `anthropic/${SONNET_MODEL}`,
  newsletterProcessing: `anthropic/${SONNET_MODEL}`,
  factorClassification: `anthropic/${SONNET_MODEL}`,
  macroEnrichment: `anthropic/${SONNET_MODEL}`,

  // Must stay on Anthropic — uses Claude-native web_search tool.
  scheduleVerification: `anthropic/${SONNET_MODEL}`,
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

/**
 * Resolve a feature's logical model to its concrete (provider, modelId) pair.
 * Throws if the feature key isn't configured or the spec is malformed.
 */
export function resolveFeatureModel(feature: FeatureKey): ResolvedModel {
  const spec = FEATURE_MODELS[feature];
  if (!spec) {
    throw new Error(`No model configured for feature "${feature}"`);
  }
  return parseModelSpec(spec);
}
