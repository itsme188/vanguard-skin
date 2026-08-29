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
 */

import { APIError } from "@anthropic-ai/sdk";

export type AnthropicFailureKind =
  | "billing"
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "content"
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

function classify(status: number, text: string): AnthropicErrorClassification {
  if (BILLING_PATTERNS.some((p) => p.test(text))) {
    return {
      kind: "billing",
      status,
      userMessage:
        "The AI service is unavailable — the account's Anthropic billing needs attention. This isn't a problem with your file; try again once billing is resolved.",
    };
  }
  if (status === 401 || AUTH_PATTERNS.some((p) => p.test(text))) {
    return {
      kind: "auth",
      status,
      userMessage:
        "The AI service rejected the request (API key/authentication problem). This is a server-side configuration issue, not a problem with your file.",
    };
  }
  if (status === 429) {
    return {
      kind: "rate_limit",
      status,
      userMessage: "The AI service is rate-limiting requests right now. Try again in a minute.",
    };
  }
  if (status === 529) {
    return {
      kind: "overloaded",
      status,
      userMessage: "The AI service is temporarily overloaded. Try again in a minute.",
    };
  }
  if (status === 400 && CONTENT_PATTERNS.some((p) => p.test(text))) {
    return {
      kind: "content",
      status,
      userMessage: `The AI service couldn't process this file: ${truncate(text, MAX_UPSTREAM_TEXT)}`,
    };
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
  const body = err.error as { error?: { message?: unknown } } | undefined;
  const nested = body?.error?.message;
  const text = typeof nested === "string" ? nested : err.message;
  return classify(status, text);
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
  if (!match) return null;

  const status = parseInt(match[1], 10);
  const rest = match[2];

  let nested: string | null = null;
  try {
    const parsed = JSON.parse(rest) as { type?: unknown; error?: { message?: unknown } };
    if (parsed?.type !== "error") return null;
    if (typeof parsed.error?.message === "string") nested = parsed.error.message;
  } catch {
    return null;
  }

  return classify(status, nested ?? rest);
}
