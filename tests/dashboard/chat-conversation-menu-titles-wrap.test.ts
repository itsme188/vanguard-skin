/**
 * The chat conversation menu shows each title in full. The menu is a fixed
 * 256px wide, so a one-line `truncate` cut most titles short, and its hover
 * tooltip never shows on touch. The row title wraps instead. No DOM harness
 * in this repo, so this is a source pin; the browser check is in the commit.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sliceBetween } from "@/tests/helpers/source-anchor";

const iface = readFileSync("app/dashboard/components/ChatInterface.tsx", "utf8");

describe("conversation menu rows show the whole title", () => {
  const row = sliceBetween(iface, "{conversations.map((conv) => (", "aria-label={`Delete conversation");

  it("the row title wraps and is not truncated", () => {
    const title = sliceBetween(row, "title={conv.title ?? `Conversation ${conv.id}`}", "conversationDayLabel(conv.updated_at)");
    const titleDiv = title.match(/<div className="([^"]*)">\s*\{conv\.title \?\? `Conversation/);
    expect(titleDiv).not.toBeNull();
    const cls = titleDiv![1].split(/\s+/);
    expect(cls).toContain("[overflow-wrap:anywhere]");
    expect(cls).not.toContain("truncate");
    expect(cls).not.toContain("whitespace-nowrap");
  });

  it("the row button keeps min-w-0 so the wrapped title stays inside the menu", () => {
    expect(row).toMatch(/className=\{`flex-1 min-w-0 text-left/);
  });
});
