import { describe, it, expect } from "vitest";
import { formatCacheNotice } from "@/app/dashboard/security/[id]/TranscriptsRefreshButton";

// Deep-QA finding: the earnings-transcripts ↻ refresh button was a silent
// no-op when the newest quarter was already cached — spinner runs, POST
// /api/transcripts returns 200 with fromCache:true, nothing visibly
// changes, no message. Project convention (CLAUDE.md UI rules) requires
// mutating buttons to explain no-ops in domain language.
//
// This repo has no @testing-library/react/jsdom (confirmed by grep before
// writing this file; see tests/dashboard/narrative-block-refresh.test.ts
// for the established precedent), so the click → fetch → setState wiring
// itself isn't unit-testable here — that's covered by browser verification.
// What IS unit-testable, following that same precedent, is the extracted
// pure helper that turns the API's `data` payload into notice text.
describe("formatCacheNotice (TranscriptsRefreshButton fromCache:true notice text)", () => {
  it("names the quarter and year when the cached row carries them", () => {
    expect(
      formatCacheNotice({ quarter: 2, year: 2026, ticker: "AAPL" })
    ).toBe("Already up to date — Q2 2026 is the latest cached quarter");
  });

  it("falls back to a generic message when quarter/year are absent", () => {
    expect(formatCacheNotice({ ticker: "AAPL" })).toBe(
      "Already up to date — no new transcript found"
    );
  });

  it("falls back to the generic message for null", () => {
    expect(formatCacheNotice(null)).toBe(
      "Already up to date — no new transcript found"
    );
  });

  it("falls back to the generic message for undefined", () => {
    expect(formatCacheNotice(undefined)).toBe(
      "Already up to date — no new transcript found"
    );
  });

  it("falls back to the generic message when quarter/year are wrong types (defends a malformed network payload)", () => {
    expect(
      formatCacheNotice({ quarter: "2", year: "2026" })
    ).toBe("Already up to date — no new transcript found");
  });

  it("does not throw on a primitive payload", () => {
    expect(formatCacheNotice("not an object")).toBe(
      "Already up to date — no new transcript found"
    );
    expect(formatCacheNotice(42)).toBe(
      "Already up to date — no new transcript found"
    );
  });
});
