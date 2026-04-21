/**
 * One-shot smoke test for the Workers AI path.
 *
 * Exercises `getModelForFeature("alertSuggestion")` → Kimi K2.5 via Gateway
 * with a trivial prompt. Confirms:
 *   - Env vars wired correctly (CLOUDFLARE_* + WORKERS_AI token)
 *   - Compat endpoint URL is right
 *   - Auth bearer token is accepted
 *   - Model ID routes to Workers AI backend
 *   - Response shape matches what generateText expects
 *
 * Usage: npx tsx scripts/smoke-test-workers-ai.ts
 */

import { generateText } from "ai";
import { getModelForFeature } from "../lib/ai/provider";
import { FEATURE_MODELS } from "../lib/ai/models";
import type { FeatureKey } from "../lib/ai/feature-keys";

// Each feature's actual production maxOutputTokens + a prompt that exercises
// its real use case. Kimi K2 is a reasoning model; its reasoning_content
// shares the output budget, so the smoke test must mirror production.
const TARGETS: Array<{
  feature: FeatureKey;
  maxTokens: number;
  prompt: string;
  expectedKind: "one-word" | "one-sentence" | "json-array";
}> = [
  {
    feature: "alertSuggestion",
    maxTokens: 256,
    prompt: `A price level you set was just crossed. MP hit $55 (support). Write a ONE-SENTENCE recommendation. Analytical like a colleague, not a coach. Output exactly one sentence, no preamble.`,
    expectedKind: "one-sentence",
  },
  {
    feature: "newsletterLevelExtraction",
    maxTokens: 2048,
    prompt: `Extract price levels as JSON. Return ONLY a JSON array, no prose.\n\nArticle: "I'm watching SPY 580 as a key level. Below there I'd be a buyer."\n\nSchema per element: {"symbol":"...","level_type":"support|resistance|entry|exit|stop","price":number}\n\nReturn [] if none found.`,
    expectedKind: "json-array",
  },
  {
    feature: "factorClassification",
    maxTokens: 2000,
    prompt: `Classify AAPL into one JSON object: {"symbol":"AAPL","sector":"...","ai_exposure":"No|Low|Moderate|High|Very High"}. Return ONLY the JSON, no prose.`,
    expectedKind: "json-array",
  },
];

async function main() {
  for (const { feature, maxTokens, prompt, expectedKind } of TARGETS) {
    const spec = FEATURE_MODELS[feature];
    console.log(`\n▶ ${feature} (${spec}) — ${maxTokens} tokens, expect ${expectedKind}`);
    try {
      const start = Date.now();
      const { text, usage } = await generateText({
        model: getModelForFeature(feature),
        maxOutputTokens: maxTokens,
        prompt,
      });
      const elapsed = Date.now() - start;
      const preview = text.trim().slice(0, 160);
      console.log(`  ✓ text: ${JSON.stringify(preview)}`);
      console.log(
        `  ✓ tokens: in=${usage?.inputTokens ?? "?"}, out=${usage?.outputTokens ?? "?"}, elapsed=${elapsed}ms`
      );
      if (!text.trim()) {
        console.log(`  ⚠ EMPTY RESPONSE — reasoning likely consumed the budget. Check max_tokens.`);
      }
    } catch (err) {
      console.log(`  ✗ FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
