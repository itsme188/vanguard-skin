import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// The ambient-notes floating action button (FAB) was removed 2026-09-04 (PR
// #65, merged 11a3fceb; pinned by tests/dashboard/notes-ambient-no-fab.test.tsx).
// Before that landed, four layout workarounds had accumulated that existed
// ONLY because the FAB existed — clearance margins and padding sized to keep
// content from sitting under a fixed floating button. This is a source-scan
// backstop: if any of those four files starts talking about "FAB" again, or
// resurrects one of the specific dead values, this test fails and calls it
// out as a ghost of a component that no longer renders anything.
const FILES = {
  todayPage: "app/dashboard/today/page.tsx",
  earningsDateChip: "app/dashboard/today/EarningsDateChip.tsx",
  layout: "app/dashboard/layout.tsx",
  securityChart: "app/dashboard/components/SecurityChart.tsx",
} as const;

const sources = Object.fromEntries(
  Object.entries(FILES).map(([key, path]) => [key, readFileSync(path, "utf8")]),
) as Record<keyof typeof FILES, string>;

describe("no FAB-clearance workarounds remain in the four files that used to carry them", () => {
  it("none of the four files mentions the FAB by name any more", () => {
    for (const [key, path] of Object.entries(FILES)) {
      expect(sources[key as keyof typeof FILES], `${path} still mentions FAB`).not.toMatch(/FAB/);
    }
  });

  it("Today's IBKR section carries no FAB-era bottom margin", () => {
    expect(sources.todayPage).not.toMatch(/md:mb-20/);
    // General guard, not just the specific value: no md:mb-* on that section
    // at all (the earlier repo-owned test already pins the section itself).
    expect(sources.todayPage).not.toContain("md:mb-20");
  });

  it("EarningsDateChip has no FAB_CLEARANCE constant and no mobile-only right-boundary branch for it", () => {
    expect(sources.earningsDateChip).not.toContain("FAB_CLEARANCE");
    // The mobile/desktop branch used to widen the right boundary pad only on
    // phones to dodge the FAB; both sides collapse to EDGE_PAD now, so the
    // literal token pairing that constant with a ternary must be gone.
    expect(sources.earningsDateChip).not.toMatch(/rightBoundaryPad\s*=\s*vw\s*<\s*MOBILE_BREAKPOINT/);
  });

  it("layout.tsx's <main> no longer carries pb-36 or the pointer-coarse escape hatch", () => {
    expect(sources.layout).not.toMatch(/\bpb-36\b/);
    expect(sources.layout).not.toContain("pointer-coarse:pb-24");
    // The mobile bottom-nav-only value is back, and desktop keeps only its
    // plain breathing-room padding.
    expect(sources.layout).toMatch(/<main[^>]*\bpb-20\b/);
    expect(sources.layout).toMatch(/<main[^>]*\bmd:pb-6\b/);
  });

  it("SecurityChart's 'via TWS' caption no longer reserves pr-14 for a floating button", () => {
    expect(sources.securityChart).not.toContain("pr-14");
    expect(sources.securityChart).toMatch(/<span>\{isIntraday/);
  });
});
