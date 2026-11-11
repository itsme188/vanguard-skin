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
    anchorIndex(list, "const endedInError = status === \"error\" && index === messages.length - 1;");
    anchorIndex(
      list,
      "settledAssistantView(msg, { endedInError, outcomeNotice: turnOutcomeNotice(msg) })",
    );
    // An errored turn with nothing to show renders no bubble (no "Stopped.").
    anchorIndex(list, 'if (settled?.kind === "hidden") return null;');
    anchorIndex(list, 'const notice = settled?.kind === "notice" ? settled.text : null;');
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
    expect(stopButton).toContain("onClick={handleStopClick}");
    expect(stopButton).toContain("Stop");
    const sendAt = anchorIndex(composer, 'type="submit"', stopAt);
    expect(sendAt).toBeGreaterThan(stopAt);
  });
});

describe("a stopped reply settles (R4-3)", () => {
  it("the parts render with the message's live flag", () => {
    const list = sliceBetween(src, "{/* Message list */}", "{/* Error display */}");
    anchorIndex(list, "live: isLive,");
    anchorIndex(list, "inLastMessage: index === messages.length - 1,");
  });
  it("reasoning and tool indicators read the settled rules", () => {
    const render = sliceBetween(src, "function renderAssistantParts(", "function renderUserParts(");
    anchorIndex(render, "showThinking((part as { state?: string }).state, opts.live)");
    anchorIndex(render, "toolIndicatorState((part as { state?: string }).state, opts.live)");
    anchorIndex(render, "if (parts.length === 0 && opts.live) {");
  });
});

describe("Stop ignores the second click of a double-click on Send (R4-4)", () => {
  it("the click handler asks the guard, and a send records its start", () => {
    const handler = sliceBetween(src, "const handleStopClick = useCallback(", "}, [stop]);");
    const guard = anchorIndex(handler, "if (shouldIgnoreStopClick(stopGuardFromRef.current, Date.now())) return;");
    expect(guard).toBeLessThan(anchorIndex(handler, "void stop();"));
    const submit = sliceBetween(src, "async function handleSubmit(", "function handleKeyDown(");
    expect(anchorIndex(submit, "stopGuardFromRef.current = Date.now();")).toBeLessThan(
      anchorIndex(submit, "await sendMessage("),
    );
  });
  it("Stop is never disabled, so it stays reachable from the keyboard", () => {
    const composer = sliceBetween(src, "<form onSubmit={handleSubmit}", "</form>");
    const stopButton = sliceBetween(composer, "{isStreaming ? (", ") : (");
    expect(stopButton).not.toContain("disabled");
  });
});
