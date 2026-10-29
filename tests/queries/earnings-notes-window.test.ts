/**
 * The earnings notes window (owner ruling 2026-10-29): 190 days, so last
 * quarter's earnings note (about 91 days before the next print) and the one
 * before it reach the preview, the recap and the printed sheets. Three copies
 * of the number exist (the Mac query, the R2 snapshot builder, the Worker's
 * fallback composer); this pins them together.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EARNINGS_NOTES_WINDOW_DAYS } from "@/lib/queries/notes";

describe("earnings notes window", () => {
  it("is 190 days", () => {
    expect(EARNINGS_NOTES_WINDOW_DAYS).toBe(190);
  });

  it("the email composer takes the default window, not its own number", () => {
    const src = readFileSync("lib/digest/send-earnings-email.ts", "utf8");
    expect(src).not.toMatch(/getNotesForFamily\([^)]*,\s*\d+\s*\)/);
  });

  it("the R2 snapshot builder reads the same constant", () => {
    const src = readFileSync("scripts/snapshot-state-to-r2.ts", "utf8");
    expect(src).toContain("EARNINGS_NOTES_WINDOW_DAYS");
    expect(src).not.toMatch(/'-\d+ days'\)\s*\n\s*ORDER BY n\.event_date/);
  });

  it("the Worker's fallback composer carries the same number", () => {
    const src = readFileSync("workers/cron/src/fallback-earnings.ts", "utf8");
    const m = src.match(/const NOTES_WINDOW_DAYS = (\d+);/);
    expect(m?.[1]).toBe(String(EARNINGS_NOTES_WINDOW_DAYS));
  });
});
