/**
 * Shared classifier for Anthropic SDK `APIError`s, used by every call site
 * that talks to Claude directly and needs to turn an upstream failure into
 * a plain-language, user-safe message (never the raw JSON body / request_id).
 *
 * The motivating bug: Anthropic returns HTTP 400 both for genuinely bad
 * request content (a corrupt PDF/image) AND for account-level faults
 * (billing, bad API key, org limits) — e.g. `{"type":"error","error":
 * {"type":"invalid_request_error","message":"Your credit balance is too
 * low..."}}`. Treating every 400 as "your file is bad" sends an
 * account-level failure into a retry loop that can never succeed
 * (see lib/earnings/extract-bogeys.ts and lib/research-documents/extract.ts).
 *
 * Two entry points share the same pattern-matching core:
 *   - classifyAnthropicError(err) — call sites that still hold the original
 *     caught error (can check `instanceof APIError` and read `err.error`,
 *     the parsed JSON body).
 *   - classifyAnthropicErrorMessage(message) — call sites that only kept
 *     `error.message` (a string shaped like `"400 {...}"`, which is what
 *     `APIError.message` itself looks like) — e.g. lib/import/error-classify.ts,
 *     which classifies by string because that's all its caller preserved.
 *     It also accepts the BARE nested message (no "<status> {json}" prefix) —
 *     the shape the AI SDK's `APICallError` leaves behind — but only for the
 *     high-confidence families that quote nothing back.
 */

import { APIError } from "@anthropic-ai/sdk";

export type AnthropicFailureKind =
  | "billing"
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "content"
  | "model_capability"
  | "unknown";

export interface AnthropicErrorClassification {
  kind: AnthropicFailureKind;
  status: number;
  /** Plain-language message — safe to render to an end user verbatim. */
  userMessage: string;
}

const BILLING_PATTERNS: RegExp[] = [
  /credit balance/i,
  /plans\s*&\s*billing/i,
  /purchase credits/i,
  /\bbilling\b/i,
];

// The request itself is well-formed; the MODEL the app picked can't do part of
// it. Anthropic's Fable/Mythos 5 family is the live case — it rejects forced
// tool use (`tool_choice` "any"/"tool") with a 400:
//   tool_choice: type "tool" and "any" are not supported for this model.
// Checked BEFORE the content patterns, which would otherwise never match this
// text and drop it into the generic "unknown" bucket with an upstream code.
const MODEL_CAPABILITY_PATTERNS: RegExp[] = [
  /tool_choice[\s\S]{0,200}?not supported for this model/i,
  /\bnot supported for this model\b/i,
];

const AUTH_PATTERNS: RegExp[] = [
  /invalid x-api-key/i,
  /authentication_error/i,
  /invalid api key/i,
];

// Phrases Anthropic actually uses when rejecting the DOCUMENT/IMAGE we sent,
// as opposed to rejecting the request for account-level reasons.
const CONTENT_PATTERNS: RegExp[] = [
  /\bimage\b/i,
  /\bdocument\b/i,
  /\bmedia\b/i,
  /\bpdf\b/i,
  /could not (?:be )?process/i,
  /invalid base ?64/i,
  /\bexceeds\b/i,
];

const MAX_UPSTREAM_TEXT = 160;

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  const slice = trimmed.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

const AUTH_MESSAGE =
  "The AI service rejected the request (API key/authentication problem). This is a server-side configuration issue, not a problem with your file.";
const RATE_LIMIT_MESSAGE =
  "The AI service is rate-limiting requests right now. Try again in a minute.";
const OVERLOADED_MESSAGE = "The AI service is temporarily overloaded. Try again in a minute.";
const MODEL_CAPABILITY_MESSAGE =
  "The AI model this feature is set to use can't handle this kind of request. That's a setup problem on our side, not a problem with your data.";

// Error `type` discriminators Anthropic's own error body carries — checked
// BEFORE the prose-substring patterns below, which exist only for shapes
// that don't carry (or didn't preserve) a `type` field at all.
const AUTH_ERROR_TYPES = new Set(["authentication_error", "permission_error"]);
const RATE_LIMIT_ERROR_TYPES = new Set(["rate_limit_error"]);
const OVERLOADED_ERROR_TYPES = new Set(["overloaded_error"]);

interface ClassifyOptions {
  /** `error.error.type` from a well-formed Anthropic error body, when present. */
  errorType?: string | null;
  /**
   * True when the caller could NOT recover a well-formed `error.error.message`
   * string (a non-JSON body — e.g. a gateway HTML page — or a JSON body
   * missing that field). `text` is empty in that case: a 400 with no other
   * signal falls back to a generic (non-embedding) content-kind message
   * rather than pattern-matching or quoting untrusted raw upstream text.
   */
  assumeContentFallback?: boolean;
}

function classify(
  status: number,
  text: string,
  options: ClassifyOptions = {},
): AnthropicErrorClassification {
  const { errorType = null, assumeContentFallback = false } = options;

  if (errorType && AUTH_ERROR_TYPES.has(errorType)) {
    return { kind: "auth", status, userMessage: AUTH_MESSAGE };
  }
  if (errorType && RATE_LIMIT_ERROR_TYPES.has(errorType)) {
    return { kind: "rate_limit", status, userMessage: RATE_LIMIT_MESSAGE };
  }
  if (errorType && OVERLOADED_ERROR_TYPES.has(errorType)) {
    return { kind: "overloaded", status, userMessage: OVERLOADED_MESSAGE };
  }

  if (MODEL_CAPABILITY_PATTERNS.some((p) => p.test(text))) {
    return { kind: "model_capability", status, userMessage: MODEL_CAPABILITY_MESSAGE };
  }
  if (BILLING_PATTERNS.some((p) => p.test(text))) {
    return {
      kind: "billing",
      status,
      userMessage:
        "The AI service is unavailable — the account's Anthropic billing needs attention. This isn't a problem with your file; try again once billing is resolved.",
    };
  }
  if (status === 401 || AUTH_PATTERNS.some((p) => p.test(text))) {
    return { kind: "auth", status, userMessage: AUTH_MESSAGE };
  }
  if (status === 429) {
    return { kind: "rate_limit", status, userMessage: RATE_LIMIT_MESSAGE };
  }
  if (status === 529) {
    return { kind: "overloaded", status, userMessage: OVERLOADED_MESSAGE };
  }
  if (status === 400) {
    if (CONTENT_PATTERNS.some((p) => p.test(text))) {
      return {
        kind: "content",
        status,
        userMessage: `The AI service couldn't process this file: ${truncate(text, MAX_UPSTREAM_TEXT)}`,
      };
    }
    // No well-formed message to pattern-match (and nothing safe to quote) —
    // still the most likely bucket for a bare 400, but with generic wording
    // only; never fall back to embedding the raw (possibly non-JSON) body.
    if (assumeContentFallback) {
      return {
        kind: "content",
        status,
        userMessage: "The AI service couldn't process this file. Try again in a minute.",
      };
    }
  }
  return {
    kind: "unknown",
    status,
    userMessage: status
      ? `The AI service failed (upstream ${status}). Try again in a minute.`
      : "The AI service failed. Try again in a minute.",
  };
}

/**
 * Classify a caught error from an Anthropic SDK call. Returns null when
 * `err` isn't an `APIError` at all (network errors, etc.) — callers keep
 * their own fallback wording for those.
 */
export function classifyAnthropicError(err: unknown): AnthropicErrorClassification | null {
  if (!(err instanceof APIError)) return null;
  const status = err.status ?? 0;
  const body = err.error as { error?: { type?: unknown; message?: unknown } } | undefined;
  const nestedMessage = body?.error?.message;
  const nestedType = body?.error?.type;
  const hasWellFormedMessage = typeof nestedMessage === "string";
  // `err.error` is undefined when the upstream body wasn't JSON at all (a
  // gateway HTML page, per the SDK) — `err.message` in that case is the raw
  // "<status> <body>" text, which must never be pattern-matched or quoted
  // back to the user (it can carry arbitrary upstream content).
  const text = hasWellFormedMessage ? (nestedMessage as string) : "";
  const errorType = typeof nestedType === "string" ? nestedType : null;
  return classify(status, text, { errorType, assumeContentFallback: !hasWellFormedMessage });
}

/**
 * Classify an Anthropic error by its MESSAGE STRING alone (the shape
 * `APIError.message` itself takes: `"<status> <json-or-text>"`). For
 * callers that only preserved `error.message` and not the original error
 * object. Returns null when the string doesn't look like an Anthropic API
 * error envelope at all, so callers can fall back to their own logic.
 */
export function classifyAnthropicErrorMessage(message: string): AnthropicErrorClassification | null {
  const match = message.match(/^(\d{3})\s([\s\S]+)$/);
  if (!match) return classifyBareMessage(message);

  const status = parseInt(match[1], 10);
  const rest = match[2];

  let parsed: { type?: unknown; error?: { type?: unknown; message?: unknown } };
  try {
    parsed = JSON.parse(rest);
  } catch {
    return classifyBareMessage(message);
  }
  if (parsed?.type !== "error") return classifyBareMessage(message);

  const nestedMessage = parsed.error?.message;
  const nestedType = parsed.error?.type;
  const hasWellFormedMessage = typeof nestedMessage === "string";
  // Same rule as classifyAnthropicError: never fall back to the raw envelope
  // text (`rest`) for pattern-matching/quoting — it carries the request_id.
  const text = hasWellFormedMessage ? (nestedMessage as string) : "";
  const errorType = typeof nestedType === "string" ? nestedType : null;
  return classify(status, text, { errorType, assumeContentFallback: !hasWellFormedMessage });
}

/**
 * Some transports strip Anthropic's envelope and keep ONLY the nested
 * `error.message` — notably the AI SDK's `APICallError`, which is what
 * `generateObject`/`generateText` throw (`err.message` is the bare upstream
 * prose, with no "<status> {json}" prefix to parse). Only the high-confidence,
 * non-quoting pattern families are recognized in that shape; anything else
 * stays null so the caller keeps its own wording and no untrusted upstream
 * text is ever echoed back to the UI.
 *
 * `status` is 0 here: a bare message carries no status we can trust.
 */
function classifyBareMessage(message: string): AnthropicErrorClassification | null {
  if (MODEL_CAPABILITY_PATTERNS.some((p) => p.test(message))) {
    return { kind: "model_capability", status: 0, userMessage: MODEL_CAPABILITY_MESSAGE };
  }
  return null;
}
