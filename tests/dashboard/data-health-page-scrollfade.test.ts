/**
 * QA finding mobile-data-health--tables-hide-key-column-no-scroll-cue-regression-1:
 * the earlier fix (4d3f30ab) wrapped DataHealthView.tsx's three tables in
 * <ScrollFade>, but the /dashboard/data-health PAGE itself renders two more
 * tables below that component — "Unmapped sector ETFs" and "Sector
 * disagreements" — and both sat directly inside
 * `section.rounded-xl.border.bg-panel.overflow-hidden` with no scroller at
 * all. On a 390px phone the Unmapped table measured 396px wide (LAST SEEN
 * entirely past the right edge) and the Disagreements table 519px (INDUSTRY
 * entirely past it); because the only overflow rule in the chain was
 * `hidden`, a touch pan could not reach those columns at all.
 *
 * This repo has no jsdom and no @testing-library/react (see the precedent
 * notes in tests/dashboard/data-health-view-scrollfade.test.ts), and
 * data-health/page.tsx is a server component that reads the db singleton at
 * module scope, so there is no render path to assert against. Source-scan,
 * same as the sibling test for DataHealthView.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const DATA_HEALTH_PAGE_PATH = path.join(
  process.cwd(),
  "app/dashboard/data-health/page.tsx",
);

/**
 * Returns the source slice for the whole <section> a heading lives in —
 * from the section's own opening tag through its `</section>` — so both the
 * wrapper chain above the table and the table itself are in view.
 */
function sectionForHeading(src: string, heading: string): string {
  const headingIdx = src.indexOf(heading);
  if (headingIdx === -1) {
    throw new Error(`heading not found in data-health/page.tsx: ${heading}`);
  }
  const sectionStartIdx = src.lastIndexOf("<section", headingIdx);
  if (sectionStartIdx === -1) {
    throw new Error(`no opening <section> found before heading: ${heading}`);
  }
  const sectionEndIdx = src.indexOf("</section>", headingIdx);
  if (sectionEndIdx === -1) {
    throw new Error(`no closing </section> found after heading: ${heading}`);
  }
  return src.slice(sectionStartIdx, sectionEndIdx);
}

/**
 * The innermost JSX element still open at `idx` — i.e. the element that
 * actually encloses whatever starts there. Walks a tag stack rather than
 * grabbing the nearest `<`, because the nearest `<` before a table is
 * usually a *closed* sibling (`</div>) : (`) while the real enclosing box is
 * the section several lines up.
 */
function innermostOpenTagBefore(block: string, idx: number): string {
  const stack: string[] = [];
  for (const m of block.slice(0, idx).matchAll(/<(\/?)([A-Za-z][\w.]*)\b[^>]*?(\/?)>/g)) {
    if (m[1] === "/") stack.pop();
    else if (m[3] !== "/") stack.push(m[0]);
  }
  return stack[stack.length - 1] ?? "";
}

describe("data-health page wraps its two tables in ScrollFade", () => {
  const source = readFileSync(DATA_HEALTH_PAGE_PATH, "utf8");

  it("imports ScrollFade", () => {
    expect(source).toMatch(
      /import\s*\{\s*ScrollFade\s*\}\s*from\s*["']\.\.\/components\/ScrollFade["']/,
    );
  });

  for (const heading of ["Unmapped sector ETFs", "Sector disagreements"]) {
    it(`the ${heading} table sits inside a <ScrollFade> wrapper`, () => {
      const block = sectionForHeading(source, heading);
      const tableIdx = block.indexOf("<table");
      expect(tableIdx).toBeGreaterThan(-1);
      expect(block.slice(tableIdx)).toContain("</ScrollFade>");
      // ScrollFade must be the element IMMEDIATELY enclosing the table — one
      // sitting elsewhere in the section would not give this table a scroller.
      expect(innermostOpenTagBefore(block, tableIdx)).toMatch(/^<ScrollFade\b/);
    });

    it(`no overflow-hidden box directly encloses the ${heading} table`, () => {
      const block = sectionForHeading(source, heading);
      const tableIdx = block.indexOf("<table");
      expect(tableIdx).toBeGreaterThan(-1);
      expect(innermostOpenTagBefore(block, tableIdx)).not.toContain(
        "overflow-hidden",
      );
    });
  }
});
