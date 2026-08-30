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

  // Finding #3 (b88b95d/aea6a51 review): APIError.error is undefined when
  // the upstream body isn't JSON at all (a gateway HTML page) — err.message
  // is then the raw "400 <body>" text. That raw text must never be embedded
  // in userMessage, even when it happens to contain a content-ish word.
  it("classifies a 400 with a non-JSON body as content-kind with a generic message, no raw body", () => {
    const rawBody =
      "<!DOCTYPE html><body>502 Bad Gateway — document upload rejected by proxy, request_id=hidden-in-html</body>";
    const err = new APIError(400, undefined, rawBody, new Headers());
    const result = classifyAnthropicError(err);

    expect(result).not.toBeNull();
    expect(result!.kind).toBe("content");
    expect(result!.status).toBe(400);
    expect(result!.userMessage).not.toContain("<!DOCTYPE");
    expect(result!.userMessage).not.toContain("Bad Gateway");
    expect(result!.userMessage).not.toContain("request_id");
    expect(result!.userMessage).not.toContain("hidden-in-html");
    expect(result!.userMessage).toBe("The AI service couldn't process this file. Try again in a minute.");
  });

  it("never embeds a raw non-JSON body for a non-400 status either", () => {
    const rawBody = "<html>upstream is down, document backend offline</html>";
    const err = new APIError(503, undefined, rawBody, new Headers());
    const result = classifyAnthropicError(err)!;

    expect(result.kind).toBe("unknown");
    expect(result.userMessage).not.toContain("<html>");
    expect(result.userMessage).not.toContain("document backend");
    expect(result.userMessage).toBe("The AI service failed (upstream 503). Try again in a minute.");
  });

  // Finding #3: err.error?.error?.type must be consulted BEFORE prose
  // substring matching (authentication_error/permission_error -> auth;
  // rate_limit_error/overloaded_error -> their respective kinds) — this
  // must hold even when the status code alone wouldn't have signaled it
  // (e.g. a 400 carrying an authentication_error body).
  describe("error.type-driven classification (consulted before prose patterns)", () => {
    it("maps authentication_error to 'auth' even off a 400 status", () => {
      const payload = {
        type: "error",
        error: { type: "authentication_error", message: "key rotated" },
        request_id: "req_typeAuth400",
      };
      const err = new APIError(400, payload, `400 ${JSON.stringify(payload)}`, new Headers());
      const result = classifyAnthropicError(err)!;
      expect(result.kind).toBe("auth");
      expect(result.userMessage).not.toContain("req_typeAuth400");
    });

    it("maps permission_error to 'auth'", () => {
      const payload = {
        type: "error",
        error: { type: "permission_error", message: "not authorized for this resource" },
      };
      const err = new APIError(403, payload, `403 ${JSON.stringify(payload)}`, new Headers());
      const result = classifyAnthropicError(err)!;
      expect(result.kind).toBe("auth");
    });

    it("maps rate_limit_error to 'rate_limit' even off a non-429 status", () => {
      const payload = {
        type: "error",
        error: { type: "rate_limit_error", message: "too many requests" },
      };
      const err = new APIError(400, payload, `400 ${JSON.stringify(payload)}`, new Headers());
      const result = classifyAnthropicError(err)!;
      expect(result.kind).toBe("rate_limit");
    });

    it("maps overloaded_error to 'overloaded' even off a non-529 status", () => {
      const payload = {
        type: "error",
        error: { type: "overloaded_error", message: "server overloaded" },
      };
      const err = new APIError(503, payload, `503 ${JSON.stringify(payload)}`, new Headers());
      const result = classifyAnthropicError(err)!;
      expect(result.kind).toBe("overloaded");
    });

    it("falls back to prose patterns for a type it doesn't special-case (invalid_request_error)", () => {
      const payload = billingPayload();
      const err = new APIError(400, payload, `400 ${JSON.stringify(payload)}`, new Headers());
      const result = classifyAnthropicError(err)!;
      expect(result.kind).toBe("billing");
    });
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

  it("consults error.type for a 401 message string, mapping to 'auth'", () => {
    const payload = {
      type: "error",
      error: { type: "authentication_error", message: "invalid x-api-key" },
      request_id: "req_msgAuthTEST",
    };
    const message = `401 ${JSON.stringify(payload)}`;
    const result = classifyAnthropicErrorMessage(message);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("auth");
    expect(result!.userMessage).not.toContain("req_msgAuthTEST");
  });
});
