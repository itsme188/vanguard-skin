/**
 * classifyEnrichmentError: one test per class, on errors built by the REAL
 * AI SDK from a canned HTTP response (tests/helpers/ai-sdk-real-errors.ts).
 * Nothing here is a hand-shaped error object except where a comment says so
 * and says why.
 *
 * Finding: research-feeds--billing-outage-burned-enrich-retry-cap-no-retry-when-credit-returns
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { APICallError, RetryError, NoObjectGeneratedError } from "ai";
import {
  COUNTED_AGAINST_ARTICLE_MARKER,
  classifyEnrichmentError,
  classifyStoredFailureReason,
  describeEnrichmentFailure,
} from "@/lib/gmail/enrichment-failure";
import {
  ANTHROPIC_FAILURES,
  CREDIT_BALANCE_MESSAGE,
  errorFromRealSdk,
  fetchFailed,
  type AnthropicFailureName,
} from "../helpers/ai-sdk-real-errors";

describe("the fixtures are the SDK's own errors", () => {
  it("a non-retryable HTTP failure is a bare APICallError carrying status, parsed body and raw body", async () => {
    const { error, calls } = await errorFromRealSdk(ANTHROPIC_FAILURES.billing400);
    expect(calls).toBe(1);
    expect(APICallError.isInstance(error)).toBe(true);
    const e = error as APICallError;
    expect(e.statusCode).toBe(400);
    expect(e.isRetryable).toBe(false);
    expect(e.message).toBe(CREDIT_BALANCE_MESSAGE);
    expect(e.data).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: CREDIT_BALANCE_MESSAGE },
    });
    expect(e.responseBody).toContain('"invalid_request_error"');
  });

  it("a retryable HTTP failure is tried three times and arrives wrapped in a RetryError", async () => {
    const { error, calls } = await errorFromRealSdk(ANTHROPIC_FAILURES.rateLimit429);
    expect(calls).toBe(3);
    expect(RetryError.isInstance(error)).toBe(true);
    expect(APICallError.isInstance(error)).toBe(false);
    const e = error as RetryError;
    expect(e.reason).toBe("maxRetriesExceeded");
    expect(e.message).toMatch(/^Failed after 3 attempts\. Last error: /);
    expect(APICallError.isInstance(e.lastError)).toBe(true);
    expect((e.lastError as APICallError).statusCode).toBe(429);
  });

  it("a refusal is a NoObjectGeneratedError with finishReason content-filter", async () => {
    const { error } = await errorFromRealSdk(ANTHROPIC_FAILURES.refusal);
    expect(NoObjectGeneratedError.isInstance(error)).toBe(true);
    expect((error as NoObjectGeneratedError).finishReason).toBe("content-filter");
  });
});

describe("classifyEnrichmentError: account-level", () => {
  const cases: Array<[AnthropicFailureName, string, number, string | null]> = [
    ["billing400", "billing", 400, "invalid_request_error"],
    ["billing402", "billing", 402, "billing_error"],
    ["rateLimit429", "rate_limit", 429, "rate_limit_error"],
    ["bare429", "rate_limit", 429, null],
    ["overloaded529", "outage", 529, "overloaded_error"],
    ["apiError500", "outage", 500, "api_error"],
    ["gatewayHtml502", "outage", 502, null],
    ["auth401", "auth", 401, "authentication_error"],
    ["permission403", "auth", 403, "permission_error"],
  ];

  it.each(cases)("%s -> %s", async (name, kind, status, errorType) => {
    const { error } = await errorFromRealSdk(ANTHROPIC_FAILURES[name]);
    expect(classifyEnrichmentError(error)).toEqual({ scope: "account", kind, status, errorType });
  });

  it("billing is recognised by its structured type even when the wording changes", async () => {
    const { error } = await errorFromRealSdk(
      () =>
        new Response(
          JSON.stringify({ type: "error", error: { type: "billing_error", message: "Reworded entirely." } }),
          { status: 400 },
        ),
    );
    expect(classifyEnrichmentError(error)).toMatchObject({ scope: "account", kind: "billing" });
  });

  it("the error type is read from the raw body when the SDK could not parse the envelope", async () => {
    // `message` is missing, so the SDK's schema rejects the body and leaves
    // `data` undefined; only `responseBody` still holds the type.
    const { error } = await errorFromRealSdk(
      () =>
        new Response(JSON.stringify({ type: "error", error: { type: "billing_error" } }), {
          status: 400,
          statusText: "Bad Request",
        }),
    );
    expect((error as APICallError).data).toBeUndefined();
    expect(classifyEnrichmentError(error)).toMatchObject({ scope: "account", kind: "billing" });
  });

  it("no connection: the SDK's unretried network error (no status code)", async () => {
    const { error, calls } = await errorFromRealSdk(
      () => {
        throw fetchFailed();
      },
      { maxRetries: 0 },
    );
    expect(calls).toBe(1);
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).statusCode).toBeUndefined();
    expect((error as APICallError).message).toMatch(/^Cannot connect to API: /);
    expect(classifyEnrichmentError(error)).toEqual({
      scope: "account",
      kind: "network",
      status: null,
      errorType: null,
    });
  });

  it("no connection after retries: a RetryError around that network error", async () => {
    const { error: inner } = await errorFromRealSdk(
      () => {
        throw fetchFailed("ETIMEDOUT");
      },
      { maxRetries: 0 },
    );
    // Built with the SDK's own class from three real network errors; going
    // through the retry loop would wait out its real 2s + 4s back-off because
    // a failed connection has no retry-after header to shorten it.
    const wrapped = new RetryError({
      message: `Failed after 3 attempts. Last error: ${(inner as Error).message}`,
      reason: "maxRetriesExceeded",
      errors: [inner, inner, inner],
    });
    expect(classifyEnrichmentError(wrapped)).toMatchObject({ scope: "account", kind: "network" });
  });

  it("a connection error the SDK did not wrap is recognised by its system error code", () => {
    // undici reports a connection dropped mid-response as TypeError("terminated")
    // with the socket error as its cause; the SDK only wraps "fetch failed".
    const dropped = new TypeError("terminated", {
      cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
    });
    expect(classifyEnrichmentError(dropped)).toMatchObject({ scope: "account", kind: "network" });
  });

  it.each([
    ["a bare fetch failure with no cause", () => new TypeError("fetch failed")],
    ["an aborted request", () => new DOMException("This operation was aborted", "AbortError")],
    ["a timed-out request", () => new DOMException("The operation timed out", "TimeoutError")],
  ])("%s reaches us unwrapped by the SDK and is a transient network failure", async (_label, make) => {
    const thrown = make();
    const { error, calls } = await errorFromRealSdk(() => {
      throw thrown;
    });
    // The SDK neither wraps nor retries these: the very object comes back.
    expect(calls).toBe(1);
    expect(error).toBe(thrown);
    expect(APICallError.isInstance(error)).toBe(false);
    expect(classifyEnrichmentError(error)).toEqual({
      scope: "account",
      kind: "network",
      status: null,
      errorType: null,
    });
  });

  it("a TypeError that is not a fetch failure stays unknown", () => {
    expect(classifyEnrichmentError(new TypeError("x is not a function"))).toMatchObject({
      scope: "article",
      kind: "unknown",
    });
  });

  it("a missing key is account-level, and the wording matches lib/ai/provider.ts", () => {
    const provider = readFileSync("lib/ai/provider.ts", "utf8");
    expect(provider).toContain('`ANTHROPIC_API_KEY is required for feature "${feature}" (model: ${modelId})`');
    expect(provider).toContain("`OPENAI_API_KEY is required for feature");
    expect(provider).toContain("`CLOUDFLARE_WORKERS_AI_TOKEN is required for feature");
    expect(provider).toContain("`Cloudflare AI Gateway must be configured to use Workers AI");

    for (const message of [
      'ANTHROPIC_API_KEY is required for feature "newsletterProcessing" (model: test-model)',
      'OPENAI_API_KEY is required for feature "newsletterProcessing" (model: test-model)',
      'CLOUDFLARE_WORKERS_AI_TOKEN is required for feature "newsletterProcessing" (Workers AI model: test-model)',
      "Cloudflare AI Gateway must be configured to use Workers AI (feature: newsletterProcessing). Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_GATEWAY_ID.",
    ]) {
      expect(classifyEnrichmentError(new Error(message))).toMatchObject({ scope: "account", kind: "config" });
    }
  });
});

describe("classifyEnrichmentError: article-level", () => {
  it("a refusal", async () => {
    const { error } = await errorFromRealSdk(ANTHROPIC_FAILURES.refusal);
    expect(classifyEnrichmentError(error)).toEqual({
      scope: "article",
      kind: "refusal",
      status: null,
      errorType: null,
    });
  });

  it("the gateway's own AIRefusalError (thrown on the text path)", () => {
    const gateway = readFileSync("lib/ai/generate.ts", "utf8");
    expect(gateway).toContain('this.name = "AIRefusalError"');
    // Same shape the gateway's class produces: an Error whose name is set.
    const err = new Error('AI refused request for feature "newsletterProcessing" (model test-model)');
    err.name = "AIRefusalError";
    expect(classifyEnrichmentError(err)).toMatchObject({ scope: "article", kind: "refusal" });
  });

  it("output that is not the requested JSON", async () => {
    const { error } = await errorFromRealSdk(ANTHROPIC_FAILURES.malformedOutput);
    expect(NoObjectGeneratedError.isInstance(error)).toBe(true);
    expect(classifyEnrichmentError(error)).toMatchObject({ scope: "article", kind: "malformed_output" });
  });

  it("a request the provider rejects as too long (same status and type as the billing 400)", async () => {
    const { error } = await errorFromRealSdk(ANTHROPIC_FAILURES.promptTooLong400);
    expect(classifyEnrichmentError(error)).toEqual({
      scope: "article",
      kind: "bad_request",
      status: 400,
      errorType: "invalid_request_error",
    });
  });

  it("a 413", async () => {
    const { error } = await errorFromRealSdk(ANTHROPIC_FAILURES.requestTooLarge413);
    expect(classifyEnrichmentError(error)).toMatchObject({ scope: "article", kind: "bad_request", status: 413 });
  });

  it.each([
    ["Please go to Plans & Billing to change your plan."],
    ["You can purchase credits in the console."],
    ["messages.0.content: the words billing and credits appear here"],
  ])("a 400 saying %j is NOT out of credit: only the credit-balance phrase is", async (message) => {
    const { error } = await errorFromRealSdk(
      () =>
        new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }), {
          status: 400,
        }),
    );
    expect(classifyEnrichmentError(error)).toMatchObject({ scope: "article", kind: "bad_request" });
  });

  it("a 400 that only mentions billing in passing is NOT treated as out of credit", async () => {
    const { error } = await errorFromRealSdk(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "messages.0: unknown field billing_cycle; credit not given" },
          }),
          { status: 400 },
        ),
    );
    expect(classifyEnrichmentError(error)).toMatchObject({ scope: "article", kind: "bad_request" });
  });
});

describe("classifyEnrichmentError: unknown shapes default to article-level", () => {
  it.each([
    ["a plain Error", new Error("something nobody anticipated")],
    ["a string", "boom"],
    ["null", null],
    ["undefined", undefined],
    ["an object that only looks like an API error", { statusCode: 429, name: "AI_APICallError", isRetryable: true }],
  ])("%s", (_label, err) => {
    expect(classifyEnrichmentError(err)).toMatchObject({ scope: "article", kind: "unknown" });
  });

  it("an HTTP status with no rule (404 after the gateway's own failover gave up)", async () => {
    const { error } = await errorFromRealSdk(ANTHROPIC_FAILURES.notFound404);
    expect(classifyEnrichmentError(error)).toEqual({
      scope: "article",
      kind: "unknown",
      status: 404,
      errorType: "not_found_error",
    });
  });

  it("a RetryError with nothing inside", () => {
    const empty = new RetryError({ message: "Failed", reason: "maxRetriesExceeded", errors: [] });
    expect(classifyEnrichmentError(empty)).toMatchObject({ scope: "article", kind: "unknown" });
  });
});

describe("describeEnrichmentFailure", () => {
  it("names the class, status and type, and never the provider's text", async () => {
    const { error } = await errorFromRealSdk(ANTHROPIC_FAILURES.billing400);
    const text = describeEnrichmentFailure(classifyEnrichmentError(error));
    expect(text).toBe("billing, HTTP 400, invalid_request_error");
  });
});

describe("classifyStoredFailureReason: what an excluded row remembers", () => {
  // The reason text is built the way lib/gmail/process.ts builds it: the
  // first 200 characters of the real error's message.
  const stored = (message: string) => `Enrichment failed 3 times — last failure: ${message.slice(0, 200)}`;

  it("the format assumed here is the one process.ts writes", () => {
    const src = readFileSync("lib/gmail/process.ts", "utf8");
    expect(src).toContain("`Enrichment failed ${enrich_attempts} times — last failure: ${why}`");
  });

  it.each([
    ["billing400", "billing"],
    ["rateLimit429", "retried_transient"],
    ["overloaded529", "retried_transient"],
    ["apiError500", "retried_transient"],
    ["gatewayHtml502", "retried_transient"],
    ["auth401", "auth"],
  ] as Array<[AnthropicFailureName, string]>)("%s -> %s", async (name, kind) => {
    const { error } = await errorFromRealSdk(ANTHROPIC_FAILURES[name]);
    expect(classifyStoredFailureReason(stored((error as Error).message))).toBe(kind);
  });

  it("a network failure that was not retried", async () => {
    const { error } = await errorFromRealSdk(
      () => {
        throw fetchFailed();
      },
      { maxRetries: 0 },
    );
    expect(classifyStoredFailureReason(stored((error as Error).message))).toBe("network");
  });

  it("the ledger's hyphenated form of the same reason", () => {
    expect(
      classifyStoredFailureReason(`Enrichment failed 3 times - last failure: ${CREDIT_BALANCE_MESSAGE}`),
    ).toBe("billing");
  });

  it.each([
    ["refusal"],
    ["malformedOutput"],
    ["promptTooLong400"],
    ["notFound404"],
  ] as Array<[AnthropicFailureName]>)("%s is not account-level", async (name) => {
    const { error } = await errorFromRealSdk(ANTHROPIC_FAILURES[name]);
    expect(classifyStoredFailureReason(stored((error as Error).message))).toBeNull();
  });

  it("the marker reads as plain words on the Filtered row", () => {
    expect(COUNTED_AGAINST_ARTICLE_MARKER).toBe("[counted against this article:");
  });

  it("a failure the pass counted against the article is never read as account-level", async () => {
    const { error } = await errorFromRealSdk(ANTHROPIC_FAILURES.billing400);
    const charged = stored(
      `${(error as Error).message.slice(0, 200)} ${COUNTED_AGAINST_ARTICLE_MARKER} the provider answered another article in the same pass]`,
    );
    expect(charged).toContain("credit balance is too low");
    expect(classifyStoredFailureReason(charged)).toBeNull();
  });

  it("the marker tested here is the one process.ts appends", () => {
    const src = readFileSync("lib/gmail/process.ts", "utf8");
    expect(src).toContain("recordEnrichmentFailure(p.article.id, `${p.why} ${COUNTED_AGAINST_ARTICLE_MARKER} ${because}]`)");
  });

  it.each([
    [stored("Please go to Plans & Billing to change your plan.")],
    [stored("You can purchase credits in the console.")],
    [stored("empty enrichment (no summary, no themes)")],
    [stored("Failed after 2 attempts with non-retryable error: 'prompt is too long'")],
    [stored("something nobody anticipated")],
    ["Claude judged article off-topic"],
    [""],
    [null],
  ])("%s is not account-level", (reason) => {
    expect(classifyStoredFailureReason(reason)).toBeNull();
  });
});
