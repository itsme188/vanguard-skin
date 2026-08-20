/**
 * Gap 1 pin (follow-up to f7823b6): the scanner has TWO reasons to skip a
 * level — the plausibility band AND a stale price. f7823b6 single-sourced the
 * band but left the 4-day freshness window copy-pasted as a raw SQL literal in
 * every query that needed it, so getArmedLevels simply didn't have it: an
 * armed level whose last price was weeks old rendered as live coverage with a
 * fresh-looking "Now" price while the scanner skipped it on every pass.
 *
 * These tests pin the window as ONE definition (constant + SQL fragment) and
 * assert no call site re-types it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  LEVEL_PRICE_MAX_AGE_DAYS,
  levelPriceIsFreshSql,
  isLevelPriceStale,
  STALE_PRICE_LABEL,
  STALE_PRICE_EXPLANATION,
} from "@/lib/levels/scan-range";

function readSource(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("scanner price-freshness window", () => {
  it("keeps the window at 4 days (weekend + long-weekend tolerance)", () => {
    expect(LEVEL_PRICE_MAX_AGE_DAYS).toBe(4);
  });

  it("builds a SQLite predicate with date() on BOTH sides", () => {
    const sql = levelPriceIsFreshSql("COALESCE(lp.date, lb.date)");
    expect(sql).toContain("date(COALESCE(lp.date, lb.date))");
    expect(sql).toContain("date('now', '-4 days')");
    expect(sql).toContain(">=");
  });

  it("derives the fragment from the constant, not a re-typed literal", () => {
    const src = readSource("../../lib/levels/scan-range.ts");
    // The number appears once, on the constant; the fragment interpolates it.
    expect(src).toContain("${LEVEL_PRICE_MAX_AGE_DAYS} days");
  });

  it("is the ONLY place the window is written — no call site re-types it", () => {
    for (const file of [
      "../../lib/queries/security-levels.ts",
      "../../lib/alerts/approve.ts",
    ]) {
      const src = readSource(file);
      expect(src, `${file} re-types the freshness window`).not.toMatch(
        /-\s*\d+\s*days/,
      );
    }
    // …and the query module reaches for the shared fragment instead.
    expect(readSource("../../lib/queries/security-levels.ts")).toContain(
      "levelPriceIsFreshSql",
    );
  });

  it("labels a stale price honestly, distinctly from the band label", () => {
    expect(STALE_PRICE_LABEL.length).toBeGreaterThan(0);
    expect(STALE_PRICE_LABEL).not.toBe("outside scan range");
    expect(STALE_PRICE_EXPLANATION).toContain("4 days");
    // No hardcoded currency glyph — level prices may be native currency.
    expect(STALE_PRICE_EXPLANATION).not.toContain("$");
  });
});

describe("isLevelPriceStale", () => {
  it("is false when no price exists at all — absent is not stale", () => {
    expect(isLevelPriceStale(null, "2026-06-15")).toBe(false);
    expect(isLevelPriceStale(undefined, "2026-06-15")).toBe(false);
  });

  it("is false inside the window (boundary day counts as fresh)", () => {
    expect(isLevelPriceStale("2026-06-15", "2026-06-15")).toBe(false);
    expect(isLevelPriceStale("2026-06-11", "2026-06-15")).toBe(false); // exactly 4 days
  });

  it("is true past the window", () => {
    expect(isLevelPriceStale("2026-06-10", "2026-06-15")).toBe(true); // 5 days
    expect(isLevelPriceStale("2026-05-01", "2026-06-15")).toBe(true);
  });
});
