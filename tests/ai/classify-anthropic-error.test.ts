import { describe, it, expect } from "vitest";
import { APIError } from "@anthropic-ai/sdk";
import {
  classifyAnthropicError,
  classifyAnthropicErrorMessage,
} from "@/lib/ai/classify-anthropic-error";

// QA: today-earningshub-upload--billing-400-misattributed-to-unreadable-image
// QA: research-documents-upload--500-renders-raw-anthropic-envelope
//
// Anthropic returns HTTP 400 both for genuinely bad request content (a
// corrupt PDF/image) AND for account-level faults (billing, bad key, org
// limits). These tests pin the classification boundary between them.

function billingPayload() {
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message:
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    },
    request_id: "req_billingTEST",
  };
}

function contentPayload() {
  return {
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "messages.0.content.0.pdf: The PDF specified was not valid.",
    },
    request_id: "req_contentTEST",
  };
}

describe("classifyAnthropicError", () => {
  it("classifies a billing 400 as 'billing', not 'content'", () => {
    const payload = billingPayload();
    const err = new APIError(400, payload, `400 ${JSON.stringify(payload)}`, new Headers());
    const result = classifyAnthropicError(err);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("billing");
    expect(result!.status).toBe(400);
    expect(result!.userMessage).not.toContain("req_billingTEST");
    expect(result!.userMessage).not.toContain("Plans & Billing");
    expect(result!.userMessage.toLowerCase()).toContain("billing");
  });

  it("classifies a document-rejection 400 as 'content'", () => {
    const payload = contentPayload();
    const err = new APIError(400, payload, `400 ${JSON.stringify(payload)}`, new Headers());
    const result = classifyAnthropicError(err);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("content");
    expect(result!.status).toBe(400);
    expect(result!.userMessage).not.toContain("req_contentTEST");
  });

  it("classifies a 401 as 'auth'", () => {
    const payload = {
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
      request_id: "req_authTEST",
    };
    const err = new APIError(401, payload, `401 ${JSON.stringify(payload)}`, new Headers());
    const result = classifyAnthropicError(err);
    expect(result!.kind).toBe("auth");
  });

  it("classifies a 429 as 'rate_limit'", () => {
    const payload = { type: "error", error: { type: "rate_limit_error", message: "rate limited" } };
    const err = new APIError(429, payload, `429 ${JSON.stringify(payload)}`, new Headers());
    const result = classifyAnthropicError(err);
    expect(result!.kind).toBe("rate_limit");
  });

  it("classifies a 529 as 'overloaded'", () => {
    const payload = { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
    const err = new APIError(529, payload, `529 ${JSON.stringify(payload)}`, new Headers());
    const result = classifyAnthropicError(err);
    expect(result!.kind).toBe("overloaded");
  });

  it("returns null for a non-APIError", () => {
    expect(classifyAnthropicError(new Error("ECONNRESET"))).toBeNull();
  });

  it("never leaks the raw JSON payload or request_id in userMessage", () => {
    for (const payload of [billingPayload(), contentPayload()]) {
      const err = new APIError(400, payload, `400 ${JSON.stringify(payload)}`, new Headers());
      const result = classifyAnthropicError(err)!;
      expect(result.userMessage).not.toContain("request_id");
      expect(result.userMessage).not.toContain('"type":"error"');
    }
  });
});

describe("classifyAnthropicErrorMessage", () => {
  it("classifies a billing 400 message string as 'billing'", () => {
    const payload = billingPayload();
    const message = `400 ${JSON.stringify(payload)}`;
    const result = classifyAnthropicErrorMessage(message);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("billing");
    expect(result!.userMessage).not.toContain("req_billingTEST");
  });

  it("returns null for a message that isn't an Anthropic error envelope", () => {
    expect(
      classifyAnthropicErrorMessage(
        "Failed to parse Claude response as JSON: This document is not a Vanguard brokerage statement.",
      ),
    ).toBeNull();
  });

  it("returns null for plain non-API-error text", () => {
    expect(classifyAnthropicErrorMessage("ECONNRESET")).toBeNull();
  });
});
