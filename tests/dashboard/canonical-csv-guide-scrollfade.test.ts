/**
 * QA finding mobile-import-guide--column-tables-clip-description-no-scrollfade:
 * on a 390px phone, each format block of the CSV Format Guide on
 * /dashboard/import had THREE bare `overflow-x-auto` scrollers with no
 * `.scroll-fade` cue — the header <code> line, the column table (clientWidth
 * 278 vs scrollWidth 451, so the Description column explaining what each
 * column means was cut mid-sentence), and the example <pre>. Fixed by
 * wrapping all three in <ScrollFade>, the app's standard horizontal-scroll
 * affordance (outer `.scroll-fade` wrapper + CSS gradient cue) that
 * ImportHistory.tsx on the same page and DataHealthView.tsx already use.
 *
 * This repo has no @testing-library/react and no jsdom, so this follows the
 * source-scan precedent of tests/dashboard/data-health-view-scrollfade.test.ts
 * rather than rendering.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const GUIDE_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/CanonicalCsvGuide.tsx",
);

/**
 * Returns the source slice from one JSX section marker comment through the
 * next one, so each scroller can be checked in isolation rather than just
 * "somewhere in the file".
 */
function sectionBetweenMarkers(src: string, start: string, end: string): string {
  const startIdx = src.indexOf(start);
  if (startIdx === -1) {
    throw new Error(`marker not found in CanonicalCsvGuide.tsx: ${start}`);
  }
  const endIdx = src.indexOf(end, startIdx);
  if (endIdx === -1) {
    throw new Error(`end marker ${end} not found after ${start}`);
  }
  return src.slice(startIdx, endIdx);
}

describe("CanonicalCsvGuide wraps its horizontal scrollers in ScrollFade", () => {
  const source = readFileSync(GUIDE_PATH, "utf8");

  it("imports ScrollFade", () => {
    expect(source).toMatch(
      /import\s*\{\s*ScrollFade\s*\}\s*from\s*["']\.\/ScrollFade["']/,
    );
  });

  it("the header <code> block sits inside a <ScrollFade> wrapper", () => {
    const block = sectionBetweenMarkers(
      source,
      "{/* Header row */}",
      "{/* Column table */}",
    );
    const codeIdx = block.indexOf("<code");
    expect(codeIdx).toBeGreaterThan(-1);
    expect(block.slice(0, codeIdx)).toMatch(/<ScrollFade[^>]*>/);
    expect(block.slice(codeIdx)).toContain("</ScrollFade>");
  });

  it("the column table sits inside a <ScrollFade> wrapper", () => {
    const block = sectionBetweenMarkers(
      source,
      "{/* Column table */}",
      "{/* Constraints */}",
    );
    const tableIdx = block.indexOf("<table");
    expect(tableIdx).toBeGreaterThan(-1);
    expect(block.slice(0, tableIdx)).toMatch(/<ScrollFade[^>]*>/);
    expect(block.slice(tableIdx)).toContain("</ScrollFade>");
  });

  it("the example <pre> block sits inside a <ScrollFade> wrapper and keeps whitespace-pre", () => {
    const block = sectionBetweenMarkers(source, "{/* Example */}", "</details>");
    const preIdx = block.indexOf("<pre");
    expect(preIdx).toBeGreaterThan(-1);
    expect(block.slice(0, preIdx)).toMatch(/<ScrollFade[^>]*>/);
    expect(block.slice(preIdx)).toContain("</ScrollFade>");
    // The example is pre-formatted CSV: it must not start wrapping.
    expect(block).toContain("whitespace-pre");
  });

  it("no element in the file still carries a bare overflow-x-auto (ScrollFade owns the scroller)", () => {
    expect(source).not.toContain("overflow-x-auto");
  });
});
