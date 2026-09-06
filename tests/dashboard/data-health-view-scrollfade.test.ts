/**
 * QA finding mobile-data-health--tables-hide-key-column-no-scroll-cue: on a
 * 390px phone, DataHealthView's three tables (Price Freshness,
 * Cross-Source Discrepancies, Snapshot Reconciliation) sat in bare
 * `overflow-x-auto` divs. The decisive columns (Staleness / Prices, OHLCV
 * Close / Diff %, Computed / Diff % / Coverage) were entirely past the
 * right edge with no cue that a row continued. Fixed by wrapping each
 * table in <ScrollFade> — the app's standard horizontal-scroll affordance
 * (outer `.scroll-fade` wrapper + CSS gradient cue), the same pattern
 * ImportHistory.tsx already uses for its table.
 *
 * DataHealthView is "use client" and takes NO props at all — it fetches
 * its own data from /api/data-health inside a useEffect, so there is no
 * synchronous render path to a populated table even with a rendering
 * harness. This repo also has no @testing-library/react and no jsdom (see
 * the precedent notes in tests/dashboard/data-health-view-pluralization.test.ts
 * and tests/dashboard/quick-action-chips-scrollfade.test.ts). Following the
 * same source-scan precedent as those two files instead of rendering.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const DATA_HEALTH_VIEW_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/DataHealthView.tsx",
);

/**
 * Returns the source slice from a heading's text through the end of the
 * <section> it lives in, so each table's wrapper can be checked in
 * isolation rather than just "somewhere in the file".
 */
function sectionAfterHeading(src: string, heading: string): string {
  const headingIdx = src.indexOf(heading);
  if (headingIdx === -1) {
    throw new Error(`heading not found in DataHealthView.tsx: ${heading}`);
  }
  const sectionEndIdx = src.indexOf("</section>", headingIdx);
  if (sectionEndIdx === -1) {
    throw new Error(`no closing </section> found after heading: ${heading}`);
  }
  return src.slice(headingIdx, sectionEndIdx);
}

describe("DataHealthView wraps its horizontally-scrollable tables in ScrollFade", () => {
  const source = readFileSync(DATA_HEALTH_VIEW_PATH, "utf8");

  it("imports ScrollFade", () => {
    expect(source).toMatch(
      /import\s*\{\s*ScrollFade\s*\}\s*from\s*["']\.\/ScrollFade["']/,
    );
  });

  it("the Price Freshness table sits inside a <ScrollFade> wrapper", () => {
    const block = sectionAfterHeading(source, "Price Freshness");
    const tableIdx = block.indexOf("<table");
    expect(tableIdx).toBeGreaterThan(-1);
    expect(block.slice(0, tableIdx)).toMatch(/<ScrollFade[^>]*>/);
    expect(block.slice(tableIdx)).toContain("</ScrollFade>");
  });

  it("the Cross-Source Discrepancies table sits inside a <ScrollFade> wrapper", () => {
    const block = sectionAfterHeading(source, "Cross-Source Discrepancies");
    const tableIdx = block.indexOf("<table");
    expect(tableIdx).toBeGreaterThan(-1);
    expect(block.slice(0, tableIdx)).toMatch(/<ScrollFade[^>]*>/);
    expect(block.slice(tableIdx)).toContain("</ScrollFade>");
  });

  it("the Snapshot Reconciliation table sits inside a <ScrollFade> wrapper", () => {
    const block = sectionAfterHeading(source, "Snapshot Reconciliation");
    const tableIdx = block.indexOf("<table");
    expect(tableIdx).toBeGreaterThan(-1);
    expect(block.slice(0, tableIdx)).toMatch(/<ScrollFade[^>]*>/);
    expect(block.slice(tableIdx)).toContain("</ScrollFade>");
  });

  it("no bare overflow-x-auto div wraps a <table> directly anymore", () => {
    expect(source).not.toMatch(/<div className="overflow-x-auto">\s*<table/);
  });
});
