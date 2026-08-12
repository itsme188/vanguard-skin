import { describe, it, expect } from "vitest";
import { formatGeneratedAt } from "@/app/dashboard/components/analysis/NarrativeBlock";

// This repo has no React component-rendering harness (no @testing-library/react,
// no jsdom environment in vitest.config.ts — confirmed by grep before writing
// this file). Following the notesListIsFiltered precedent in
// tests/dashboard/notes-filtered-state.test.ts, we test the extracted pure
// helper directly rather than inventing a rendering harness. The fetch-wiring
// (GET populates the caption, POST refresh replaces text, refresh failure
// surfaces the server error) is covered by browser verification instead.
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
});
