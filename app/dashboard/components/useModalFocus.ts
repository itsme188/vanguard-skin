"use client";

import { useEffect, type RefObject } from "react";

/**
 * Focus handling for an overlay that is drawn as a modal dialog but is not a
 * native `<dialog>` (QA 2026-10-25: the Assign lots drawer and the Settings
 * modal never took focus, so Tab moved to controls on the page behind the
 * backdrop and Tab + Enter acted on that page). Same behaviour as the email
 * viewer fix (EarningsEmailViewer.tsx, commit c457ae35), kept in one place
 * for the overlays that share it.
 *
 * The hook does not handle Escape and never closes anything: each caller
 * keeps its own Escape and backdrop handling.
 */

/** Controls that take part in the Tab ring inside the panel. */
export const MODAL_FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab goes next in a ring of `count` controls. `current` is the index of
 * the focused control, or -1 when focus is on the panel itself (or anywhere
 * outside the ring). Tab off the last control wraps to the first; Shift+Tab
 * off the first wraps to the last. From -1, Tab goes to the first control and
 * Shift+Tab to the last. With no controls the answer is -1: focus stays on
 * the panel.
 */
export function nextTabStopIndex(count: number, current: number, shift: boolean): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return shift ? count - 1 : 0;
  return (current + (shift ? count - 1 : 1)) % count;
}

/**
 * While `open` is true: focus moves to the panel (which must carry
 * `tabIndex={-1}`), Tab and Shift+Tab cycle through the panel's controls, and
 * on close or unmount focus goes back to whatever was focused when the
 * overlay opened, if that element is still in the page.
 *
 * A native `<dialog>` opened with showModal() inside the panel (a confirm or
 * the ledger-recompute dialog) runs its own focus trap; while one is open the
 * hook leaves Tab to the browser.
 */
export function useModalFocus(open: boolean, panelRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const active = document.activeElement;
      if (active instanceof Element && active.closest("dialog[open]")) return;
      if (panel.querySelector("dialog[open]")) return;
      e.preventDefault();
      // A closed native dialog's contents are in the DOM but cannot take focus.
      const stops = Array.from(panel.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR)).filter(
        (el) => !el.closest("dialog:not([open])"),
      );
      const next = nextTabStopIndex(stops.length, stops.indexOf(active as HTMLElement), e.shiftKey);
      (next === -1 ? panel : stops[next]).focus();
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener && opener.isConnected) opener.focus();
    };
  }, [open, panelRef]);
}
