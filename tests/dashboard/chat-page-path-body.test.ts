/**
 * B18 client (Contract A): the request body carries the page PATH, per call,
 * and never the client-written page sentence. The server resolves the path
 * (a security id, a print event id) itself.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/ChatInterface.tsx", "utf8");

describe("chat request body carries the page path (Contract A)", () => {
  it("the per-call body is scope, conversation id and page path", () => {
    // Re-pinned 2026-11-13: the body also carries the model class, only
    // while no conversation exists yet (tests/dashboard/chat-model-picker.test.ts).
    const builder = sliceBetween(src, "const currentRequestBody = useCallback(", "[scope, pathname, modelFamily]");
    anchorIndex(builder, "scope,\n      conversationId: conversationIdRef.current,\n      page: { path: pathname },");
    expect(builder).not.toContain("pageContext");
    expect(builder).not.toContain("turn.");
  });

  it("every send, retry and approval answer builds the body at that moment", () => {
    anchorIndex(src, "await sendMessage({ text }, { body: currentRequestBody() });");
    anchorIndex(src, "regenerate({ body: currentRequestBody() })");
    anchorIndex(src, "options: { body: currentRequestBody() },");
  });

  it("the client no longer builds the page sentence", () => {
    expect(src).not.toContain("getPageContext");
    expect(src).not.toContain("@/lib/chat/page-context");
  });

  it("the body is never baked into the transport", () => {
    const transport = sliceBetween(src, "new DefaultChatTransport(", "turn,");
    expect(transport).not.toContain("body");
    expect(transport).not.toContain("page");
  });
});
