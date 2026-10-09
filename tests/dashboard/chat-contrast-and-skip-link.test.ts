/**
 * Owner-approved edits to the chat component (DECISIONS 2026-10-09, about
 * 02:15): the Send button and the selected scope pill reach 4.5:1 in the light
 * theme, and the scroll-to-bottom no longer moves the browser's tab starting
 * point (the first Tab must reach "Skip to main content").
 *
 * Contrast figures are measured in tests/repo/no-faded-small-status-text.test.ts
 * (GOLD_FILL_CLASSES 6.08 light / 11.52 dark; the gold ink on a plain surface)
 * and tests/repo/no-handrolled-failing-tint-pairs.test.ts (the gold ink on a
 * 20% gold tint, 5.40 to 5.99 light).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex, sliceBetween } from "@/tests/helpers/source-anchor";

const src = readFileSync("app/dashboard/components/ChatInterface.tsx", "utf8");

describe("chat Send button", () => {
  const button = sliceBetween(src, "title={!inputText.trim()", '{isStreaming ? "..."');
  it("takes the checked solid-gold pair, not a hand-written one", () => {
    expect(button).toContain("${GOLD_FILL_CLASSES}");
    expect(button).not.toMatch(/bg-gold\s+text-canvas/);
    expect(button).not.toMatch(/text-canvas\s+[^"`]*bg-gold/);
    expect(src).toMatch(/import \{[^}]*GOLD_FILL_CLASSES[^}]*\} from "\.\/chip-tone-text"/);
  });
});

describe("chat selected scope pill", () => {
  const pill = sliceBetween(src, "aria-pressed={scope === opt.value}", "{opt.label}");
  it("takes the checked gold text, never bare text-gold-ink", () => {
    expect(pill).toContain("CHIP_TONE_TEXT.gold");
    expect(pill).not.toMatch(/\btext-gold-ink\b/);
    expect(pill).not.toMatch(/\btext-gold\b/);
  });
  it("does not set an inline text colour that would override it", () => {
    const style = sliceBetween(pill, "style={", "undefined");
    expect(style).not.toMatch(/\bcolor\s*:/);
  });
});

describe("chat auto-scroll leaves the focus starting point alone", () => {
  it("never calls scrollIntoView", () => {
    expect(src).not.toContain("scrollIntoView");
  });
  it("scrolls the messages container itself", () => {
    const effect = sliceBetween(src, "// Auto-scroll on new content", "}, [messages]);");
    expect(effect).toContain("messagesScrollRef.current");
    expect(effect).toContain("scrollTo({ top: list.scrollHeight");
    const container = src.slice(anchorIndex(src, "ref={messagesScrollRef}") - 40, anchorIndex(src, "ref={messagesScrollRef}") + 120);
    expect(container).toContain("overflow-y-auto");
  });
});
