import { HAIKU_MODEL, OPUS_MODEL, SONNET_MODEL } from "@/lib/claude-models";
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

  // Cross-source synthesis for morning + evening digests. Sonnet 4.6 is
  // strong on structured-narrative work and ~5x cheaper than Opus.
  dailyDigestSynthesis: `anthropic/${SONNET_MODEL}`,

  briefing: `anthropic/${OPUS_MODEL}`,
  tradeReviewMain: `anthropic/${OPUS_MODEL}`,
  pdfParsing: `anthropic/${OPUS_MODEL}`,

  // Large trade reviews (>20 trades) use Sonnet to avoid Opus timeout risk.
  tradeReviewMainLarge: `anthropic/${SONNET_MODEL}`,

  // Structured / lower-stakes work. Some entries route to Workers AI to test
  // cheaper alternatives. Rollback = flip back to `anthropic/${SONNET_MODEL}`
  // if quality regresses.
  //
  // Two Workers AI quirks we've hit:
  //
  // 1. Kimi K2.x is a *reasoning* model — reasoning_content shares the
  //    max_tokens budget. Empirically, even maxOutputTokens=2048 was
  //    insufficient for prompts that ask for structured JSON over
  //    multi-thousand-token input (newsletter extraction): reasoning
  //    consumed the entire budget, finish_reason=length, no visible
  //    content. Safe only for short prompts with short structured output.
  //
  // 2. Llama 3.3 via the compat endpoint: if the response *looks* like valid
  //    JSON, Cloudflare auto-parses `message.content` into an object rather
  //    than a string. AI SDK's OpenAI-compatible provider chokes on that
  //    (expects content to be a string). Avoid Llama for any call whose
  //    prompt asks for raw JSON output — use Sonnet on Anthropic instead.
  tradeReviewQA: `anthropic/${SONNET_MODEL}`,
  alertSuggestion: "workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct",
  newsletterLevelExtraction: `anthropic/${SONNET_MODEL}`,
  newsletterProcessing: `anthropic/${SONNET_MODEL}`,
  factorClassification: `anthropic/${SONNET_MODEL}`,
  securityClassification: `anthropic/${SONNET_MODEL}`,
  analysisFactorNarrative: `anthropic/${SONNET_MODEL}`,
  // Weekly macro-themes generation for the Analysis Workspace + Sunday
  // briefing. Sonnet 4.6 via AI Gateway, pre-gen at Sunday cadence, cache
  // until next Sunday. ~$0.85/month at 4 scopes × 1/wk.
  analysisMacroThemes: `anthropic/${SONNET_MODEL}`,
  macroEnrichment: `anthropic/${SONNET_MODEL}`,

  // Must stay on Anthropic — uses Claude-native web_search tool.
  scheduleVerification: `anthropic/${SONNET_MODEL}`,

  // 10-K / 10-Q section summarization. Sonnet is cheap enough to cache per
  // (symbol, accession, section) and strong enough to reliably summarize
  // ~30-100K char filings into structured bullets.
  filingSectionExtraction: `anthropic/${SONNET_MODEL}`,

  // Research PDF knowledge base — extracts metadata + raw text from uploaded
  // analyst reports / research notes. Anthropic's native PDF content block
  // handles layout + tables; Sonnet is plenty for the structured-extraction
  // task and one-shot per upload keeps costs predictable.
  researchDocumentExtraction: `anthropic/${SONNET_MODEL}`,

  // Post-extraction verification of ticker mentions. Drops homonyms like
  // "HOOD" in "likelihood", "NET" in "net income", URL fragments. Haiku is
  // plenty for yes/no judgments with short context snippets.
  researchMentionVerification: `anthropic/${HAIKU_MODEL}`,

  // One-sentence narrative per suggested S/R level on the chart. Cached per
  // (security_id, level_price, day) so a single Haiku call amortizes across
  // all same-day views.
  suggestedLevelNarrative: `anthropic/${HAIKU_MODEL}`,

  // Earnings preview/recap emails. Must stay on Anthropic — composer enables
  // Claude-native web_search to fill consensus + sell-side commentary gaps
  // when Finnhub data is missing or thin.
  earningsPreview: `anthropic/${SONNET_MODEL}`,
  earningsRecap: `anthropic/${SONNET_MODEL}`,

  // Multi-symbol earnings bogeys PDF (e.g., TMT Breakout's weekly preview).
  // Sonnet via Anthropic — native PDF content block handles tables + layout
  // reliably; Workers AI doesn't currently support binary PDF input.
  earningsBogeysExtraction: `anthropic/${SONNET_MODEL}`,
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
