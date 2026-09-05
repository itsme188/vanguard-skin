import { describe, it, expect } from "vitest";
import { popoverAnchorFor } from "@/app/dashboard/components/data-confidence-popover-anchor";

describe("popoverAnchorFor", () => {
  it("anchors left at 1280px viewport where right-anchoring would clip off the left edge", () => {
    // Live repro: chip sits near the header's right cluster at 1280px with
    // the chat rail open — right-anchoring a 384px popover here computes a
    // negative left offset (~-37px), clipping every leaf line.
    const triggerRect = { left: 300, right: 347 };
    expect(popoverAnchorFor(triggerRect, 384, 1280)).toBe("left");
  });

  it("keeps the default right anchor at 1600px viewport where it fits fine", () => {
    const triggerRect = { left: 620, right: 667 };
    expect(popoverAnchorFor(triggerRect, 384, 1600)).toBe("right");
  });

  it("falls back to right when the trigger is near the right edge and left-anchoring would overflow the right side", () => {
    // Narrow viewport, trigger near the right edge: right-anchoring
    // overflows the left margin, but left-anchoring would ALSO overflow
    // the right margin — neither fits, so we keep the default.
    const triggerRect = { left: 350, right: 390 };
    expect(popoverAnchorFor(triggerRect, 384, 400)).toBe("right");
  });

  it("falls back to right when the viewport is narrower than the popover itself", () => {
    const triggerRect = { left: 10, right: 50 };
    expect(popoverAnchorFor(triggerRect, 384, 300)).toBe("right");
  });

  it("respects a custom margin", () => {
    // Right at the boundary: rightAnchoredLeft === margin should NOT count
    // as overflowing (strict less-than), so this stays "right".
    const triggerRect = { left: 100, right: 400 };
    // rightAnchoredLeft = 400 - 384 = 16, margin = 16 -> not < margin -> right
    expect(popoverAnchorFor(triggerRect, 384, 1000, 16)).toBe("right");
  });
});
