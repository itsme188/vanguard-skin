import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// This repo has no React component-rendering harness (no @testing-library/react,
// no jsdom environment in vitest.config.ts — see the precedent note in
// tests/dashboard/narrative-block-refresh.test.ts). Following the static-scan
// precedent in tests/dashboard/data-confidence-indicator-privacy.test.ts, this
// test scans the component source for the fix idiom instead of rendering it.
//
// QA finding `mobile-chat-prompt-chips--overflow-scrollbar-none-no-scrollfade-last-chip-sheared`:
// the chat overlay's empty-state suggested-prompt chip row was
// `overflow-x-auto ... scrollbar-none` with no ScrollFade wrapper — at
// 390px the last chip ("Biggest movers") rendered sheared at the panel
// edge with no scrollbar, no fade, and no arrow, reading as a broken
// label rather than a scrollable row.

const QUICK_ACTION_CHIPS_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/QuickActionChips.tsx",
);
const SCROLL_FADE_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/ScrollFade.tsx",
);

describe("QuickActionChips wraps the horizontally-scrollable chip row in ScrollFade", () => {
  const source = fs.readFileSync(QUICK_ACTION_CHIPS_PATH, "utf8");

  it("imports ScrollFade", () => {
    expect(source).toMatch(
      /import\s*\{\s*ScrollFade\s*\}\s*from\s*["']\.\/ScrollFade["']/
    );
  });

  it("wraps the chip row in <ScrollFade>", () => {
    expect(source).toMatch(/<ScrollFade[^>]*>/);
    expect(source).toContain("</ScrollFade>");
  });

  it("still suppresses the native scrollbar via the ScrollFade scroller, not a bare overflow-x-auto div", () => {
    // The old bare `overflow-x-auto ... scrollbar-none` div (no fade) must be
    // gone — scrollbar-none should now be threaded into ScrollFade's own
    // scroller instead of standing alone with no affordance.
    expect(source).not.toMatch(/overflow-x-auto[^"]*scrollbar-none/);
    expect(source).toMatch(/scrollerClassName=["'][^"']*scrollbar-none/);
  });
});

describe("ScrollFade supports an inner scroller className for callers that must also hide the native scrollbar", () => {
  const source = fs.readFileSync(SCROLL_FADE_PATH, "utf8");

  it("accepts an optional scrollerClassName prop", () => {
    expect(source).toMatch(/scrollerClassName/);
  });

  it("applies it to the overflow-x-auto scroller div", () => {
    expect(source).toMatch(/overflow-x-auto \$\{scrollerClassName/);
  });
});
