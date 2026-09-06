import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// This repo has no React component-rendering harness (no @testing-library/react,
// no jsdom environment in vitest.config.ts — see the precedent note in
// tests/dashboard/narrative-block-refresh.test.ts). Following the static-scan
// precedent in tests/dashboard/data-confidence-indicator-privacy.test.ts and
// tests/dashboard/quick-action-chips-scrollfade.test.ts, this test scans the
// component source for the fix idiom instead of rendering it.
//
// Follow-up from the landing review of commit 256833e5
// (data-confidence-popover-anchor.ts): the anchor-edge useLayoutEffect only
// depended on [showPopover], so it measured once on open and never again.
// Repro: open the popover at 1600px (anchors "right"), resize the window to
// 1280px without closing it — the popover clips again, because nothing
// re-ran popoverAnchorFor. app/dashboard/today/EarningsDateChip.tsx (~224-233)
// already solved the identical class of bug (phone rotation) by registering
// `resize`/`orientationchange` listeners for the lifetime of the open popover
// and calling a local `measure()` function — this component must mirror that
// shape.

const COMPONENT_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/DataConfidenceIndicator.tsx",
);

function anchorEffectBody(source: string): string {
  const marker = "Pick which edge the popover hangs off of";
  const start = source.indexOf(marker);
  expect(start, "anchor-edge useLayoutEffect comment not found").toBeGreaterThan(-1);
  // The effect is a small, self-contained block — grab up to (and including)
  // its closing `}, [showPopover]);` so later effects/functions in the file
  // can't accidentally satisfy these assertions.
  const closeMarker = "}, [showPopover]);";
  const closeIdx = source.indexOf(closeMarker, start);
  expect(closeIdx, "could not find the effect's closing dependency array").toBeGreaterThan(-1);
  return source.slice(start, closeIdx + closeMarker.length);
}

describe("DataConfidenceIndicator popover re-measures on viewport change while open", () => {
  const source = fs.readFileSync(COMPONENT_PATH, "utf8");
  const body = anchorEffectBody(source);

  it("extracts the measurement into a local measure() function, called once on open", () => {
    expect(body).toMatch(/const measure = \(\) => \{/);
    // Called synchronously (not just defined) so the initial open still
    // measures immediately, matching the pre-fix behavior.
    expect(body).toMatch(/measure\(\);/);
  });

  it("calls popoverAnchorFor from inside measure(), not directly in the effect body", () => {
    const measureStart = body.indexOf("const measure = () => {");
    const measureEnd = body.indexOf("measure();", measureStart);
    expect(measureEnd).toBeGreaterThan(measureStart);
    const measureFnBody = body.slice(measureStart, measureEnd);
    expect(measureFnBody).toMatch(/popoverAnchorFor\(/);
  });

  it("registers resize AND orientationchange listeners while the popover is open (mirrors EarningsDateChip)", () => {
    expect(body).toMatch(/window\.addEventListener\(\s*["']resize["']\s*,\s*measure\s*\)/);
    expect(body).toMatch(/window\.addEventListener\(\s*["']orientationchange["']\s*,\s*measure\s*\)/);
  });

  it("removes both listeners in the effect's cleanup function", () => {
    expect(body).toMatch(/return \(\) => \{[\s\S]*window\.removeEventListener\(\s*["']resize["']\s*,\s*measure\s*\)/);
    expect(body).toMatch(/return \(\) => \{[\s\S]*window\.removeEventListener\(\s*["']orientationchange["']\s*,\s*measure\s*\)/);
  });
});
