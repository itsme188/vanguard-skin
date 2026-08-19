import { describe, it, expect } from "vitest";
import { humanizeChatError } from "@/lib/chat/error-message";

// QA chat--send-401-csrf-token-never-attached-raw-envelope-rendered:
// the AI SDK throws with the response BODY as `error.message` (see
// HttpChatTransport: `throw new Error(await response.text())`), so a denied
// send rendered the literal JSON envelope `{"success":false,"error":
// "unauthorized"}` in the chat thread as if it were the assistant's answer.

describe("humanizeChatError", () => {
  it("turns the proxy's 401 envelope into a session-expired sentence", () => {
    const out = humanizeChatError('{"success":false,"error":"unauthorized"}');
    expect(out).not.toContain("{");
    expect(out).not.toContain("success");
    expect(out.toLowerCase()).toContain("sign in");
  });

  it("is case-insensitive about the unauthorized marker", () => {
    expect(humanizeChatError('{"success":false,"error":"Unauthorized"}')).toBe(
      humanizeChatError('{"success":false,"error":"unauthorized"}')
    );
  });

  it("surfaces a non-auth envelope's own error text without the JSON wrapper", () => {
    const out = humanizeChatError('{"success":false,"error":"Anthropic API key missing"}');
    expect(out).toBe("Anthropic API key missing");
  });

  it("passes a plain (non-JSON) message through unchanged", () => {
    expect(humanizeChatError("Failed to fetch the chat response.")).toBe(
      "Failed to fetch the chat response."
    );
  });

  it("falls back to a generic sentence on empty / whitespace input", () => {
    expect(humanizeChatError("")).toMatch(/chat/i);
    expect(humanizeChatError("   ")).toMatch(/chat/i);
  });

  it("passes non-envelope JSON through as its original text", () => {
    expect(humanizeChatError('{"foo":1}')).toBe('{"foo":1}');
  });
});
