/**
 * Parity + vocabulary pin for workers/cron/src/reaction-matcher.ts's
 * SECTOR_TO_ETF / EVENT_SECTOR_MAP — hand copies of
 * lib/calendar/reaction-snapshot.ts (the Worker can't cross the Next.js
 * path-alias boundary, same constraint as the issuer-family / editions /
 * presence-position copies).
 *
 * Two distinct failure modes, two assertions:
 *
 * 1. PARITY — the copies drift apart. Extract each object literal from raw
 *    source (the issuer-family-parity pattern; byte-strip doesn't apply
 *    because the Worker copy carries its own comment blocks) and compare
 *    the data.
 *
 * 2. VOCABULARY — both copies agree on a key that isn't canonical GICS-11.
 *    This is the bug that actually shipped: both maps said "Health Care"
 *    while normalize-sector.ts's canon says "Healthcare", so every
 *    Healthcare earnings name failed the lookup for months WITH the maps
 *    in perfect agreement. Parity alone would have passed. So every
 *    SECTOR_TO_ETF key must be a member of GICS_SECTORS.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { GICS_SECTORS } from "../../../lib/securities/normalize-sector";

function extractObjectLiteral(
  source: string,
  marker: RegExp,
  label: string,
): Record<string, string | null> {
  const match = source.match(marker);
  if (!match) {
    throw new Error(`reaction-matcher-parity: could not locate ${label}`);
  }
  // The captured text is a valid JS object literal (comments + quoted keys
  // + trailing commas) — evaluate it directly rather than fighting
  // JSON.parse over non-JSON syntax.
  // eslint-disable-next-line no-new-func
  return new Function(`"use strict"; return (${match[1]});`)() as Record<
    string,
    string | null
  >;
}

const mac = readFileSync(
  new URL("../../../lib/calendar/reaction-snapshot.ts", import.meta.url),
  "utf8",
);
const wkr = readFileSync(
  new URL("../src/reaction-matcher.ts", import.meta.url),
  "utf8",
);

const SECTOR_MARKER =
  /export const SECTOR_TO_ETF: Record<string, string> = (\{[\s\S]*?\n\});/;
const EVENT_MARKER =
  /export const EVENT_SECTOR_MAP: Record<string, string \| null> = (\{[\s\S]*?\n\});/;

describe("reaction-matcher parity (Worker mirror of lib/calendar/reaction-snapshot.ts)", () => {
  it("SECTOR_TO_ETF data matches the Mac source", () => {
    const macMap = extractObjectLiteral(mac, SECTOR_MARKER, "Mac SECTOR_TO_ETF");
    const wkrMap = extractObjectLiteral(wkr, SECTOR_MARKER, "Worker SECTOR_TO_ETF");
    expect(Object.keys(macMap).length).toBeGreaterThan(0);
    expect(wkrMap).toEqual(macMap);
  });

  it("EVENT_SECTOR_MAP data matches the Mac source", () => {
    const macMap = extractObjectLiteral(mac, EVENT_MARKER, "Mac EVENT_SECTOR_MAP");
    const wkrMap = extractObjectLiteral(wkr, EVENT_MARKER, "Worker EVENT_SECTOR_MAP");
    expect(Object.keys(macMap).length).toBeGreaterThan(0);
    expect(wkrMap).toEqual(macMap);
  });

  it("every SECTOR_TO_ETF key is canonical GICS-11 (the Health Care drift class)", () => {
    const macMap = extractObjectLiteral(mac, SECTOR_MARKER, "Mac SECTOR_TO_ETF");
    const canon = new Set<string>(GICS_SECTORS);
    const offKeys = Object.keys(macMap).filter((k) => !canon.has(k));
    expect(offKeys).toEqual([]);
  });
});
