/**
 * QA 2026-10-25: the Assign lots overlay looked like a modal but never took
 * focus, so Tab landed on the row's Unlink button behind the backdrop.
 *
 *  1. the shared Tab ring (useModalFocus.ts) as a pure function;
 *  2. source pins: the hook moves focus in, keeps Tab inside, hands focus
 *     back, leaves a native dialog's own trap alone and does not handle Escape;
 *     the drawer's panel is the dialog and calls the hook.
 *
 * There is no DOM harness in this repo; browser-only effects are source-pinned.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { nextTabStopIndex } from "@/app/dashboard/components/useModalFocus";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

const HOOK = readFileSync("app/dashboard/components/useModalFocus.ts", "utf8");
const DRAWER = readFileSync("app/dashboard/components/giving/LotAssignmentDrawer.tsx", "utf8");

describe("nextTabStopIndex (the modal Tab ring)", () => {
  it("Tab moves forward and wraps from the last control to the first", () => {
    expect(nextTabStopIndex(3, 0, false)).toBe(1);
    expect(nextTabStopIndex(3, 1, false)).toBe(2);
    expect(nextTabStopIndex(3, 2, false)).toBe(0);
  });

  it("Shift+Tab moves back and wraps from the first control to the last", () => {
    expect(nextTabStopIndex(3, 2, true)).toBe(1);
    expect(nextTabStopIndex(3, 0, true)).toBe(2);
  });

  it("from the panel itself (-1), Tab goes to the first control and Shift+Tab to the last", () => {
    expect(nextTabStopIndex(4, -1, false)).toBe(0);
    expect(nextTabStopIndex(4, -1, true)).toBe(3);
  });

  it("a single control keeps focus on itself", () => {
    expect(nextTabStopIndex(1, 0, false)).toBe(0);
    expect(nextTabStopIndex(1, 0, true)).toBe(0);
  });

  it("with no controls the answer is -1, so focus stays on the panel", () => {
    expect(nextTabStopIndex(0, -1, false)).toBe(-1);
    expect(nextTabStopIndex(0, -1, true)).toBe(-1);
  });
});

describe("useModalFocus (source pins)", () => {
  const body = sliceBetween(HOOK, "export function useModalFocus(", "}, [open, panelRef]);");

  it("remembers the opener and focuses the panel on open", () => {
    expect(body).toContain("if (!open) return;");
    const opener = anchorIndex(body, "const opener = document.activeElement");
    expect(anchorIndex(body, "panelRef.current?.focus()")).toBeGreaterThan(opener);
  });

  it("Tab is caught and moved around the panel's controls", () => {
    expect(body).toContain('if (e.key !== "Tab") return;');
    expect(body).toContain("e.preventDefault()");
    expect(body).toContain("querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR)");
    expect(body).toContain("nextTabStopIndex(stops.length");
    expect(HOOK).toContain('[tabindex]:not([tabindex="-1"])');
  });

  it("leaves Tab to the browser while a native dialog inside the panel is open", () => {
    const skip = anchorIndex(body, 'closest("dialog[open]")');
    expect(skip).toBeLessThan(anchorIndex(body, "e.preventDefault()"));
    expect(body).toContain('panel.querySelector("dialog[open]")');
  });

  it("hands focus back to the opener on close and removes its listener", () => {
    const cleanup = body.slice(anchorIndex(body, "return () => {"));
    expect(cleanup).toContain('removeEventListener("keydown", onKeyDown)');
    expect(cleanup).toContain("opener.isConnected");
    expect(cleanup).toContain("opener.focus()");
  });

  it("does not handle Escape and closes nothing", () => {
    expect(HOOK).not.toContain('"Escape"');
    expect(HOOK).not.toMatch(/onClose|setOpen/);
  });
});

describe("LotAssignmentDrawer is a real modal dialog", () => {
  it("the panel carries the dialog role, aria-modal, the label, tabIndex -1 and the ref", () => {
    const aside = sliceBetween(DRAWER, "<aside", ">");
    expect(aside).toContain('role="dialog"');
    expect(aside).toContain('aria-modal="true"');
    expect(aside).toContain("aria-label={`Assign lots for ${symbol}`}");
    expect(aside).toContain("tabIndex={-1}");
    expect(aside).toContain("ref={asideRef}");
  });

  it("the backdrop wrapper is no longer the dialog", () => {
    const backdrop = sliceBetween(DRAWER, 'className="fixed inset-0 z-[55] flex"', "<aside");
    expect(backdrop).not.toContain('role="dialog"');
    expect(backdrop).not.toContain("aria-label");
    expect(backdrop).toContain("if (!flowActive) onClose()");
  });

  it("calls the shared hook (the drawer is mounted only while open)", () => {
    expect(DRAWER).toContain("useModalFocus(true, asideRef)");
  });
});
