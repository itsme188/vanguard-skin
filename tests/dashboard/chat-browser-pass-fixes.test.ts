/**
 * Browser-pass fixes (2026-11-11): the list date is the Eastern day, a failed
 * send never shows the browser's own text, Copy waits for a settled reply,
 * and the header falls back to the first question when the list row has no
 * title yet. Logic is pinned in tests/chat/turn-adoption.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/ChatInterface.tsx", "utf8");

describe("chat browser-pass fixes", () => {
  it("conversation dates go through the Eastern-day label", () => {
    anchorIndex(src, "{conversationDayLabel(conv.updated_at)}");
    expect(src).not.toContain("toLocaleDateString()");
  });

  it("the error line goes through chatErrorText", () => {
    anchorIndex(src, "{chatErrorText(error)}");
    expect(src).not.toContain("error.message");
  });

  it("Copy shows only on a settled message", () => {
    const list = sliceBetween(src, "{/* Message list */}", "{/* Error display */}");
    anchorIndex(list, "{!isLive && !notice && msg.parts.some(");
  });

  it("the header falls back to the first question, masked like any title", () => {
    anchorIndex(
      src,
      'displayConversationTitle(currentConv?.title, isPrivate) ?? displayConversationTitle(fallbackTitle, isPrivate) ?? "Current conversation"',
    );
    anchorIndex(src, "const fallbackTitle = useMemo(() => conversationTitleFromMessages(messages) || null, [messages]);");
    expect(src.match(/fallbackTitle=\{fallbackTitle\}/g)!.length).toBeGreaterThanOrEqual(3);
  });
});
