/**
 * B21: streaming text follows the bottom only while the reader is within
 * 80 px of it; scrolling up to reread stays put. Sending a message re-arms
 * the follow. The 80 px rule is pinned as isNearBottom / nextFollowBottom in
 * tests/chat/turn-adoption.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/ChatInterface.tsx", "utf8");

describe("chat auto-scroll follows only near the bottom (B21)", () => {
  it("the scroller records whether the reader is near the bottom", () => {
    anchorIndex(src, "const followBottomRef = useRef(true);");
    const scroller = sliceBetween(src, "ref={messagesScrollRef}", "aria-live");
    anchorIndex(scroller, "onScroll={handleMessagesScroll}");
    const handler = sliceBetween(src, "const handleMessagesScroll = useCallback(", "}, []);");
    anchorIndex(
      handler,
      "followBottomRef.current = nextFollowBottom(followBottomRef.current, list, lastScrollTopRef.current);",
    );
    anchorIndex(handler, "lastScrollTopRef.current = list.scrollTop;");
  });

  it("the effect scrolls only when following", () => {
    const effect = sliceBetween(src, "// Auto-scroll on new content", "}, [messages]);");
    const guard = anchorIndex(effect, "if (!followBottomRef.current) return;");
    const scroll = anchorIndex(effect, "scrollTo({ top: list.scrollHeight");
    expect(guard).toBeLessThan(scroll);
  });

  it("sending a message re-arms following", () => {
    const submit = sliceBetween(src, "async function handleSubmit(", "function handleKeyDown(");
    expect(anchorIndex(submit, "followBottomRef.current = true;")).toBeLessThan(
      anchorIndex(submit, "await sendMessage("),
    );
  });
});
