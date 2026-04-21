import Anthropic from "@anthropic-ai/sdk";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import {
  getAnthropicApiKey,
  getOpenAIApiKey,
  getCloudflareGateway,
  getCloudflareWorkersAIToken,
  type CloudflareGatewayConfig,
} from "@/lib/env";
import { resolveFeatureModel } from "@/lib/ai/models";
import type { FeatureKey } from "@/lib/ai/feature-keys";

/**
 * The translation layer between logical feature names and concrete AI SDK
 * language models. All routing through Cloudflare AI Gateway happens here;
 * callers stay agnostic.
 *
 * Design:
 *   - If Gateway env vars are present, every provider is pointed at the
 *     corresponding Gateway URL. Calls show up in the Cloudflare dashboard.
 *   - If Gateway env vars are missing, providers fall back to their native
 *     public URLs. Zero behavior change for devs without Cloudflare creds.
 *   - Each call carries a `cf-aig-metadata` header tagging the feature key,
 *     so the dashboard can attribute cost/latency per feature.
 *
 * Anthropic-via-Gateway URL: .../v1/{account}/{gateway}/anthropic/v1
 *   (trailing /v1 matches the AI SDK anthropic client's default prefix)
 *
 * Workers AI via Gateway uses the "compat" universal endpoint:
 *   .../v1/{account}/{gateway}/compat/chat/completions
 *   with body `{ "model": "workers-ai/@cf/..." }`.
 */

function buildAnthropicBaseURL(gw: CloudflareGatewayConfig): string {
  return `https://gateway.ai.cloudflare.com/v1/${gw.accountId}/${gw.gatewayId}/anthropic/v1`;
}

function buildRawAnthropicBaseURL(gw: CloudflareGatewayConfig): string {
  // The raw @anthropic-ai/sdk client appends /v1/messages itself, so its base
  // should stop before /v1 (unlike @ai-sdk/anthropic which expects /v1 baked in).
  return `https://gateway.ai.cloudflare.com/v1/${gw.accountId}/${gw.gatewayId}/anthropic`;
}

function buildCompatBaseURL(gw: CloudflareGatewayConfig): string {
  return `https://gateway.ai.cloudflare.com/v1/${gw.accountId}/${gw.gatewayId}/compat`;
}

function gatewayHeaders(
  gw: CloudflareGatewayConfig | undefined,
  feature: FeatureKey
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (gw) {
    headers["cf-aig-metadata"] = JSON.stringify({ feature });
    if (gw.token) {
      headers["cf-aig-authorization"] = `Bearer ${gw.token}`;
    }
  }
  return headers;
}

/**
 * Resolve a feature key to a ready-to-use AI SDK LanguageModel.
 *
 * Usage:
 *   const model = getModelForFeature("alertSuggestion");
 *   const { text } = await generateText({ model, prompt, maxOutputTokens });
 */
export function getModelForFeature(feature: FeatureKey): LanguageModel {
  const { provider, modelId } = resolveFeatureModel(feature);
  const gw = getCloudflareGateway();
  const headers = gatewayHeaders(gw, feature);

  if (provider === "anthropic") {
    const apiKey = getAnthropicApiKey();
    if (!apiKey) {
      throw new Error(
        `ANTHROPIC_API_KEY is required for feature "${feature}" (model: ${modelId})`
      );
    }
    const anthropic = createAnthropic({
      apiKey,
      baseURL: gw ? buildAnthropicBaseURL(gw) : undefined,
      headers,
    });
    return anthropic(modelId);
  }

  if (provider === "openai") {
    const apiKey = getOpenAIApiKey();
    if (!apiKey) {
      throw new Error(
        `OPENAI_API_KEY is required for feature "${feature}" (model: ${modelId})`
      );
    }
    const openai = createOpenAI({
      apiKey,
      baseURL: gw
        ? `https://gateway.ai.cloudflare.com/v1/${gw.accountId}/${gw.gatewayId}/openai`
        : undefined,
      headers,
    });
    return openai(modelId);
  }

  if (provider === "workers-ai") {
    if (!gw) {
      throw new Error(
        `Cloudflare AI Gateway must be configured to use Workers AI (feature: ${feature}). Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_GATEWAY_ID.`
      );
    }
    const wToken = getCloudflareWorkersAIToken();
    if (!wToken) {
      throw new Error(
        `CLOUDFLARE_WORKERS_AI_TOKEN is required for feature "${feature}" (Workers AI model: ${modelId})`
      );
    }
    // Universal compat endpoint requires the full "workers-ai/<model>" in the
    // model field so Cloudflare knows which backend to route to.
    const qualifiedModelId = `workers-ai/${modelId}`;
    const compat = createOpenAICompatible({
      name: "cloudflare-workers-ai",
      baseURL: buildCompatBaseURL(gw),
      apiKey: wToken,
      headers,
    });
    return compat(qualifiedModelId);
  }

  throw new Error(`Unreachable: unknown provider for feature "${feature}"`);
}

/**
 * Escape hatch for the one call site (vanguard-pdf.ts) that relies on the raw
 * @anthropic-ai/sdk streaming API with custom retry logic. Returns a configured
 * Anthropic client with Gateway routing when available.
 *
 * Prefer getModelForFeature() for new code — AI SDK handles streaming + retries
 * better for most cases.
 */
export function getRawAnthropicClient(feature: FeatureKey): Anthropic {
  const apiKey = getAnthropicApiKey();
  if (!apiKey) {
    throw new Error(
      `ANTHROPIC_API_KEY is required for feature "${feature}"`
    );
  }
  const gw = getCloudflareGateway();
  return new Anthropic({
    apiKey,
    baseURL: gw ? buildRawAnthropicBaseURL(gw) : undefined,
    defaultHeaders: gatewayHeaders(gw, feature),
  });
}
