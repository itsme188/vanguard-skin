/**
 * Parity test for workers/cron/src/fallback-earnings.ts's ISSUER_FAMILIES —
 * a hand copy of lib/securities/issuer-family.ts's FAMILIES (the Worker
 * can't cross the Next.js path-alias boundary, same constraint as the
 * presence-position / editions copies). fallback-earnings.ts now has 2
 * in-Worker consumers (its own composer + calendar-enrich.ts's push-at-print
 * hook) and had no parity pin — a drift here silently mismatches which
 * dual-class symbols (GOOG/GOOGL, BRK A/B, ...) the cloud path treats as the
 * same earnings print.
 *
 * The two files' code shape differs (Mac's FAMILIES is a private const with
 * a sibling `sameIssuer` export; the Worker's ISSUER_FAMILIES is exported
 * inline inside a much larger file, with no `sameIssuer`), so a byte-strip
 * comparison (the editions.ts / presence-position.ts pattern) doesn't apply.
 * Instead: read both files' raw source, extract each literal array via
 * regex, and compare the FAMILY DATA itself, order-independent.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

function extractFamilies(source: string, marker: RegExp): readonly (readonly string[])[] {
  const match = source.match(marker);
  if (!match) {
    throw new Error("issuer-family-parity: could not locate the families array literal");
  }
  // The captured text is a valid JS array literal (comments + double-quoted
  // strings + a trailing comma) — evaluate it directly rather than fighting
  // JSON.parse over non-JSON syntax.
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict"; return (${match[1]});`)() as readonly (readonly string[])[];
}

function normalize(families: readonly (readonly string[])[]): string[][] {
  return families
    .map((fam) => [...fam].map((s) => s.toUpperCase()).sort())
    .sort((a, b) => a.join(",").localeCompare(b.join(",")));
}

describe("issuer-family parity (Worker mirror of lib/securities/issuer-family.ts)", () => {
  it("ISSUER_FAMILIES data matches the Mac source's FAMILIES data", () => {
    const mac = readFileSync(
      new URL("../../../lib/securities/issuer-family.ts", import.meta.url),
      "utf8",
    );
    const wkr = readFileSync(
      new URL("../src/fallback-earnings.ts", import.meta.url),
      "utf8",
    );

    const macFamilies = extractFamilies(
      mac,
      /const FAMILIES: ReadonlyArray<readonly string\[\]> = (\[[\s\S]*?\n\]);/,
    );
    const wkrFamilies = extractFamilies(
      wkr,
      /export const ISSUER_FAMILIES: ReadonlyArray<readonly string\[\]> = (\[[\s\S]*?\n\]);/,
    );

    expect(macFamilies.length).toBeGreaterThan(0);
    expect(normalize(wkrFamilies)).toEqual(normalize(macFamilies));
  });
});
