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

export type WorkerFeature =
  | "fallbackBriefing"
  | "fallbackNewsletterProcessing"
  | "fallbackEvening";

export interface AIEnv {
  ANTHROPIC_API_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_GATEWAY_ID?: string;
}

export const MODEL_FOR_FEATURE: Record<WorkerFeature, string> = {
  // Opus 4.7 — same as Mac's briefing feature.
  fallbackBriefing: "claude-opus-4-7",
  // Sonnet 4.6 — same as Mac's newsletterProcessing.
  fallbackNewsletterProcessing: "claude-sonnet-4-6",
  // Sonnet 4.6 — evening email synthesis. Sonnet is sufficient; saves cost
  // since this runs nightly vs. the Sunday-only briefing.
  fallbackEvening: "claude-sonnet-4-6",
};

export function getModelForFeature(env: AIEnv, feature: WorkerFeature): LanguageModel {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error(`ANTHROPIC_API_KEY missing (feature: ${feature})`);

  const gw = env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_GATEWAY_ID
    ? { accountId: env.CLOUDFLARE_ACCOUNT_ID, gatewayId: env.CLOUDFLARE_GATEWAY_ID }
    : null;

  const baseURL = gw
    ? `https://gateway.ai.cloudflare.com/v1/${gw.accountId}/${gw.gatewayId}/anthropic/v1`
    : undefined;

  const headers: Record<string, string> = {};
  if (gw) headers["cf-aig-metadata"] = JSON.stringify({ feature });

  const anthropic = createAnthropic({ apiKey, baseURL, headers });
  return anthropic(MODEL_FOR_FEATURE[feature]);
}
