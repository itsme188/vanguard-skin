/**
 * B16: opening another conversation while a reply streams must stop that
 * stream first. Otherwise the SDK keeps pushing the in-flight reply into the
 * newly loaded conversation's view (the server saves it to the old one), and
 * the next question sends that reply as the new conversation's history.
 *
 * No DOM harness in this repo: source pin with anchorIndex.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/ChatInterface.tsx", "utf8");

describe("loadConversation stops a streaming reply first (B16)", () => {
  const body = sliceBetween(src, "const loadConversation = useCallback(", "[setMessages");

  it("stops a streaming reply only after the load succeeded, before showing it (R4-8)", () => {
    const fetchAt = anchorIndex(body, "fetch(`/api/chat/conversations/${conv.id}/messages`)");
    const okAt = anchorIndex(body, "if (res.ok && payload?.success === true) {");
    const stopAt = anchorIndex(body, "if (isStreaming) await stop();");
    const showAt = anchorIndex(body, "setMessages(uiMessages);");
    expect(fetchAt).toBeLessThan(okAt);
    expect(okAt).toBeLessThan(stopAt);
    expect(stopAt).toBeLessThan(showAt);
  });

  it("starts a new turn generation before showing the loaded conversation", () => {
    expect(anchorIndex(body, "beginNewGeneration();")).toBeLessThan(anchorIndex(body, "setMessages(uiMessages);"));
  });

  it("a failed load says why (R4-8)", () => {
    anchorIndex(body, "toast(`Couldn't open that conversation: ");
    anchorIndex(body, 'toast(networkFailureMessage("open that conversation"), "error");');
  });

  it("the callback is rebuilt when the streaming flag changes (no stale closure)", () => {
    const deps = sliceBetween(src, "const loadConversation = useCallback(", "]);");
    const tail = deps.slice(anchorIndex(deps, "[setMessages"));
    expect(tail).toMatch(/\bisStreaming\b/);
    expect(tail).toMatch(/\bstop\b/);
  });
});
