/**
 * Real provider failures for tests, without a real provider.
 *
 * A hand-built error object proves nothing about what the vendor SDK throws.
 * These helpers stub ONLY the network: they hand a canned HTTP response to the
 * real `@ai-sdk/anthropic` provider and the real `generateObject`, so the error
 * a test receives is built by the SDK's own response handler and retry loop,
 * exactly as in production.
 *
 * The response BODIES are Anthropic's documented error envelope
 * (`{ type: "error", error: { type, message }, request_id }`; the `type`
 * values are the members of the `ErrorObject` union in
 * node_modules/@anthropic-ai/sdk/resources/shared.d.ts). The out-of-credit
 * message is the text the app stored during the real outage. Its HTTP status
 * and `error.type` were NOT stored; 400 `invalid_request_error` is what the
 * repo's other call sites record for it, and the 402 `billing_error` form is
 * the documented one, so both are provided.
 *
 * Every response carries `retry-after-ms: 1` so the SDK's retry back-off
 * (2s then 4s by default) does not slow the suite down; the SDK honours that
 * header (`getRetryDelayInMs` in node_modules/ai/dist/index.js).
 */
import { generateObject, jsonSchema } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";

export const CREDIT_BALANCE_MESSAGE =
  "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "retry-after-ms": "1" },
  });
}

function envelope(type: string, message: string) {
  return { type: "error", error: { type, message }, request_id: "req_test_000" };
}

/** A successful Messages API reply whose text block is `text`. */
export function anthropicMessage(text: string | null, stopReason = "end_turn"): Response {
  return json(200, {
    type: "message",
    id: "msg_test_000",
    model: "test-model",
    role: "assistant",
    content: text === null ? [] : [{ type: "text", text }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });
}

/** One factory per failure: a fresh Response each call (bodies are single-use). */
export const ANTHROPIC_FAILURES = {
  /** Out of credit as observed: HTTP 400, request-shaped error type. */
  billing400: () => json(400, envelope("invalid_request_error", CREDIT_BALANCE_MESSAGE)),
  /** Out of credit as documented: HTTP 402 `billing_error`. */
  billing402: () => json(402, envelope("billing_error", "Billing error.")),
  rateLimit429: () =>
    json(429, envelope("rate_limit_error", "This request would exceed your organization's rate limit.")),
  overloaded529: () => json(529, envelope("overloaded_error", "Overloaded")),
  apiError500: () => json(500, envelope("api_error", "Internal server error")),
  auth401: () => json(401, envelope("authentication_error", "invalid x-api-key")),
  permission403: () =>
    json(403, envelope("permission_error", "Your API key does not have permission to use the specified resource.")),
  /** A proxy or gateway answering in its own format: no Anthropic envelope. */
  gatewayHtml502: () =>
    new Response("<html><body>Bad gateway</body></html>", {
      status: 502,
      statusText: "Bad Gateway",
      headers: { "content-type": "text/html", "retry-after-ms": "1" },
    }),
  /** A rate limit from a proxy: status only, no envelope. */
  bare429: () =>
    new Response("slow down", { status: 429, statusText: "Too Many Requests", headers: { "retry-after-ms": "1" } }),
  promptTooLong400: () =>
    json(400, envelope("invalid_request_error", "prompt is too long: 250000 tokens > 200000 maximum")),
  requestTooLarge413: () => json(413, envelope("request_too_large", "Request exceeds the maximum allowed number of bytes.")),
  notFound404: () => json(404, envelope("not_found_error", "The requested resource could not be found.")),
  /** The model declined: stop_reason "refusal", no content. */
  refusal: () => anthropicMessage(null, "refusal"),
  /** The model answered with text that is not the requested JSON. */
  malformedOutput: () => anthropicMessage("Sorry, here is a summary in prose instead."),
} satisfies Record<string, () => Response>;

export type AnthropicFailureName = keyof typeof ANTHROPIC_FAILURES;

/** What Node's fetch throws when nothing answers. */
export function fetchFailed(code = "ECONNREFUSED"): TypeError {
  const cause = Object.assign(new Error(`connect ${code} 203.0.113.1:443`), { code });
  return new TypeError("fetch failed", { cause });
}

const PROBE_SCHEMA = jsonSchema<{ summary: string }>({
  type: "object",
  additionalProperties: false,
  properties: { summary: { type: "string" } },
  required: ["summary"],
});

/**
 * Run the real `generateObject` against the real Anthropic provider with
 * `respond` standing in for the network, and return whatever it throws.
 * `maxRetries` defaults to the SDK's own default (2), which is also what the
 * app's gateway uses, so a retryable failure comes back wrapped in a
 * RetryError exactly as it does in production.
 */
export async function errorFromRealSdk(
  respond: () => Response | Promise<Response>,
  opts: { maxRetries?: number } = {},
): Promise<{ error: unknown; calls: number }> {
  let calls = 0;
  const anthropic = createAnthropic({
    apiKey: "test-key",
    fetch: async () => {
      calls += 1;
      return respond();
    },
  });
  try {
    await generateObject({
      model: anthropic("test-model"),
      schema: PROBE_SCHEMA,
      prompt: "probe",
      maxOutputTokens: 64,
      providerOptions: { anthropic: { structuredOutputMode: "outputFormat" } },
      ...(opts.maxRetries === undefined ? {} : { maxRetries: opts.maxRetries }),
    });
  } catch (error) {
    return { error, calls };
  }
  throw new Error("errorFromRealSdk: the call unexpectedly succeeded");
}
