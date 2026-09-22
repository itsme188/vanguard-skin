/**
 * Feature-aware wrappers around the AI SDK that centralize:
 *   1. Reactive failover — on a not_found / model-unavailable error, drop the
 *      dead model from the in-memory catalog and retry ONCE with the re-resolved
 *      tier (the next available rung). Cadence-independent pull handling.
 *   2. Refusal handling — Fable 5 can finish with a refusal; surface it as a
 *      named AIRefusalError so callers degrade gracefully instead of treating an
 *      empty string as a real answer.
 *   3. Forced-tool-unsupported handling (generateObject only) — the AI SDK's
 *      Anthropic provider only knows model ids up to the 4-generation, so any
 *      5-generation id (claude-fable-5-1, claude-mythos-5-1, …) is scored
 *      `supportsStructuredOutput: false` and generateObject silently falls back
 *      to a synthetic `json` tool pinned with `tool_choice: {type:"any"}`. That
 *      family REJECTS forced tool use with a 400 (`tool_choice: type "tool" and
 *      "any" are not supported for this model.`). We therefore ask the provider
 *      for Anthropic's native structured output up front — provider option
 *      `structuredOutputMode: "outputFormat"`, which sends
 *      `output_config.format = {type:"json_schema", schema}` and NO tool /
 *      tool_choice at all — and, belt-and-braces for callers that override the
 *      mode themselves, retry ONCE with it forced when that 400 still fires.
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

/**
 * Anthropic's exact 400 when a model in the Fable/Mythos 5 family is handed a
 * forced `tool_choice` (`{type:"any"}` — what the AI SDK's json-tool fallback
 * uses — or `{type:"tool"}`):
 *
 *   tool_choice: type "tool" and "any" are not supported for this model.
 *
 * Matched on the error message AND on an APICallError's response body, because
 * the SDK does not always fold the upstream body into `message`.
 */
const FORCED_TOOL_UNSUPPORTED =
  /tool_choice[\s\S]{0,200}?not supported for this model/i;

export function isForcedToolUnsupported(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (FORCED_TOOL_UNSUPPORTED.test(msg)) return true;
  if (APICallError.isInstance(err) && err.statusCode === 400) {
    const body = typeof err.responseBody === "string" ? err.responseBody : "";
    if (FORCED_TOOL_UNSUPPORTED.test(body)) return true;
  }
  return false;
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

/**
 * Ask @ai-sdk/anthropic for Anthropic's NATIVE structured output instead of the
 * synthetic-json-tool fallback (see item 3 in the file header). Only applies to
 * the Anthropic provider; every other provider's options are left untouched.
 *
 * `force` is used by the one retry: it overrides a caller-supplied mode, which
 * is the only way a forced-tool 400 can still reach us after the up-front merge.
 */
function withAnthropicStructuredOutput(
  feature: FeatureKey,
  opts: GenObjOpts,
  force: boolean,
): GenObjOpts {
  if (resolveFeatureModel(feature).provider !== "anthropic") return opts;
  const providerOptions = (opts as { providerOptions?: Record<string, Record<string, unknown>> })
    .providerOptions;
  const anthropicOptions = providerOptions?.anthropic;
  // A caller that set the mode deliberately keeps it (until a forced retry).
  if (!force && anthropicOptions && anthropicOptions.structuredOutputMode !== undefined) {
    return opts;
  }
  return {
    ...opts,
    providerOptions: {
      ...providerOptions,
      anthropic: { ...anthropicOptions, structuredOutputMode: "outputFormat" },
    },
  } as GenObjOpts;
}

export async function generateObjectForFeature(feature: FeatureKey, opts: GenObjOpts) {
  const { modelId } = resolveFeatureModel(feature);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await generateObject({
      ...withAnthropicStructuredOutput(feature, opts, false),
      model: getModelForFeature(feature),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  } catch (err) {
    if (isForcedToolUnsupported(err)) {
      // The model rejects forced tool use outright (Fable/Mythos 5 family).
      // Retry ONCE with native structured output forced — that request body
      // carries no tool and no tool_choice at all, so there is nothing to
      // reject. Same model: this is a capability mismatch, not a dead model.
      console.warn(
        `[ai] ${feature}: ${modelId} rejects forced tool use → retrying with native structured output`,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await generateObject({
        ...withAnthropicStructuredOutput(feature, opts, true),
        model: getModelForFeature(feature),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }
    if (!isModelUnavailable(err)) throw err;
    dropModelFromCatalog(modelId);
    const next = resolveFeatureModel(feature).modelId;
    console.warn(`[ai] ${feature}: ${modelId} unavailable → retrying with re-resolved model ${next}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await generateObject({
      ...withAnthropicStructuredOutput(feature, opts, false),
      model: getModelForFeature(feature),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }
}
