/**
 * Chat panel width — single source of truth.
 *
 * The chat rail has two open widths: a normal rail and a wider "expanded"
 * panel the user toggles for reading long answers (U2b). These two numbers are
 * mirrored in three places that cannot import each other — keep them in sync:
 *   - this module (used by ChatDrawer.tsx for the panel's inline width)
 *   - `globals.css` (the `--chat-rail-width` layout reservation at xl)
 *   - the anti-FOUC script in `app/layout.tsx` (sets data-chat-expanded pre-hydrate)
 *
 * `collapsed` is orthogonal: it hides the panel (translate off-screen) but does
 * NOT change these widths, so the panel keeps its width and only the layout
 * reservation drops to 0 (handled in CSS).
 */
export const RAIL_WIDTH_PX = 480;
export const EXPANDED_WIDTH_PX = 720;

/** The panel's pixel width for the current expand state. */
export function chatPanelWidthPx(expanded: boolean): number {
  return expanded ? EXPANDED_WIDTH_PX : RAIL_WIDTH_PX;
}
