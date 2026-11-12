/**
 * Owner ruling 2026-11-12 (supersedes the 2026-11-07 title ruling): inside
 * the chat the owner is the only reader, so a conversation title is shown as
 * stored in every render site, privacy toggle on or off. Source pins: no DOM
 * harness in this repo.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";

describe("ChatInterface title render sites", () => {
  const src = readFileSync("app/dashboard/components/ChatInterface.tsx", "utf8");

  it("every conversation title renders as stored", () => {
    anchorIndex(src, 'currentConv?.title ?? fallbackTitle ?? "Current conversation"');
    anchorIndex(src, "aria-label={`Delete conversation ${conv.title ?? conv.id}`}");
    anchorIndex(src, 'message={`Delete "${deletePending?.title ?? `Conversation ${deletePending?.id}`}"? This cannot be undone.`}');
    // Rail list row (title attribute + text) and the Recent Conversations
    // buttons (title attribute + text).
    expect(src.match(/conv\.title \?\? `Conversation \$\{conv\.id\}`/g)!.length).toBe(4);
  });

  it("no title is masked or read through the privacy toggle", () => {
    expect(src).not.toMatch(/displayConversationTitle|maskTitleFigures/);
    expect(src).not.toMatch(/title[^\n]*isPrivate|isPrivate[^\n]*title/i);
  });
});
