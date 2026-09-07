/**
 * QA 2026-09-07 —
 * chat-rail-collapsed--aria-hidden-without-inert-48-controls-in-tab-order.
 *
 * The chat panel stays MOUNTED in every layout mode (that's deliberate — it
 * preserves the conversation), and hides by sliding off-screen with a
 * transform. A transform does not remove anything from the tab order, so a
 * collapsed rail kept ~48 enabled controls focusable, including one "Delete
 * conversation <title>" per stored conversation. One Tab from the last
 * control in <main> landed ~91px off the right edge of the viewport with no
 * visible focus ring, and Chromium logged:
 *
 *   "Blocked aria-hidden on an element because its descendant retained
 *    focus. ... Consider using the inert attribute instead."
 *
 * Fix: the same `!railVisible` predicate that drives aria-hidden also drives
 * the `inert` attribute (React 19 renders the boolean prop), so a hidden
 * panel leaves BOTH the accessibility tree and the tab order.
 *
 * Source-scan, not a render test: this repo has no jsdom/RTL harness (see
 * tests/dashboard/narrative-block-refresh.test.ts for the same reasoning),
 * and `inert`'s focus behaviour is a browser primitive, not app logic.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = readFileSync("app/dashboard/components/ChatDrawer.tsx", "utf8");
const layout = readFileSync("app/dashboard/layout.tsx", "utf8");

describe("collapsed / closed chat panel leaves the tab order", () => {
  it("marks the panel inert on the same predicate that hides it from a11y", () => {
    const panel = src.slice(src.indexOf("{/* Chat panel."), src.indexOf("{/* Header */}"));
    expect(panel).toContain("aria-hidden={!railVisible}");
    expect(panel).toContain("inert={!railVisible}");
  });

  it("uses the one predicate that covers all three layout modes", () => {
    // mobile overlay + 768-1279 drawer use `open`; the xl rail uses !collapsed.
    expect(src).toContain("const railVisible = isLargeDesktop ? !collapsed : open;");
    // No second, hand-rolled hidden-ness test anywhere in the file.
    expect(src.match(/inert=/g)).toHaveLength(1);
  });

  it("keeps every re-open control OUTSIDE the inert subtree", () => {
    // The header toggle is rendered by the dashboard layout, not by the panel.
    expect(layout).toContain("<ChatToggleButton />");
    expect(src).not.toMatch(/<ChatToggleButton\b/);
    // Cmd+J and the custom events listen on `window`, which inert cannot reach.
    expect(src).toMatch(/window\.addEventListener\("keydown", handleKeyDown\)/);
    expect(src).toMatch(/window\.addEventListener\("toggle-mobile-chat"/);
    expect(src).toMatch(/window\.addEventListener\("open-chat"/);
  });

  it("still moves focus into the composer once the panel is live again", () => {
    // Both re-open paths defer the focus-chat-input dispatch past the 300ms
    // slide, by which time inert is already gone (same render as the
    // translate), so the focus target is focusable when the event lands.
    expect(src).toMatch(/focus-chat-input/);
    expect(src.match(/focus-chat-input/g)!.length).toBeGreaterThanOrEqual(3);
    expect(src).toContain("duration-300");
  });
});
