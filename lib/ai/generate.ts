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
 *   4. A content-free usage line (2026-11-15) — every completed call writes ONE
 *      `[ai-usage]` line to the server log (feature, the model that answered,
 *      token counts, finish reason, duration; never prompt or reply text), and
 *      the result carries `answeredModelId` so a caller can record the model
 *      that really answered after a failover. See `formatAiUsageLine`.
 *
 * Call sites swap `generateText({ model: getModelForFeature(x), ...opts })` for
 * `generateTextForFeature(x, opts)` — same options minus `model`.
 *
 * Step 0 confirmed: @ai-sdk/anthropic maps Anthropic `stop_reason: "refusal"`
 * to the normalized finishReason `"content-filter"` (index.js:2792-2793).
 * APICallError.isInstance is a function (verified at runtime) with statusCode
 * typed as optional number on the class.
 */

import { generateText, generateObject, APICallError, NoObjectGeneratedError } from "ai";
import type { FeatureKey } from "@/lib/ai/feature-keys";
import { getModelForFeature, getModelForId } from "@/lib/ai/provider";
import type { StoredSummaryFamily, SummaryEffort } from "@/lib/filing-summary/types";
import { resolveFeatureModel } from "@/lib/ai/models";
import { dropModelFromCatalog } from "@/lib/ai/catalog-source";
import { FORCED_TOOL_UNSUPPORTED_RE } from "@/lib/ai/classify-anthropic-error";
import { failOverOnAccountFailure } from "@/lib/ai/failover";

export class AIRefusalError extends Error {
  /** The SDK usage of the refused call when the SDK reported one (it was still billed). */
  public usage?: unknown;
  constructor(public feature: FeatureKey, public modelId: string, usage?: unknown) {
    super(`AI refused request for feature "${feature}" (model ${modelId})`);
    this.name = "AIRefusalError";
    if (usage !== undefined) this.usage = usage;
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
const FORCED_TOOL_UNSUPPORTED = FORCED_TOOL_UNSUPPORTED_RE;

export function isForcedToolUnsupported(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (FORCED_TOOL_UNSUPPORTED.test(msg)) return true;
  if (APICallError.isInstance(err) && err.statusCode === 400) {
    const body = typeof err.responseBody === "string" ? err.responseBody : "";
    if (FORCED_TOOL_UNSUPPORTED.test(body)) return true;
  }
  return false;
}

/**
 * The provider rejected the NATIVE structured-output request itself
 * (`output_config.format` / json_schema unsupported on this model, or a schema
 * keyword the native mode refuses). Only meaningful on a 400.
 */
const OUTPUT_FORMAT_REJECTED =
  /output_config|output_format|outputFormat|json_schema|structured output|(?:for 'array' type|property '\w+')[\s\S]{0,120}not supported/i;

export function isOutputFormatRejected(err: unknown): boolean {
  if (isForcedToolUnsupported(err)) return false;
  const msg = err instanceof Error ? err.message : String(err);
  const status = (err as { statusCode?: number } | null)?.statusCode;
  const is400 = status === 400 || /\b400\b|invalid_request_error/i.test(msg);
  if (!is400) return false;
  if (OUTPUT_FORMAT_REJECTED.test(msg)) return true;
  if (APICallError.isInstance(err) && typeof err.responseBody === "string") {
    return OUTPUT_FORMAT_REJECTED.test(err.responseBody);
  }
  return false;
}

// ─── Usage line (content-free) ──────────────────────────────────────────────
//
// Follows lib/chat/usage-log.ts: an allowlisted JSON line on the server log,
// built key by key, every value coerced to a number, a short token or null.
// Never prompt text, reply text, tool input/output or a portfolio figure. No
// database (lib/ai never imports the db singleton) and no new table.

export const AI_USAGE_LINE_PREFIX = "[ai-usage] ";

export interface AiUsageLineFields {
  /** Which helper made the call. */
  kind: "text" | "object";
  feature: string;
  /** The model id that answered (the provider's response id when it sent one). */
  model: string | null | undefined;
  finishReason: string | null | undefined;
  durationMs: number | null | undefined;
  /** The SDK's `LanguageModelUsage` (or anything shaped like it). */
  usage: unknown;
}

function usageNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function usageToken(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return v.length <= 100 ? v : v.slice(0, 100);
}

function usageField(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object") return undefined;
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

export function formatAiUsageLine(fields: AiUsageLineFields): string {
  const u = fields.usage;
  const inDetails = usageField(u, "inputTokenDetails");
  const outDetails = usageField(u, "outputTokenDetails");
  const line: Record<string, number | string | null> = {
    kind: fields.kind === "object" ? "object" : "text",
    feature: usageToken(fields.feature),
    model: usageToken(fields.model),
    input: usageNum(usageField(u, "inputTokens")),
    noCache: usageNum(usageField(inDetails, "noCacheTokens")),
    cacheRead: usageNum(usageField(inDetails, "cacheReadTokens")),
    cacheWrite: usageNum(usageField(inDetails, "cacheWriteTokens")),
    output: usageNum(usageField(u, "outputTokens")),
    reasoning: usageNum(usageField(outDetails, "reasoningTokens")),
    finishReason: usageToken(fields.finishReason),
    durationMs: usageNum(fields.durationMs),
  };
  return AI_USAGE_LINE_PREFIX + JSON.stringify(line);
}

/** Never throws into the caller: a broken log sink is not a failed AI call. */
function logAiUsage(fields: AiUsageLineFields): void {
  try {
    console.log(formatAiUsageLine(fields));
  } catch {
    // The line is observability only.
  }
}

/** Added to every helper result: the model id that actually answered. */
export interface AnsweredModel {
  answeredModelId?: string;
}

function responseModelIdOf(res: unknown): string | null {
  const id = usageField(usageField(res, "response"), "modelId");
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Run one provider call, then log it and stamp `answeredModelId` on the
 * result. The field is NON-enumerable so a caller's or a mock's `toEqual` on
 * the result is unchanged. A NoObjectGeneratedError (the call completed and was
 * billed, the reply did not parse, e.g. cut off at the cap) is logged too and
 * rethrown untouched; any other failure did not complete and writes no line.
 */
async function observedCall<T>(
  feature: FeatureKey,
  kind: "text" | "object",
  sentModelId: string,
  run: () => Promise<T>,
): Promise<T & AnsweredModel> {
  const started = Date.now();
  let res: T;
  try {
    res = await run();
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err)) {
      logAiUsage({
        kind,
        feature,
        model: responseModelIdOf(err) ?? sentModelId,
        finishReason: err.finishReason ?? null,
        durationMs: Date.now() - started,
        usage: err.usage,
      });
    }
    throw err;
  }
  const answered = responseModelIdOf(res) ?? sentModelId;
  const total = usageField(res, "totalUsage");
  logAiUsage({
    kind,
    feature,
    model: answered,
    finishReason: usageToken(usageField(res, "finishReason")),
    durationMs: Date.now() - started,
    usage: total !== null && typeof total === "object" ? total : usageField(res, "usage"),
  });
  stampAnsweredModelId(res, answered);
  return res as T & AnsweredModel;
}

/**
 * Put `answeredModelId` on a result as a NON-enumerable field, so a caller's
 * or a mock's `toEqual` on the result is unchanged. Never throws.
 */
function stampAnsweredModelId(res: unknown, answered: string): void {
  if (res === null || typeof res !== "object") return;
  try {
    Object.defineProperty(res, "answeredModelId", {
      value: answered,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // A frozen result keeps its shape; the caller falls back to its own id.
  }
}

// Omit `model` so callers don't need to supply it — the wrapper resolves it.
// We use a loose type to avoid fighting AI SDK's internal generics (tools, etc.).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GenTextOpts = Omit<Parameters<typeof generateText<any, any>>[0], "model">;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GenObjOpts = Omit<Parameters<typeof generateObject<any>>[0], "model">;

/**
 * Provider failover (design slice 2): an account-level failure (billing / auth /
 * config) of the primary provider on a failover-enabled feature is retried on
 * the next provider; anything else — including every parked feature — rethrows
 * the primary's error unchanged. See lib/ai/failover.ts.
 */
export async function generateTextForFeature(feature: FeatureKey, opts: GenTextOpts) {
  try {
    return await generateTextOnPrimary(feature, opts);
  } catch (err) {
    return failOverOnAccountFailure(feature, err, async (model, target) => {
      const res = await observedCall(feature, "text", target.modelId, () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        generateText({ ...opts, model } as any),
      );
      if (REFUSAL_FINISH.has(res.finishReason)) throw new AIRefusalError(feature, target.modelId);
      return res;
    });
  }
}

async function generateTextOnPrimary(feature: FeatureKey, opts: GenTextOpts) {
  let { modelId } = resolveFeatureModel(feature);
  try {
    const res = await observedCall(feature, "text", modelId, () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generateText({ ...opts, model: getModelForFeature(feature) } as any),
    );
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
    const res = await observedCall(feature, "text", modelId, () =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      generateText({ ...opts, model: getModelForFeature(feature) } as any),
    );
    if (REFUSAL_FINISH.has(res.finishReason)) throw new AIRefusalError(feature, modelId);
    return res;
  }
}

type StructuredMode = "outputFormat" | "jsonTool";

function anthropicModeOf(opts: GenObjOpts): unknown {
  const po = (opts as { providerOptions?: Record<string, Record<string, unknown>> }).providerOptions;
  return po?.anthropic?.structuredOutputMode;
}

/**
 * Ask @ai-sdk/anthropic for Anthropic's NATIVE structured output instead of the
 * synthetic-json-tool fallback (see item 3 in the file header). Only applies to
 * the Anthropic provider; every other provider's options are left untouched.
 *
 * `force` overrides a caller-supplied mode with `mode` (used by the retries).
 */
function withAnthropicStructuredOutput(
  feature: FeatureKey,
  opts: GenObjOpts,
  force: boolean,
  mode: StructuredMode = "outputFormat",
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
      anthropic: { ...anthropicOptions, structuredOutputMode: mode },
    },
  } as GenObjOpts;
}

export async function generateObjectForFeature(feature: FeatureKey, opts: GenObjOpts) {
  try {
    return await generateObjectOnPrimary(feature, opts);
  } catch (err) {
    return failOverOnAccountFailure(feature, err, (model, target) =>
      observedCall(feature, "object", target.modelId, () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        generateObject({ ...opts, model } as any),
      ),
    );
  }
}

async function generateObjectOnPrimary(feature: FeatureKey, opts: GenObjOpts) {
  const { modelId, provider } = resolveFeatureModel(feature);
  // The mode the FIRST request actually carries (caller's, else our default).
  const firstMode =
    provider === "anthropic" ? (anthropicModeOf(opts) ?? "outputFormat") : undefined;
  try {
    return await observedCall(feature, "object", modelId, () =>
      generateObject({
        ...withAnthropicStructuredOutput(feature, opts, false),
        model: getModelForFeature(feature),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    );
  } catch (err) {
    if (isForcedToolUnsupported(err)) {
      // Retry ONCE with native structured output forced — no tool, no
      // tool_choice in the body. Only worth it when the first request was NOT
      // already that request: otherwise the retry is byte-identical and can
      // only fail the same way (wasted round-trip), so surface the error.
      if (provider !== "anthropic" || firstMode === "outputFormat") throw err;
      console.warn(
        `[ai] ${feature}: ${modelId} rejects forced tool use → retrying with native structured output`,
      );
      return await observedCall(feature, "object", modelId, () =>
        generateObject({
          ...withAnthropicStructuredOutput(feature, opts, true, "outputFormat"),
          model: getModelForFeature(feature),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      );
    }
    if (isOutputFormatRejected(err)) {
      // The model (e.g. a tier that degraded to one without native structured
      // output) rejects the native request. Retry ONCE via the JSON-tool path.
      // Skip when that is what we already sent (identical request).
      if (provider !== "anthropic" || firstMode === "jsonTool") throw err;
      console.warn(
        `[ai] ${feature}: ${modelId} rejects native structured output → retrying with JSON-tool path`,
      );
      return await observedCall(feature, "object", modelId, () =>
        generateObject({
          ...withAnthropicStructuredOutput(feature, opts, true, "jsonTool"),
          model: getModelForFeature(feature),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any),
      );
    }
    if (!isModelUnavailable(err)) throw err;
    dropModelFromCatalog(modelId);
    const next = resolveFeatureModel(feature).modelId;
    console.warn(`[ai] ${feature}: ${modelId} unavailable → retrying with re-resolved model ${next}`);
    return await observedCall(feature, "object", next, () =>
      generateObject({
        ...withAnthropicStructuredOutput(feature, opts, false),
        model: getModelForFeature(feature),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    );
  }
}

/** The explicitly chosen model is not callable (404 / not_found). No failover. */
export class AIModelUnavailableError extends Error {
  constructor(public feature: FeatureKey, public modelId: string) {
    super(`Model ${modelId} is unavailable for feature "${feature}"`);
    this.name = "AIModelUnavailableError";
  }
}

/** The model stopped at the output-token limit; the object is incomplete. */
export class AITruncatedError extends Error {
  /** The SDK usage of the truncated call when the SDK reported one (it was still billed). */
  public usage?: unknown;
  constructor(public feature: FeatureKey, public modelId: string, usage?: unknown) {
    super(`AI output truncated at the token limit for feature "${feature}" (model ${modelId})`);
    this.name = "AITruncatedError";
    if (usage !== undefined) this.usage = usage;
  }
}

export interface ExplicitModelTarget {
  modelId: string;
  effort: SummaryEffort;
  /**
   * A run is PINNED to the family and model id it started on, so a resumed or
   * retried run from before 2026-11-07 can still arrive here naming a retired
   * family. The thinking carve-out below is why this stays wide.
   */
  family: StoredSummaryFamily;
}

/**
 * One structured call on an EXPLICIT model at an EXPLICIT effort, for a caller
 * that resolved the model itself (lib/ai/model-families.ts) and owns its own
 * attempt budget. Unlike generateObjectForFeature there is no failover and no
 * mode retry, and the SDK's own retries are off (`maxRetries: 0`) so every
 * request counts inside the caller's budget:
 *   - model unavailable  → AIModelUnavailableError (the caller decides)
 *   - finish "content-filter" (refusal) → AIRefusalError
 *   - finish "length" (truncated)       → AITruncatedError
 * Native structured output is always requested; adaptive thinking is sent for
 * every family except Fable (thinking is always on there and the parameter
 * 400s). Fable is no longer selectable (2026-11-07) but a run pinned to it
 * before then still resumes on it, so the carve-out stays.
 *
 * Every completed call writes the same content-free `[ai-usage]` line as the
 * feature helpers (`observedCall`; a billed cut-off or refusal included), and
 * the result carries the non-enumerable `answeredModelId`.
 */
export async function generateObjectWithModel(
  feature: FeatureKey,
  target: ExplicitModelTarget,
  opts: GenObjOpts & { maxOutputTokens: number },
): Promise<{ object: unknown; usage: unknown; finishReason: string } & AnsweredModel> {
  const { modelId, effort, family } = target;
  const callerProviderOptions = (opts as { providerOptions?: Record<string, Record<string, unknown>> })
    .providerOptions;
  const anthropic = {
    structuredOutputMode: "outputFormat",
    effort,
    ...(family === "fable" ? {} : { thinking: { type: "adaptive" } }),
  };
  let res: { object: unknown; usage: unknown; finishReason: string } & AnsweredModel;
  try {
    res = await observedCall(feature, "object", modelId, () =>
      generateObject({
        ...opts,
        providerOptions: { ...callerProviderOptions, anthropic },
        model: getModelForId(feature, modelId),
        maxRetries: 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any) as Promise<{ object: unknown; usage: unknown; finishReason: string }>,
    );
  } catch (err) {
    if (isModelUnavailable(err)) throw new AIModelUnavailableError(feature, modelId);
    // A truncated or refused response often fails to parse; the SDK then
    // throws NoObjectGeneratedError carrying the finish reason.
    if (NoObjectGeneratedError.isInstance(err)) {
      // The error carries the call's usage (ai v6 NoObjectGeneratedError.usage).
      if (err.finishReason === "length") throw new AITruncatedError(feature, modelId, err.usage);
      if (err.finishReason && REFUSAL_FINISH.has(err.finishReason)) {
        throw new AIRefusalError(feature, modelId, err.usage);
      }
    }
    throw err;
  }
  if (REFUSAL_FINISH.has(res.finishReason)) throw new AIRefusalError(feature, modelId, res.usage);
  if (res.finishReason === "length") throw new AITruncatedError(feature, modelId, res.usage);
  const out: { object: unknown; usage: unknown; finishReason: string } & AnsweredModel = {
    object: res.object,
    usage: res.usage,
    finishReason: res.finishReason,
  };
  // Read directly: the field is non-enumerable and a spread would drop it.
  stampAnsweredModelId(out, res.answeredModelId ?? modelId);
  return out;
}
