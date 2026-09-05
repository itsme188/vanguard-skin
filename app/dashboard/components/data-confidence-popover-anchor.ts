// Pure, React-free helper for deciding which edge a popover should hang off
// of. The chip that opens this popover lives in the header's right-hand
// cluster; at narrower viewport widths (e.g. 1280px with the chat rail open)
// the chip's right edge sits well left of where a fixed-width popover
// anchored to that right edge would need its left edge to land, so the
// popover hangs off the left side of the viewport and clips its own content.
//
// Decision: default to "right" (the original behaviour — popover's right
// edge aligned with the trigger's right edge). Only switch to "left"
// (popover's left edge aligned with the trigger's left edge) when BOTH:
//   1. right-anchoring would push the popover's left edge past the left
//      margin (i.e. it would overflow the left side of the viewport), AND
//   2. left-anchoring keeps the popover's right edge within the viewport
//      (accounting for the right margin).
// If left-anchoring would ALSO overflow (viewport narrower than the
// popover plus margins), fall back to "right" — the caller caps the
// popover's rendered width to the viewport width, so this only limits how
// much of the popover hangs off, it doesn't leave it anchor-less.
export function popoverAnchorFor(
  triggerRect: { left: number; right: number },
  popoverWidth: number,
  viewportWidth: number,
  margin = 8
): "left" | "right" {
  const rightAnchoredLeft = triggerRect.right - popoverWidth;
  const rightAnchorOverflowsLeft = rightAnchoredLeft < margin;

  const leftAnchoredRight = triggerRect.left + popoverWidth;
  const leftAnchorFits = leftAnchoredRight <= viewportWidth - margin;

  if (rightAnchorOverflowsLeft && leftAnchorFits) {
    return "left";
  }
  return "right";
}
