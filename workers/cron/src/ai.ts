/**
 * AI SDK wiring for the Worker — Anthropic via Cloudflare AI Gateway.
 *
 * Mirrors the Mac side's `lib/ai/provider.ts` pattern: every call carries a
 * `cf-aig-metadata: {"feature":"<key>"}` header so the Gateway dashboard can
 * attribute cost/latency per Worker feature.
 *
 * Unlike the Mac, the Worker only needs Anthropic — digest article processing
 * uses Sonnet, briefing synthesis uses Opus. No Workers AI, no OpenAI (we'd
 * add them the same way if needed later).
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { resolveTier, type Tier } from "./model-tiers";

export type WorkerFeature =
  | "fallbackBriefing"
  | "fallbackNewsletterProcessing"
  | "fallbackEvening";

export interface AIEnv {
  ANTHROPIC_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_GATEWAY_ID?: string;
}

/** Tier assignment per Worker feature — mirrors FEATURE_MODELS on the Mac. */
export const FEATURE_TIER: Record<WorkerFeature, Tier> = {
  // Opus-class (frontier) — same as Mac's briefing feature.
  fallbackBriefing: "frontier",
  // Sonnet-class (workhorse) — same as Mac's newsletterProcessing.
  fallbackNewsletterProcessing: "workhorse",
  // Sonnet-class (workhorse) — evening email synthesis. Sonnet is sufficient;
  // saves cost since this runs nightly vs. the Sunday-only briefing.
  fallbackEvening: "workhorse",
};

export function getModelForFeature(
  env: AIEnv,
  feature: WorkerFeature,
  catalog: string[] = [],
  excluded: Set<string> = new Set(),
): LanguageModel {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error(`ANTHROPIC_API_KEY missing (feature: ${feature})`);

  const modelId = resolveTier(FEATURE_TIER[feature], catalog, excluded);

  const gw = env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_GATEWAY_ID
    ? { accountId: env.CLOUDFLARE_ACCOUNT_ID, gatewayId: env.CLOUDFLARE_GATEWAY_ID }
    : null;

  const baseURL = gw
    ? `https://gateway.ai.cloudflare.com/v1/${gw.accountId}/${gw.gatewayId}/anthropic/v1`
    : undefined;

  const headers: Record<string, string> = {};
  if (gw) headers["cf-aig-metadata"] = JSON.stringify({ feature });

  const anthropic = createAnthropic({ apiKey, baseURL, headers });
  return anthropic(modelId);
}

/**
 * Wraps a single AI call with reactive failover: if the resolved model returns
 * a 404 / not_found, exclude it and retry once with the next model in the tier
 * ladder. On any other error, re-throws immediately.
 */
export async function generateWithFailover<T>(
  env: AIEnv,
  feature: WorkerFeature,
  catalog: string[],
  call: (model: LanguageModel) => Promise<T>,
): Promise<T> {
  const excluded = new Set<string>();
  const modelId = resolveTier(FEATURE_TIER[feature], catalog);
  try {
    return await call(getModelForFeature(env, feature, catalog, excluded));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const notFound = (err as { statusCode?: number })?.statusCode === 404 || /not_found|may not exist/i.test(msg);
    if (!notFound) throw err;
    excluded.add(modelId);
    console.warn(`[worker-ai] ${feature}: ${modelId} unavailable → failover`);
    return await call(getModelForFeature(env, feature, catalog, excluded));
  }
}
