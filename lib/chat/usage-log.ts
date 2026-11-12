/**
 * Chat server-log lines (Portfolio Assistant plan, D6 and P15).
 *
 * Every line the chat route writes goes through these helpers, and each one
 * is ALLOWLISTED: it carries token counts, ids, the scope, the model id and a
 * finish reason, or for an error its name, status code, provider error type
 * and a truncated message. Never message content, prompt text, tool input or
 * output, or a portfolio figure. In particular an SDK `APICallError` holds the
 * whole prompt in `requestBodyValues` (and often in `responseBody` / `cause`);
 * none of those is ever read here.
 *
 * Imports nothing but types, so a test can exercise it without the SDK.
 */

export const USAGE_LINE_PREFIX = "[chat-usage] ";

export const USAGE_LINE_KEYS_STEP = [
  "kind",
  "conversationId",
  "scope",
  "model",
  "step",
  "noCache",
  "cacheWrite",
  "cacheRead",
  "output",
  "finishReason",
] as const;

export const USAGE_LINE_KEYS_TURN = [
  "kind",
  "conversationId",
  "scope",
  "model",
  "steps",
  "noCache",
  "cacheWrite",
  "cacheRead",
  "output",
  "finishReason",
  "abortedSteps",
  "abortedOutputEstimate",
  "abortedInputEstimate",
  "abortedInputCache",
  "abortedStepProcessed",
] as const;

export interface UsageTokenFields {
  noCache: number | null | undefined;
  cacheWrite: number | null | undefined;
  cacheRead: number | null | undefined;
  output: number | null | undefined;
}

interface UsageCommonFields extends UsageTokenFields {
  conversationId: number | null | undefined;
  scope: string | null | undefined;
  model: string | null | undefined;
  finishReason: string | null | undefined;
}

export interface UsageStepFields extends UsageCommonFields {
  /** Zero-based step number. */
  step: number;
}

export interface UsageTurnFields extends UsageCommonFields {
  /** Number of finished steps in the turn (their counts are the provider's). */
  steps: number;
  /**
   * Steps cut off by an abort (Stop or a closed tab): 0 or 1. The provider
   * reports no usage for such a step, so the token fields above leave it out.
   */
  abortedSteps?: number;
  /**
   * An ESTIMATE of the aborted step's output tokens (characters streamed
   * divided by `ABORTED_CHARS_PER_TOKEN`), or null when no step was aborted.
   */
  abortedOutputEstimate?: number | null;
  /**
   * An ESTIMATE of the aborted step's input tokens: characters of what the
   * route sent for that step (tool definitions, system blocks, messages)
   * divided by `ABORTED_INPUT_CHARS_PER_TOKEN`; null when no step was aborted.
   */
  abortedInputEstimate?: number | null;
  /**
   * Always "unknown" for an aborted step: its input may have been a cache
   * write, a cache read, or not processed at all.
   */
  abortedInputCache?: "unknown" | null;
  /**
   * "chunks-received" when any part of the step's reply arrived (the
   * provider accepted the request); "maybe-not" when the abort came before
   * the first chunk (the step may not have been processed).
   */
  abortedStepProcessed?: "chunks-received" | "maybe-not" | null;
}

/**
 * The stated ratio behind `abortedInputEstimate`: characters of serialised
 * request content per input token (the eval script measured about 3.7 for
 * this content).
 */
export const ABORTED_INPUT_CHARS_PER_TOKEN = 3.7;

/** Estimated input tokens for `chars` characters sent for an aborted step. */
export function estimateAbortedInputTokens(chars: number): number {
  return chars > 0 ? Math.ceil(chars / ABORTED_INPUT_CHARS_PER_TOKEN) : 0;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

/** The stated ratio behind `abortedOutputEstimate`: characters per output token. */
export const ABORTED_CHARS_PER_TOKEN = 4;

/** Estimated output tokens for `chars` characters streamed by an aborted step. */
export function estimateAbortedOutputTokens(chars: number): number {
  return chars > 0 ? Math.ceil(chars / ABORTED_CHARS_PER_TOKEN) : 0;
}

/** Structural view of the SDK's `LanguageModelUsage` that this file reads. */
export interface UsageLike {
  inputTokens?: number | undefined;
  inputTokenDetails?: {
    noCacheTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
  };
  outputTokens?: number | undefined;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A short identifier-like string (model id, scope, finish reason), or null. */
function token(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return v.length <= 100 ? v : v.slice(0, 100);
}

export function usageTokenFields(usage: UsageLike | undefined | null): {
  noCache: number | null;
  cacheWrite: number | null;
  cacheRead: number | null;
  output: number | null;
} {
  return {
    noCache: num(usage?.inputTokenDetails?.noCacheTokens),
    cacheWrite: num(usage?.inputTokenDetails?.cacheWriteTokens),
    cacheRead: num(usage?.inputTokenDetails?.cacheReadTokens),
    output: num(usage?.outputTokens),
  };
}

export function formatUsageLine(kind: "step", fields: UsageStepFields): string;
export function formatUsageLine(kind: "turn", fields: UsageTurnFields): string;
export function formatUsageLine(kind: "step" | "turn", fields: UsageStepFields | UsageTurnFields): string {
  // Built key by key from the allowlist: an extra field on `fields` never
  // reaches the line, and every value is coerced to a number, a short token
  // or null.
  const f = fields as unknown as Record<string, unknown>;
  const line: Record<string, number | string | null> = {
    kind,
    conversationId: num(f.conversationId),
    scope: token(f.scope),
    model: token(f.model),
  };
  if (kind === "step") line.step = num(f.step);
  else line.steps = num(f.steps);
  line.noCache = num(f.noCache);
  line.cacheWrite = num(f.cacheWrite);
  line.cacheRead = num(f.cacheRead);
  line.output = num(f.output);
  line.finishReason = token(f.finishReason);
  if (kind === "turn") {
    line.abortedSteps = num(f.abortedSteps) ?? 0;
    line.abortedOutputEstimate = num(f.abortedOutputEstimate);
    line.abortedInputEstimate = num(f.abortedInputEstimate);
    line.abortedInputCache = oneOf(f.abortedInputCache, ["unknown"] as const);
    line.abortedStepProcessed = oneOf(f.abortedStepProcessed, ["chunks-received", "maybe-not"] as const);
  }
  return USAGE_LINE_PREFIX + JSON.stringify(line);
}

export function logUsageStep(fields: UsageStepFields): void {
  console.log(formatUsageLine("step", fields));
}

export function logUsageTurn(fields: UsageTurnFields): void {
  console.log(formatUsageLine("turn", fields));
}

// ─── Errors ─────────────────────────────────────────────────────

export const ERROR_MESSAGE_MAX = 200;

export interface SafeChatError {
  name: string;
  statusCode: number | null;
  providerErrorType: string | null;
  message: string;
}

function readField(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object") return undefined;
  try {
    return (obj as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** The provider's error type from an `APICallError.data` (`{ error: { type } }`). */
function providerErrorTypeOf(err: unknown): string | null {
  return token(readField(readField(readField(err, "data"), "error"), "type"));
}

/**
 * Reduce any thrown value to the allowlisted fields. Reads `name`,
 * `statusCode`, `data.error.type` and `message` only (and the same from a
 * retry wrapper's `lastError`); never `requestBodyValues`, `responseBody`,
 * `cause` or any other field.
 */
export function formatChatError(error: unknown): SafeChatError {
  const inner = readField(error, "lastError");
  const name = token(readField(error, "name")) ?? "unknown";
  const statusCode = num(readField(error, "statusCode")) ?? num(readField(inner, "statusCode"));
  const providerErrorType = providerErrorTypeOf(error) ?? providerErrorTypeOf(inner);
  const rawMessage =
    typeof error === "string" ? error : typeof readField(error, "message") === "string" ? (readField(error, "message") as string) : "";
  return {
    name,
    statusCode,
    providerErrorType,
    message: rawMessage.slice(0, ERROR_MESSAGE_MAX),
  };
}

/** The one way the chat logs an error: a single string argument, allowlisted. */
export function logChatError(where: string, error: unknown): void {
  console.error(`[chat] ${token(where) ?? "error"}: ${JSON.stringify(formatChatError(error))}`);
}

/** A warning with no error object (e.g. a refusal); the text is the caller's own. */
export function logChatWarning(text: string): void {
  console.warn(`[chat] ${text.slice(0, ERROR_MESSAGE_MAX)}`);
}
