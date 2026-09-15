/**
 * The security hub's Options Greeks card treats an option as live through
 * the 16:00 ET close on its expiration day (commit 403ff48f,
 * lib/compute/option-expiry.ts::isOptionLive). The security detail page's
 * "Expiration" cell contradicted that: it computed days-to-expiry as
 * `Math.floor((new Date(expiration_date).getTime() - Date.now()) / 86400000)`
 * — a UTC-midnight-parsed date minus the current INSTANT (effectively UTC
 * "now"), not an ET calendar-day comparison. In the hours after UTC
 * midnight but before the ET day rolls over, this floors to -1 on the
 * expiration day itself and prints "(expired)" for the very contract the
 * Greeks card still shows as live with "0d" left.
 *
 * Fix: app/dashboard/security/[id]/page.tsx now derives DTE through the
 * shared `daysToExpiry` helper (lib/compute/option-expiry.ts), which does
 * pure calendar-date subtraction between two YYYY-MM-DD strings (both
 * parsed as UTC midnight — no local wall clock, no DST drift) and defaults
 * `today` to `todayET()`.
 *
 * This repo has no jsdom/RTL harness — pin the fix by reading the source
 * file as text, same pattern as
 * tests/dashboard/position-risk-privacy-source-pin.test.ts. Regexes are
 * whitespace-tolerant so reformatting doesn't produce a false negative.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC_PATH = "app/dashboard/security/[id]/page.tsx";
const src = readFileSync(SRC_PATH, "utf8");

/** The Expiration cell's own markup — the scope of this regression. (The
 * file also has an unrelated `holdingPeriodLabel` using `Date.now()` for a
 * genuine elapsed-time question (LT/ST tax holding period); that is a
 * different concern and out of scope here, so the checks below are scoped
 * to just this cell rather than banning `Date.now()` file-wide.) */
function extractExpirationCell(content: string): string {
  const cellStart = content.indexOf('label="Expiration"');
  if (cellStart === -1) throw new Error('could not find label="Expiration" in the source');
  const cellEnd = content.indexOf(")}", cellStart);
  if (cellEnd === -1) throw new Error("could not find the end of the Expiration OptionCell block");
  return content.slice(cellStart, cellEnd);
}

/** The actual regression checks, factored out so they can be run against
 * both the real source (must pass) and a deliberately mutated copy (must
 * fail) — proving the pin is sensitive to the bug it targets. */
function assertNoBannedInstantArithmetic(cell: string): void {
  if (/Date\.now\(\)/.test(cell)) {
    throw new Error("found the banned Date.now() instant-vs-calendar-day pattern");
  }
  if (/86400000/.test(cell) || /1000\s*\*\s*60\s*\*\s*60\s*\*\s*24/.test(cell)) {
    throw new Error("found raw milliseconds-per-day arithmetic outside the shared helper");
  }
}

describe("security detail page DTE is ET-anchored via the shared helper, never Date.now()", () => {
  it("imports daysToExpiry from the shared option-expiry module", () => {
    expect(src).toMatch(
      /import\s*\{\s*daysToExpiry\s*\}\s*from\s*["']@\/lib\/compute\/option-expiry["']/
    );
  });

  it("calls daysToExpiry(security.expiration_date) to derive the Expiration cell's day count", () => {
    expect(src).toMatch(/daysToExpiry\(\s*security\.expiration_date\s*\)/);
  });

  it("passes the banned-instant-arithmetic check against the real source's Expiration cell", () => {
    expect(() => assertNoBannedInstantArithmetic(extractExpirationCell(src))).not.toThrow();
  });

  it("the Expiration cell renders '(expired)' only for a negative day count and 'Nd' otherwise, matching isOptionLive's >= 0 cutoff", () => {
    const cell = extractExpirationCell(src);
    expect(cell).toMatch(/daysToExpiry\(\s*security\.expiration_date\s*\)/);
    expect(cell).toMatch(/<\s*0\s*\?\s*["']\(expired\)["']\s*:\s*`\(\$\{[a-zA-Z0-9_]+\}d\)`/);
  });
});

describe("pin sensitivity — the check must fail against a mutated copy that reintroduces the bug", () => {
  it("throws when run against a /tmp copy with the old Date.now()/86400000 arithmetic restored", () => {
    const mutated = src.replace(
      /const\s+dte\s*=\s*daysToExpiry\(\s*security\.expiration_date\s*\);/,
      "const dte = Math.floor((new Date(security.expiration_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));"
    );
    // Guard that the substitution actually matched something — otherwise
    // this test would trivially pass by comparing src to itself.
    expect(mutated).not.toBe(src);

    const dir = mkdtempSync(join(tmpdir(), "security-hub-dte-pin-"));
    const mutatedPath = join(dir, "page.tsx");
    writeFileSync(mutatedPath, mutated, "utf8");
    const reread = readFileSync(mutatedPath, "utf8");

    expect(() => assertNoBannedInstantArithmetic(extractExpirationCell(reread))).toThrow();
  });
});
