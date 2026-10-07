/**
 * Who is at fault when a newsletter enrichment call fails: the ACCOUNT (the
 * provider cannot serve anyone right now) or the ARTICLE (this one piece of
 * content cannot be enriched).
 *
 * Why it matters (finding
 * research-feeds--billing-outage-burned-enrich-retry-cap-no-retry-when-credit-returns):
 * the retry cap in lib/gmail/process.ts used to count every failure. When the
 * API key ran out of credit, every article that arrived during the outage
 * burned its three attempts on a billing error and was excluded for good.
 * Owner ruling: an account-level failure never counts toward the cap and
 * leaves the article queued; an article-level failure counts as before.
 *
 * WHAT THE ERROR REALLY LOOKS LIKE HERE. Enrichment goes through
 * `generateObjectForFeature` (lib/ai/generate.ts), which calls the AI SDK's
 * `generateObject` with the `@ai-sdk/anthropic` provider. It does NOT use the
 * raw `@anthropic-ai/sdk` client, so the error is never that SDK's `APIError`
 * (which is what lib/ai/classify-anthropic-error.ts reads). The shapes below
 * were captured by driving the real SDK with a stubbed `fetch`
 * (tests/helpers/ai-sdk-real-errors.ts reproduces them):
 *
 *   - HTTP error response -> `APICallError` (name "AI_APICallError") with
 *     `statusCode`, `isRetryable`, `responseBody` (raw text) and, when the
 *     body is Anthropic's JSON envelope, `data = { type: "error",
 *     error: { type, message } }`. `message` is `data.error.message`, or the
 *     HTTP status text when the body is not that envelope (a proxy's HTML
 *     page).
 *   - A retryable one (408, 409, 429, any 5xx, or a network failure) is
 *     retried twice by the SDK and then arrives WRAPPED in a `RetryError`
 *     (name "AI_RetryError", message "Failed after 3 attempts. Last error:
 *     ..."), with the real error on `lastError`.
 *   - No connection at all -> `APICallError` with NO `statusCode`,
 *     `isRetryable: true`, message "Cannot connect to API: ...".
 *   - A refusal or unparseable output -> `NoObjectGeneratedError` (name
 *     "AI_NoObjectGeneratedError"); a refusal carries
 *     `finishReason: "content-filter"`.
 *
 * The AI SDK marks its error classes with `Symbol.for("vercel.ai.error.<name>")`
 * and its own `isInstance` checks read that marker. This module reads the same
 * markers instead of importing the classes, so it has no SDK import (several
 * test files replace the "ai" module wholesale) and it still recognises an
 * error thrown by a second copy of the package.
 *
 * BILLING IS THE ONE CLASS WITHOUT A RELIABLE STRUCTURED FIELD. Anthropic's
 * error union has a `billing_error` type (HTTP 402) and both are checked
 * first. But the outage that motivated this fix stored the text "Your credit
 * balance is too low ..." and the repo's other call sites record that same
 * text arriving as HTTP 400 `invalid_request_error`, the same status and type
 * as a genuinely bad request. So a 400 is told apart by its message, against
 * the narrow phrases in BILLING_PROSE. See `classifyEnrichmentError` for what
 * that can get wrong.
 */

/**
 * Retry ceiling for ARTICLE-level enrichment failures (empty parses, refusals,
 * malformed output, bad requests, unknown errors). An article that fails this
 * many passes is excluded as 'enrichment_failed' (the Filtered tab surfaces
 * it) instead of retrying forever: an uncapped retry leaks a model call per
 * pass and can wedge the LIMIT-20 queue head. Account-level failures do not
 * count toward it.
 */
export const MAX_ENRICH_ATTEMPTS = 3;

export type EnrichmentFailureScope = "account" | "article";

export type EnrichmentFailureKind =
  // account-level
  | "billing"
  | "auth"
  | "rate_limit"
  | "outage"
  | "network"
  | "config"
  // article-level
  | "refusal"
  | "malformed_output"
  | "bad_request"
  | "unknown";

export interface EnrichmentFailureClass {
  scope: EnrichmentFailureScope;
  kind: EnrichmentFailureKind;
  /** HTTP status of the failed call, when the error carried one. */
  status: number | null;
  /** Anthropic's `error.type`, when the response body carried one. */
  errorType: string | null;
}

const ACCOUNT_KINDS: ReadonlySet<EnrichmentFailureKind> = new Set([
  "billing",
  "auth",
  "rate_limit",
  "outage",
  "network",
  "config",
]);

function result(
  kind: EnrichmentFailureKind,
  status: number | null = null,
  errorType: string | null = null,
): EnrichmentFailureClass {
  return { scope: ACCOUNT_KINDS.has(kind) ? "account" : "article", kind, status, errorType };
}

/** Same check as the AI SDK's `AISDKError.hasMarker`. */
function hasAiSdkMarker(err: unknown, name: string): err is Record<string | symbol, unknown> {
  if (err == null || typeof err !== "object") return false;
  return (err as Record<symbol, unknown>)[Symbol.for(`vercel.ai.error.${name}`)] === true;
}

/** Anthropic `error.type` values that describe the account or the service. */
const ERROR_TYPE_KIND: Record<string, EnrichmentFailureKind> = {
  billing_error: "billing",
  authentication_error: "auth",
  permission_error: "auth",
  rate_limit_error: "rate_limit",
  overloaded_error: "outage",
  api_error: "outage",
  timeout_error: "outage",
};

/**
 * The phrases in Anthropic's out-of-credit message ("Your credit balance is
 * too low to access the Anthropic API. Please go to Plans & Billing to upgrade
 * or purchase credits."). Deliberately narrow: no bare "billing" or "credit".
 */
const BILLING_PROSE: RegExp[] = [
  /credit balance is too low/i,
  /plans\s*(?:&|and)\s*billing/i,
  /purchase credits/i,
];

function isBillingProse(text: string): boolean {
  return BILLING_PROSE.some((p) => p.test(text));
}

/**
 * Thrown by lib/ai/provider.ts before any request is made, when the key the
 * feature needs is not configured. Plain `Error`, so the message is all there
 * is; tests/gmail/enrichment-failure-classifier.test.ts pins the wording
 * against that file.
 */
const MISSING_CREDENTIAL = /^(?:[A-Z][A-Z0-9_]*_(?:API_KEY|TOKEN) is required for feature |Cloudflare AI Gateway must be configured )/;

/** System error codes Node and its fetch (undici) put on a failed connection. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function hasNetworkCode(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur != null && typeof cur === "object"; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

function readAnthropicEnvelope(err: Record<string | symbol, unknown>): {
  errorType: string | null;
  message: string | null;
} {
  const pick = (body: unknown) => {
    const inner = (body as { error?: { type?: unknown; message?: unknown } } | null)?.error;
    return {
      errorType: typeof inner?.type === "string" ? inner.type : null,
      message: typeof inner?.message === "string" ? inner.message : null,
    };
  };
  // `data` is the parsed envelope; it is absent when the body failed the
  // SDK's schema, so fall back to parsing the raw body ourselves.
  const fromData = pick(err.data);
  if (fromData.errorType || fromData.message) return fromData;
  if (typeof err.responseBody === "string" && err.responseBody.trim().startsWith("{")) {
    try {
      return pick(JSON.parse(err.responseBody));
    } catch {
      // not JSON: nothing structured to read
    }
  }
  return { errorType: null, message: null };
}

function classifyApiCallError(err: Record<string | symbol, unknown>): EnrichmentFailureClass {
  const status = typeof err.statusCode === "number" ? err.statusCode : null;
  const { errorType, message } = readAnthropicEnvelope(err);

  // 1. The provider's own error type, when the body carried one.
  const byType = errorType ? ERROR_TYPE_KIND[errorType] : undefined;
  if (byType) return result(byType, status, errorType);

  // 2. The HTTP status. Covers bodies that are not Anthropic's envelope (a
  //    gateway or proxy answering in its own format).
  if (status === 402) return result("billing", status, errorType);
  if (status === 401 || status === 403) return result("auth", status, errorType);
  if (status === 429) return result("rate_limit", status, errorType);
  if (status === 408 || (status !== null && status >= 500)) {
    return result("outage", status, errorType);
  }

  // 3. No response at all. The SDK builds this for a failed connection:
  //    no statusCode, isRetryable true.
  if (status === null) {
    if (err.isRetryable === true || hasNetworkCode(err)) return result("network", null, errorType);
    return result("unknown", null, errorType);
  }

  // 4. Out of credit arriving as a 4xx with a request-shaped error type. No
  //    structured field separates it from a bad request, so read the
  //    provider's message (never the article's text).
  const prose = message ?? (typeof err.message === "string" ? err.message : "");
  if (status >= 400 && status < 500 && isBillingProse(prose)) {
    return result("billing", status, errorType);
  }

  // 5. Any other 4xx is about THIS request: too long, malformed, not found.
  if (status === 400 || status === 413 || status === 422) {
    return result("bad_request", status, errorType);
  }
  return result("unknown", status, errorType);
}

/**
 * Classify an error caught around the enrichment call.
 *
 * Account-level (`scope: "account"`): billing or credit, a rejected or missing
 * key, a rate limit, a provider or gateway outage, no network. These say
 * nothing about the article.
 *
 * Article-level (`scope: "article"`): a refusal, output that cannot be parsed,
 * a request the provider rejects as too long or invalid, and ANYTHING NOT
 * RECOGNISED (`kind: "unknown"`). Unknown defaults to article-level on
 * purpose, so a new error shape can only cost an article its three attempts;
 * it can never cause an endless retry. The caller logs unknowns.
 *
 * What the billing message match can get wrong:
 *   - If Anthropic rewords the out-of-credit message and still sends it as a
 *     400 `invalid_request_error`, it will read as `bad_request` and count
 *     toward the cap again (the old behaviour). A 402 or `billing_error`
 *     would still be caught by the structured checks.
 *   - A 4xx whose provider message happens to contain one of the billing
 *     phrases for another reason would be left queued forever. The phrases
 *     are specific to the credit message and the text checked is the
 *     provider's, not the newsletter's, so this needs the provider to quote
 *     the article back in an error.
 */
export function classifyEnrichmentError(err: unknown): EnrichmentFailureClass {
  // The SDK retried and gave up: classify what it kept failing on.
  if (hasAiSdkMarker(err, "AI_RetryError")) {
    const last = err.lastError;
    return last === undefined || last === err ? result("unknown") : classifyEnrichmentError(last);
  }

  if (hasAiSdkMarker(err, "AI_APICallError")) return classifyApiCallError(err);

  if (hasAiSdkMarker(err, "AI_NoObjectGeneratedError")) {
    return result(err.finishReason === "content-filter" ? "refusal" : "malformed_output");
  }
  if (
    hasAiSdkMarker(err, "AI_JSONParseError") ||
    hasAiSdkMarker(err, "AI_TypeValidationError") ||
    hasAiSdkMarker(err, "AI_NoOutputGeneratedError")
  ) {
    return result("malformed_output");
  }

  if (err instanceof Error) {
    // lib/ai/generate.ts's AIRefusalError. Matched by name because importing
    // the class would pull the gateway into every importer of this module.
    if (err.name === "AIRefusalError") return result("refusal");
    if (MISSING_CREDENTIAL.test(err.message)) return result("config");
    // A connection failure the SDK did not wrap (fetch threw something other
    // than its two recognised "fetch failed" messages).
    if (hasNetworkCode(err)) return result("network");
  }

  return result("unknown");
}

/** One-line description for the log: never includes the error's own text. */
export function describeEnrichmentFailure(c: EnrichmentFailureClass): string {
  const parts: string[] = [c.kind];
  if (c.status !== null) parts.push(`HTTP ${c.status}`);
  if (c.errorType) parts.push(c.errorType);
  return parts.join(", ");
}

// ── Reading a failure that was already recorded ──────────────────────

/**
 * What a row excluded as 'enrichment_failed' remembers about why: its
 * `excluded_reason` is "Enrichment failed N times — last failure: <first 200
 * characters of the error message>" (lib/gmail/process.ts). The status code
 * and error type were never stored, so the message text is all a repair can
 * go on.
 */
export type StoredFailureKind = "billing" | "retried_transient" | "network" | "auth" | "config";

const LAST_FAILURE_MARKER = "last failure:";

/**
 * Classify a stored `excluded_reason`. Returns the account-level kind, or null
 * when the recorded failure is article-level or cannot be told.
 *
 *   - billing: the out-of-credit phrases (BILLING_PROSE).
 *   - retried_transient: the AI SDK's own "Failed after N attempts. Last
 *     error: ..." message. The SDK only reaches a later attempt when every
 *     earlier one was a retryable error (408, 409, 429, 5xx or a network
 *     failure), so this text means the provider kept failing transiently. The
 *     different wording "Failed after N attempts with non-retryable error" is
 *     NOT matched.
 *   - network: "Cannot connect to API: ..." (the SDK's unretried form).
 *   - auth: Anthropic's "invalid x-api-key".
 *   - config: the missing-key error from lib/ai/provider.ts.
 */
export function classifyStoredFailureReason(reason: string | null | undefined): StoredFailureKind | null {
  if (typeof reason !== "string") return null;
  const at = reason.indexOf(LAST_FAILURE_MARKER);
  if (at === -1) return null;
  const why = reason.slice(at + LAST_FAILURE_MARKER.length).trim();

  if (isBillingProse(why)) return "billing";
  if (/^Failed after \d+ attempts\. Last error: /.test(why)) return "retried_transient";
  if (/^Cannot connect to API: /.test(why)) return "network";
  if (/^invalid x-api-key\b/i.test(why)) return "auth";
  if (MISSING_CREDENTIAL.test(why)) return "config";
  return null;
}
