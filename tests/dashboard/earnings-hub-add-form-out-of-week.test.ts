import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { outOfWeekSaveNote } from "@/app/dashboard/today/EarningsHubAddForm";

// Review findings on EarningsHubAddForm.tsx:
//
// (a) The "+ Add ticker" open-handler comment claimed "The hub can navigate
//     weeks without remounting this form" — false. EarningsHub.tsx
//     (app/dashboard/today/EarningsHub.tsx) hardcodes
//     `weekOf = getCurrentMonday()` at render time, so weekOf is fixed for
//     the page's lifetime; there is no week-navigation this form survives.
//     The real reason to re-derive the date on open is a day rollover on a
//     long-lived tab (defaultDateWithinWeek reads "today" at call time).
//
// (b) The <input type="date"> has no min/max (saving to another week is a
//     legitimate action — e.g. a ticker reporting next week) but a save
//     landing outside the shown week silently vanishes from the hub after
//     router.refresh() re-queries the deduped-for-this-week list. Nothing
//     told the user where it went.
//
// This repo has no React component-rendering harness with real DOM/effects
// (no @testing-library/react, no jsdom in vitest.config.ts — confirmed by
// grep; see the precedent notes in tests/dashboard/data-confidence-indicator-
// privacy.test.ts and tests/earnings/format-bogey-fields.test.ts). Following
// those precedents, the week-membership logic is extracted into a pure,
// directly-importable helper (outOfWeekSaveNote), and everything that can't
// be extracted (JSX wiring, the comment text) is covered by a static scan of
// the component source — same shape as tests/dashboard/twr-reconcile-labels
// .test.ts and cash-deploy-equity-sleeve-caption.test.ts.
describe("outOfWeekSaveNote (pure helper — EarningsHubAddForm.tsx)", () => {
  it("returns null when the saved date falls within the shown week", () => {
    expect(outOfWeekSaveNote("2026-08-19", "2026-08-17")).toBeNull(); // mid-week
    expect(outOfWeekSaveNote("2026-08-17", "2026-08-17")).toBeNull(); // weekOf itself (Monday)
    expect(outOfWeekSaveNote("2026-08-23", "2026-08-17")).toBeNull(); // weekOf+6 (Sunday)
  });

  it("names the actual week (mondayOf the saved date) when the date falls BEFORE the shown week", () => {
    // 2026-08-10 is the Monday of the week before weekOf=2026-08-17.
    expect(outOfWeekSaveNote("2026-08-10", "2026-08-17")).toBe(
      "Saved to the week of 2026-08-10 — not the week shown here."
    );
  });

  it("names the actual week (mondayOf the saved date) when the date falls AFTER the shown week", () => {
    // 2026-08-25 is a Tuesday in the week of 2026-08-24.
    expect(outOfWeekSaveNote("2026-08-25", "2026-08-17")).toBe(
      "Saved to the week of 2026-08-24 — not the week shown here."
    );
  });

  it("matches what the API actually files the row under (week_of: mondayOf(event_date))", () => {
    // If this API contract ever changes, the note's "week of X" would point
    // somewhere the row doesn't actually land — keep them locked together.
    const apiRouteSrc = readFileSync("app/api/calendar/events/route.ts", "utf8");
    expect(apiRouteSrc).toContain("week_of: mondayOf(body.event_date)");
  });
});

describe("EarningsHubAddForm — comment + feedback fixes (static scan)", () => {
  const src = readFileSync("app/dashboard/today/EarningsHubAddForm.tsx", "utf8");

  it("no longer claims the hub can navigate weeks without remounting this form", () => {
    // False: EarningsHub.tsx hardcodes weekOf = getCurrentMonday() per render.
    expect(src).not.toContain("The hub can navigate weeks without remounting this form");
  });

  it("gives the true reason for re-deriving the date on open: a day rollover on a long-lived tab", () => {
    expect(src).toMatch(/day rollover/);
  });

  it("wires the out-of-week note into the successful-save path", () => {
    expect(src).toContain("setOutOfWeekNote(outOfWeekSaveNote(date, weekOf))");
    expect(src).toMatch(/\{outOfWeekNote\s*&&/);
  });

  it("keeps the existing success path otherwise (reset, close, dispatch, refresh all still fire)", () => {
    expect(src).toContain('setSymbol("")');
    expect(src).toContain("setOpen(false)");
    expect(src).toContain('new Event("earnings-data-changed")');
    expect(src).toContain("router.refresh()");
  });

  it("does not add min/max to the date input (saving to another week is a legitimate action)", () => {
    const dateInputMatch = src.match(/<input\s+type="date"[\s\S]*?\/>/);
    expect(dateInputMatch).not.toBeNull();
    expect(dateInputMatch![0]).not.toMatch(/\bmin=/);
    expect(dateInputMatch![0]).not.toMatch(/\bmax=/);
  });
});
