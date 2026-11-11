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

  it("calls stop() when a reply is streaming, before fetching the other conversation", () => {
    const stopAt = anchorIndex(body, "if (isStreaming) void stop();");
    const fetchAt = anchorIndex(body, "fetch(`/api/chat/conversations/${conv.id}/messages`)");
    expect(stopAt).toBeLessThan(fetchAt);
  });

  it("starts a new turn generation before fetching, so a late header is not adopted", () => {
    const bumpAt = anchorIndex(body, "beginNewGeneration();");
    const fetchAt = anchorIndex(body, "fetch(`/api/chat/conversations/${conv.id}/messages`)");
    expect(bumpAt).toBeLessThan(fetchAt);
  });

  it("the callback is rebuilt when the streaming flag changes (no stale closure)", () => {
    const deps = sliceBetween(src, "const loadConversation = useCallback(", "]);");
    const tail = deps.slice(anchorIndex(deps, "[setMessages"));
    expect(tail).toMatch(/\bisStreaming\b/);
    expect(tail).toMatch(/\bstop\b/);
  });
});
