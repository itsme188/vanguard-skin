/**
 * B15 client (Contract B): a finished assistant message with no written
 * reply shows the turn-outcome sentence instead of an empty bubble, with no
 * Copy button; a Stop button replaces Send while a reply is pending.
 *
 * Source pin (no DOM harness). The sentence logic itself is pinned by
 * tests/chat/turn-outcome.test.ts (Task 3).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/ChatInterface.tsx", "utf8");

describe("turn-outcome notice (Contract B)", () => {
  it("imports turnOutcomeNotice from the shared client-safe module", () => {
    expect(src).toMatch(
      /import \{[^}]*\bturnOutcomeNotice\b[^}]*\} from "@\/lib\/chat\/turn-outcome"/,
    );
  });

  it("reads the notice only for a finished message, never the one streaming", () => {
    const list = sliceBetween(src, "{/* Message list */}", "{/* Error display */}");
    anchorIndex(list, "const isLive = isStreaming && index === messages.length - 1;");
    anchorIndex(list, "const notice = msg.role === \"assistant\" && !isLive ? turnOutcomeNotice(msg) : null;");
  });

  it("renders the notice in place of the parts, and hides Copy when it shows", () => {
    const list = sliceBetween(src, "{/* Message list */}", "{/* Error display */}");
    const noticeAt = anchorIndex(list, "notice ? (");
    const partsAt = anchorIndex(list, "renderAssistantParts(msg.parts");
    expect(noticeAt).toBeLessThan(partsAt);
    anchorIndex(list, "{!notice && msg.parts.some(");
  });
});

describe("Stop button (Contract B)", () => {
  const composer = sliceBetween(src, "<form onSubmit={handleSubmit}", "</form>");

  it("shows Stop while streaming or submitted, and Send otherwise", () => {
    anchorIndex(src, 'const isStreaming = status === "streaming" || status === "submitted";');
    const stopAt = anchorIndex(composer, "{isStreaming ? (");
    const stopButton = sliceBetween(composer, "{isStreaming ? (", ") : (");
    expect(stopButton).toContain('type="button"');
    expect(stopButton).toContain("onClick={() => void stop()}");
    expect(stopButton).toContain("Stop");
    const sendAt = anchorIndex(composer, 'type="submit"', stopAt);
    expect(sendAt).toBeGreaterThan(stopAt);
  });
});
