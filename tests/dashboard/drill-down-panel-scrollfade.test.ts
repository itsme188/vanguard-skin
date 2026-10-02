/**
 * QA findings: [qa:analysis-risk-drawer--table-clipped-no-scroll-affordance-regression-1]
 * [qa:mobile-drilldown-panel--pans-whole-panel-no-inner-scroller-regression-1]
 * [qa:analysis-drilldown-mobile--whole-panel-pans-header-and-close-drift]
 *
 * DrillDownPanel's <aside> is `fixed ... overflow-y-auto` with its 7-column
 * table rendered bare inside it. The table is wider than the panel, so the
 * aside itself becomes the horizontal scroller: the whole panel pans
 * sideways, the sticky header and close button drift off screen, and the
 * right-hand columns (Reg, Beta) are clipped with no cue that more content
 * exists. Fixed by wrapping the table in <ScrollFade> — the app's standard
 * horizontal-scroll affordance — the same pattern PositionRisk.tsx already
 * uses for its table.
 *
 * A second defect: the close button (aria-label "Close drill-down") is well
 * under the 44px touch minimum. Fixed with the app's standard
 * pointer-coarse touch hit-area extension, the same pattern
 * MacroOverlayCard.tsx uses.
 *
 * This repo has no DOM test harness (no @testing-library/react, no jsdom) —
 * following the source-scan precedent in
 * tests/dashboard/data-health-view-scrollfade.test.ts instead of rendering.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const DRILL_DOWN_PANEL_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/analysis/DrillDownPanel.tsx",
);

describe("DrillDownPanel wraps its table in ScrollFade and gives the close button a touch hit area", () => {
  const source = readFileSync(DRILL_DOWN_PANEL_PATH, "utf8");

  it("imports ScrollFade", () => {
    expect(source).toMatch(
      /import\s*\{\s*ScrollFade\s*\}\s*from\s*["']\.\.\/ScrollFade["']/,
    );
  });

  it("the <table> sits inside a <ScrollFade> wrapper", () => {
    const tableIdx = source.indexOf("<table");
    expect(tableIdx).toBeGreaterThan(-1);
    expect(source.slice(0, tableIdx)).toMatch(/<ScrollFade[^>]*>/);
    expect(source.slice(tableIdx)).toContain("</ScrollFade>");
    // The ScrollFade opening tag must be the nearest wrapper before the
    // table (not just present somewhere earlier in the file), and its
    // closing tag must be the nearest one after </table> — otherwise the
    // table could sit next to ScrollFade rather than inside it.
    const lastScrollFadeOpenBeforeTable = source
      .slice(0, tableIdx)
      .lastIndexOf("<ScrollFade");
    const closeTableIdx = source.indexOf("</table>", tableIdx);
    expect(closeTableIdx).toBeGreaterThan(-1);
    const nextScrollFadeCloseAfterTable = source.indexOf(
      "</ScrollFade>",
      closeTableIdx,
    );
    expect(lastScrollFadeOpenBeforeTable).toBeGreaterThan(-1);
    expect(nextScrollFadeCloseAfterTable).toBeGreaterThan(closeTableIdx);
  });

  it("the close button carries the pointer-coarse touch hit-area extension", () => {
    const closeButtonLabelIdx = source.indexOf(
      'aria-label="Close drill-down"',
    );
    expect(closeButtonLabelIdx).toBeGreaterThan(-1);
    // The className sits on the <button ...> opening tag that this
    // aria-label belongs to — look at the nearest <button before it.
    const buttonOpenIdx = source.lastIndexOf("<button", closeButtonLabelIdx);
    const buttonCloseTagIdx = source.indexOf(">", closeButtonLabelIdx);
    const buttonOpenTag = source.slice(buttonOpenIdx, buttonCloseTagIdx + 1);
    expect(buttonOpenTag).toContain("relative");
    expect(buttonOpenTag).toContain("pointer-coarse:after:absolute");
    expect(buttonOpenTag).toContain("pointer-coarse:after:content-['']");
  });
});
