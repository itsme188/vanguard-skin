/**
 * Feature-aware wrappers around the AI SDK that centralize:
 *   1. Reactive failover — on a not_found / model-unavailable error, drop the
 *      dead model from the in-memory catalog and retry ONCE with the re-resolved
 *      tier (the next available rung). Cadence-independent pull handling.
 *   2. Refusal handling — Fable 5 can finish with a refusal; surface it as a
 *      named AIRefusalError so callers degrade gracefully instead of treating an
 *      empty string as a real answer.
 *
 * Call sites swap `generateText({ model: getModelForFeature(x), ...opts })` for
 * `generateTextForFeature(x, opts)` — same options minus `model`.
 *
 * Step 0 confirmed: @ai-sdk/anthropic maps Anthropic `stop_reason: "refusal"`
 * to the normalized finishReason `"content-filter"` (index.js:2792-2793).
 * APICallError.isInstance is a function (verified at runtime) with statusCode
 * typed as optional number on the class.
 */

import { generateText, generateObject, APICallError } from "ai";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { getModelForFeature } from "@/lib/ai/provider";
import { resolveFeatureModel } from "@/lib/ai/models";
import { dropModelFromCatalog } from "@/lib/ai/catalog-source";

export class AIRefusalError extends Error {
  constructor(public feature: FeatureKey, public modelId: string) {
    super(`AI refused request for feature "${feature}" (model ${modelId})`);
    this.name = "AIRefusalError";
  }
}

// Confirmed value: @ai-sdk/anthropic converts Anthropic `refusal` stop_reason
// → normalized finishReason "content-filter" (node_modules/@ai-sdk/anthropic/dist/index.js:2792-2793).
const REFUSAL_FINISH = new Set(["content-filter"]);

function isModelUnavailable(err: unknown): boolean {
  if (APICallError.isInstance(err) && err.statusCode === 404) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /not_found|model.*(unavailable|does not exist|may not exist)/i.test(msg);
}

// Omit `model` so callers don't need to supply it — the wrapper resolves it.
// We use a loose type to avoid fighting AI SDK's internal generics (tools, etc.).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GenTextOpts = Omit<Parameters<typeof generateText<any, any>>[0], "model">;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GenObjOpts = Omit<Parameters<typeof generateObject<any>>[0], "model">;

export async function generateTextForFeature(feature: FeatureKey, opts: GenTextOpts) {
  let { modelId } = resolveFeatureModel(feature);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateText({ ...opts, model: getModelForFeature(feature) } as any);
    if (REFUSAL_FINISH.has(res.finishReason)) throw new AIRefusalError(feature, modelId);
    return res;
  } catch (err) {
    if (err instanceof AIRefusalError) throw err;
    if (!isModelUnavailable(err)) throw err;
    // Reactive failover: drop the dead model, re-resolve, retry once.
    dropModelFromCatalog(modelId);
    const next = resolveFeatureModel(feature).modelId;
    console.warn(`[ai] ${feature}: ${modelId} unavailable → failing over to ${next}`);
    modelId = next;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await generateText({ ...opts, model: getModelForFeature(feature) } as any);
    if (REFUSAL_FINISH.has(res.finishReason)) throw new AIRefusalError(feature, modelId);
    return res;
  }
}

export async function generateObjectForFeature(feature: FeatureKey, opts: GenObjOpts) {
  const { modelId } = resolveFeatureModel(feature);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await generateObject({ ...opts, model: getModelForFeature(feature) } as any);
  } catch (err) {
    if (!isModelUnavailable(err)) throw err;
    dropModelFromCatalog(modelId);
    const next = resolveFeatureModel(feature).modelId;
    console.warn(`[ai] ${feature}: ${modelId} unavailable → retrying with re-resolved model ${next}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await generateObject({ ...opts, model: getModelForFeature(feature) } as any);
  }
}
