/**
 * Parity for workers/cron/src/actuals-basis.ts, the hand mirror of
 * lib/earnings/actuals-basis.ts (the Worker bundle cannot cross the Next.js
 * path-alias boundary). Two pins:
 *
 *   1. the two files are byte-identical below the mirror marker;
 *   2. the Worker copy returns the SAME line as the Mac copy over one case
 *      list. This is what covers the three helpers the Worker restates above
 *      the marker (figure parser, revenue format, plausibility gate).
 *
 * The scoreboard-level half (renderScoreboard against the Mac helper) is in
 * test/fallback-earnings.test.ts. Synthetic figures only.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  renderActualsBasisLine,
  ACTUALS_BASIS_ADJUSTED_LINE,
  ACTUALS_BASIS_VENDOR_LINE,
} from "../src/actuals-basis";
import {
  renderActualsBasisLine as macRenderActualsBasisLine,
  ACTUALS_BASIS_ADJUSTED_LINE as MAC_ADJUSTED_LINE,
  ACTUALS_BASIS_VENDOR_LINE as MAC_VENDOR_LINE,
} from "../../../lib/earnings/actuals-basis";

const MARKER = "// ── mirrored below this line ──";
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const STAMP = "2026-01-06 21:30:00";
const CONSENSUS = "EPS 1.00 · Rev 500000000";
const FOOTNOTE = "For reference, vendor figure (basis may differ): ";

interface Case {
  name: string;
  shown: string | null;
  stamp: string | null;
  vendor: string | null;
  consensus?: string | null;
  /** The exact line, pinned for the cases the brief names. */
  line?: string | null;
}

const CASES: Case[] = [
  { name: "vendor only", shown: "EPS 1.10 · Rev 510,000,000", stamp: null, vendor: null, line: MAC_VENDOR_LINE },
  { name: "adjusted, no kept figure", shown: "EPS 1.10 · Rev 510000000", stamp: STAMP, vendor: null, line: MAC_ADJUSTED_LINE },
  {
    name: "adjusted, an equal kept figure",
    shown: "EPS 1.10 · Rev 510000000",
    stamp: STAMP,
    vendor: "EPS 1.10 · Rev 510,000,000",
    line: MAC_ADJUSTED_LINE,
  },
  {
    name: "adjusted, a kept figure that only differs below the printed precision",
    shown: "EPS 1.10 · Rev 510000000",
    stamp: STAMP,
    vendor: "EPS 1.104 · Rev 510,040,000",
    line: MAC_ADJUSTED_LINE,
  },
  {
    name: "adjusted, a differing EPS",
    shown: "EPS 1.10 · Rev 505000000",
    stamp: STAMP,
    vendor: "EPS 1.02 · Rev 505,000,000",
    line: `*Actuals basis: adjusted (worksheet or hand-entered figure). ${FOOTNOTE}EPS 1.02.*`,
  },
  {
    name: "adjusted, a differing revenue",
    shown: "EPS 1.10 · Rev 510000000",
    stamp: STAMP,
    vendor: "EPS 1.10 · Rev 505,000,000",
    line: `*Actuals basis: adjusted (worksheet or hand-entered figure). ${FOOTNOTE}Revenue $505.0M.*`,
  },
  {
    name: "adjusted, both differ",
    shown: "EPS 1.10 · Rev 510000000",
    stamp: STAMP,
    vendor: "EPS 1.02 · Rev 505,000,000",
    line: `*Actuals basis: adjusted (worksheet or hand-entered figure). ${FOOTNOTE}EPS 1.02 · Revenue $505.0M.*`,
  },
  {
    name: "adjusted, an implausible kept figure (sign flip against consensus)",
    shown: "EPS 1.80",
    stamp: STAMP,
    vendor: "EPS -1.20",
    consensus: "EPS 1.74",
    line: MAC_ADJUSTED_LINE,
  },
  {
    name: "adjusted, an implausible kept figure (ratio blowup)",
    shown: "EPS 1.10",
    stamp: STAMP,
    vendor: "EPS 5.11",
    consensus: "EPS 1.00",
    line: MAC_ADJUSTED_LINE,
  },
  {
    name: "adjusted, kept 'Rev 0' beside an EPS: the placeholder is not a figure",
    shown: "EPS 1.10 · Rev 510000000",
    stamp: STAMP,
    vendor: "EPS 1.02 · Rev 0",
    line: `*Actuals basis: adjusted (worksheet or hand-entered figure). ${FOOTNOTE}EPS 1.02.*`,
  },
  { name: "adjusted, kept 'Rev 0' alone", shown: "EPS 1.10 · Rev 510000000", stamp: STAMP, vendor: "Rev 0", line: MAC_ADJUSTED_LINE },
  { name: "a kept figure beside an unstamped actual", shown: "EPS 1.10", stamp: null, vendor: "EPS 1.02", line: MAC_VENDOR_LINE },
  { name: "no actual shown", shown: null, stamp: STAMP, vendor: "EPS 1.02", line: null },
  { name: "a shown 'Rev 0' alone is no actual", shown: "Rev 0", stamp: null, vendor: null, line: null },
  // Revenue format bands of the restated formatter (billions, the
  // just-under-a-billion promotion, millions, thousands, under a thousand).
  { name: "revenue in billions", shown: "EPS 1.10", stamp: STAMP, vendor: "Rev 4,340,000,000", consensus: null },
  { name: "revenue just under a billion", shown: "EPS 1.10", stamp: STAMP, vendor: "Rev 999,960,000", consensus: null },
  { name: "revenue in millions", shown: "EPS 1.10", stamp: STAMP, vendor: "Rev 245,000,000", consensus: null },
  { name: "revenue in thousands", shown: "EPS 1.10", stamp: STAMP, vendor: "Rev 945,400", consensus: null },
  { name: "revenue under a thousand", shown: "EPS 1.10", stamp: STAMP, vendor: "Rev 945", consensus: null },
  { name: "a zero EPS is a real figure", shown: "EPS 0.05", stamp: STAMP, vendor: "EPS 0", consensus: "EPS 0.04" },
  { name: "a negative EPS on both sides", shown: "EPS -0.20", stamp: STAMP, vendor: "EPS -0.25", consensus: "EPS -0.22" },
  { name: "no consensus at all", shown: "EPS 1.10", stamp: STAMP, vendor: "EPS 1.02", consensus: null },
];

describe("actuals-basis parity (Worker mirror of lib/earnings/actuals-basis.ts)", () => {
  it("is byte-identical to the Mac source below the mirror marker", () => {
    const mac = read("../../../lib/earnings/actuals-basis.ts");
    const wkr = read("../src/actuals-basis.ts");
    expect(mac.indexOf(MARKER)).toBeGreaterThan(-1);
    expect(wkr.indexOf(MARKER)).toBeGreaterThan(-1);
    const strip = (s: string) => s.slice(s.indexOf(MARKER));
    expect(strip(wkr)).toBe(strip(mac));
  });

  it("the two label strings are the Mac's", () => {
    expect(ACTUALS_BASIS_VENDOR_LINE).toBe(MAC_VENDOR_LINE);
    expect(ACTUALS_BASIS_ADJUSTED_LINE).toBe(MAC_ADJUSTED_LINE);
  });

  it.each(CASES)("same line as the Mac: $name", (c) => {
    const input = {
      shownActual: c.shown,
      manualActualsAt: c.stamp,
      vendorActualValue: c.vendor,
      consensus: c.consensus === undefined ? CONSENSUS : c.consensus,
    };
    const mac = macRenderActualsBasisLine(input);
    expect(renderActualsBasisLine(input)).toBe(mac);
    if (c.line !== undefined) expect(mac).toBe(c.line);
  });

  it("the revenue cases really print a revenue (the bands are exercised)", () => {
    const line = (vendor: string) =>
      renderActualsBasisLine({ shownActual: "EPS 1.10", manualActualsAt: STAMP, vendorActualValue: vendor, consensus: null });
    expect(line("Rev 4,340,000,000")).toContain("Revenue $4.34B.");
    expect(line("Rev 999,960,000")).toContain("Revenue $1.00B.");
    expect(line("Rev 245,000,000")).toContain("Revenue $245.0M.");
    expect(line("Rev 945,400")).toContain("Revenue $945,400.");
    expect(line("Rev 945")).toContain("Revenue $945.00.");
  });
});
