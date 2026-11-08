import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { displayConversationTitle } from "@/lib/chat/conversation-title";
import { anchorIndex } from "../helpers/source-anchor";

describe("displayConversationTitle", () => {
  const t = "Sell 150 shares of ZZA at $1,200 for 3.5% gain";
  it("leaves the title as stored when privacy is off", () => {
    expect(displayConversationTitle(t, false)).toBe(t);
  });
  it("masks the amount and the share count but keeps words and the percent when privacy is on", () => {
    // Owner ruling 2026-11-07 (decision #52): percentages show, dollars and
    // share counts do not.
    const m = displayConversationTitle(t, true) as string;
    expect(m).toContain("ZZA");
    expect(m).toContain("3.5%");
    expect(m).not.toMatch(/150|1,200/);
  });
  it("passes null through", () => {
    expect(displayConversationTitle(null, true)).toBeNull();
  });
});

describe("ChatInterface title render sites", () => {
  const src = readFileSync("app/dashboard/components/ChatInterface.tsx", "utf8");
  it("every conversation title goes through displayConversationTitle", () => {
    anchorIndex(src, "displayConversationTitle(currentConv?.title, isPrivate)");
    anchorIndex(src, "displayConversationTitle(conv.title, isPrivate)");
    anchorIndex(src, "displayConversationTitle(deletePending?.title, isPrivate)");
    expect(src.match(/displayConversationTitle\(conv\.title, isPrivate\)/g)!.length).toBeGreaterThanOrEqual(5);
  });
  it("no raw conv.title is rendered", () => {
    const raw = src.match(/conv\.title(?!, isPrivate)/g) ?? [];
    expect(raw).toEqual([]);
  });
});
