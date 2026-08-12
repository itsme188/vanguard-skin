import { describe, it, expect } from "vitest";
import { formatGeneratedAt } from "@/lib/calendar/date-utils";

// This repo has no React component-rendering harness (no @testing-library/react,
// no jsdom environment in vitest.config.ts — confirmed by grep before writing
// this file). Following the notesListIsFiltered precedent in
// tests/dashboard/notes-filtered-state.test.ts, we test the extracted pure
// helper directly rather than inventing a rendering harness. The fetch-wiring
// (GET populates the caption, POST refresh replaces text, refresh failure
// surfaces the server error) is covered by browser verification instead.
//
// formatGeneratedAt lives in lib/calendar/date-utils.ts (moved out of
// NarrativeBlock.tsx — it's a generic ET date formatter, not UI logic).
describe("formatGeneratedAt (as-of caption date, ET-anchored)", () => {
  it("formats an ISO timestamp as a short month + day in Eastern time", () => {
    // Midday UTC is unambiguous in ET regardless of DST.
    expect(formatGeneratedAt("2026-08-10T15:00:00.000Z")).toBe("Aug 10");
  });

  it("anchors to ET, not UTC — a late-UTC-evening timestamp is still the same ET day", () => {
    // 2026-08-11T02:00Z is 2026-08-10 22:00 ET (EDT, UTC-4) — previous day in ET.
    expect(formatGeneratedAt("2026-08-11T02:00:00.000Z")).toBe("Aug 10");
  });

  it("never renders a raw ISO string", () => {
    const out = formatGeneratedAt("2026-08-10T15:00:00.000Z");
    expect(out).not.toContain("T");
    expect(out).not.toContain("Z");
    expect(out).not.toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("parses the SQLite datetime('now') shape — space-separated UTC, no 'Z' — as UTC, not local time", () => {
    // 2026-08-13 01:00:00 UTC is 2026-08-12 21:00 ET (EDT, UTC-4) — a naive
    // `new Date("2026-08-13 01:00:00")` would parse this as LOCAL time
    // instead, silently shifting the instant (and on some Safari versions,
    // rejecting the string outright as Invalid Date).
    expect(formatGeneratedAt("2026-08-13 01:00:00")).toBe("Aug 12");
  });

  it("returns null for an unparseable string, so the caller hides the caption instead of rendering Invalid Date", () => {
    expect(formatGeneratedAt("not-a-date")).toBeNull();
  });
});
