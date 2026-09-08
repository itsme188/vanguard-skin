/**
 * QA finding accounts-reconciliation-table--no-scroll-cue-difference-and-remove-offscreen-mobile:
 * on /dashboard/accounts?id=N the Reconciliation "Checkpoints" table sat in a
 * `rounded-xl border overflow-hidden overflow-x-auto` div. At 390x844 that
 * measured clientWidth 310 vs scrollWidth 758 with no `.scroll-fade` cue, so
 * Computed was sheared mid-number and Difference / Notes / the action column
 * were entirely off-screen with nothing saying the row continued. The row's
 * only Remove control sat ~387px past the box edge and carried no
 * pointer-coarse hit extension, so even after scrolling it was a 16px-tall
 * touch target.
 *
 * This repo has no jsdom and no @testing-library/react (precedent notes in
 * tests/dashboard/data-health-view-scrollfade.test.ts and
 * tests/dashboard/quick-action-chips-scrollfade.test.ts), so this is a
 * source-scan test like its siblings.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const RECONCILIATION_TABLE_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/ReconciliationTable.tsx",
);

/** The canonical touch hit-extension the app's other small controls use —
 * see app/dashboard/alerts/page.tsx and app/dashboard/today/EarningsHub.tsx. */
const POINTER_COARSE_HIT_EXTENSION =
  "pointer-coarse:after:absolute pointer-coarse:after:content-[''] pointer-coarse:after:-inset-y-2 pointer-coarse:after:-inset-x-0.5";

/**
 * The innermost JSX element still open at `idx` — the element that actually
 * encloses whatever starts there. Walks a tag stack rather than grabbing the
 * nearest `<`, because the nearest `<` before a table is usually a *closed*
 * sibling while the real enclosing box is a wrapper several lines up.
 */
function innermostOpenTagBefore(src: string, idx: number): string {
  const stack: string[] = [];
  for (const m of src.slice(0, idx).matchAll(/<(\/?)([A-Za-z][\w.]*)\b[^>]*?(\/?)>/g)) {
    if (m[1] === "/") stack.pop();
    else if (m[3] !== "/") stack.push(m[0]);
  }
  return stack[stack.length - 1] ?? "";
}

describe("ReconciliationTable checkpoints table is reachable on a phone", () => {
  const source = readFileSync(RECONCILIATION_TABLE_PATH, "utf8");

  it("imports ScrollFade", () => {
    expect(source).toMatch(
      /import\s*\{\s*ScrollFade\s*\}\s*from\s*["']\.\/ScrollFade["']/,
    );
  });

  it("the checkpoints table sits inside a <ScrollFade> wrapper", () => {
    const tableIdx = source.indexOf("<table");
    expect(tableIdx).toBeGreaterThan(-1);
    expect(source.slice(tableIdx)).toContain("</ScrollFade>");
    expect(innermostOpenTagBefore(source, tableIdx)).toMatch(/^<ScrollFade\b/);
  });

  it("no overflow-hidden box directly encloses the table", () => {
    const tableIdx = source.indexOf("<table");
    expect(innermostOpenTagBefore(source, tableIdx)).not.toContain(
      "overflow-hidden",
    );
  });

  describe("the per-row Remove button", () => {
    const ariaIdx = source.indexOf("aria-label={`Remove checkpoint for");
    const buttonSource = (() => {
      if (ariaIdx === -1) return "";
      const start = source.lastIndexOf("<button", ariaIdx);
      const end = source.indexOf("</button>", ariaIdx);
      return start === -1 || end === -1 ? "" : source.slice(start, end);
    })();

    it("is still present", () => {
      expect(ariaIdx).toBeGreaterThan(-1);
      expect(buttonSource).toContain("Remove");
    });

    it("carries the canonical pointer-coarse hit extension", () => {
      expect(buttonSource).toContain(POINTER_COARSE_HIT_EXTENSION);
    });

    it("is position:relative so the ::after extension anchors to it", () => {
      expect(buttonSource).toMatch(/className="[^"]*\brelative\b/);
    });
  });
});
