/**
 * Failover for the RAW-client web-search call sites (provider-failover, raw-SDK
 * wiring 2026-11-03).
 *
 * Eligible features call Anthropic through the raw `@anthropic-ai/sdk`
 * client with the native `web_search` tool, not through lib/ai/generate.ts:
 * earningsDateVerification (lib/calendar/verify-earnings-dates.ts) and
 * sectorVerification (lib/securities/verify-sector-tags.ts). The generate
 * helpers' executor never saw them, so a billing failure parked them whatever
 * Settings -> AI failover said.
 *
 * Each site catches the primary's error and hands it here. Everything that
 * decides WHETHER and WHERE to switch is the existing executor
 * (failOverOnAccountFailure): the rollout set, the section 4 ceiling, the
 * trigger kinds (billing / auth / config only, read by the shared
 * classifiers), the leg order, the switch log (noteFailover -> ai_failover_log)
 * and "all legs down rethrows the ORIGINAL error". This file only supplies the
 * run callback.
 *
 * DESIGN CHOICE (tool use): these calls verify facts against the live web, so a
 * fallback that answers from memory would be worse than parking (a wrong
 * earnings date or sector tag gets written to the ledger). The fallback leg
 * therefore carries OpenAI's own web-search tool, and ONLY an OpenAI leg is
 * accepted. The Cloudflare compat route has no search tool, so it is skipped
 * for these features rather than called without one.
 */
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { failOverOnAccountFailure } from "@/lib/ai/failover";

export async function failOverRawSearchCall(
  feature: FeatureKey,
  primaryErr: unknown,
  req: { prompt: string; maxOutputTokens: number; system?: string; abortSignal?: AbortSignal },
): Promise<string> {
  return failOverOnAccountFailure(
    feature,
    primaryErr,
    async (model) => {
      const res = await generateText({
        model,
        prompt: req.prompt,
        ...(req.system ? { system: req.system } : {}),
        // The in-app recap run's cancel reaches the fallback request too; its SDK
        // retries are off there so they cannot stack under that run's attempt cap.
        ...(req.abortSignal ? { abortSignal: req.abortSignal, maxRetries: 0 } : {}),
        maxOutputTokens: req.maxOutputTokens,
        // The provider-executed tool's generic parameter does not unify with generateText's
        // ToolSet inference (a typing quirk of @ai-sdk/openai 3.x); the tool object is the
        // package's own, passed unchanged.
        tools: { web_search: openai.tools.webSearch({}) } as never,
      });
      if (res.finishReason === "content-filter") throw new Error(`${feature}: the fallback model refused the request`);
      if (!res.text || res.text.trim() === "") throw new Error(`${feature}: the fallback model returned no text`);
      return res.text;
    },
    { accepts: (target) => target.provider === "openai" },
  );
}
