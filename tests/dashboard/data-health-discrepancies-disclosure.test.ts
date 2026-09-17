/**
 * QA finding data-health-discrepancies--20-row-silent-truncation: the
 * Cross-Source Discrepancies panel rendered exactly `discrepancies.slice(0,
 * 20)` rows with no count in the heading and no footer, while the query
 * itself already truncated to `LIMIT 50` (see
 * tests/queries/data-health.test.ts) and `getDataHealthSummary`'s
 * `totalDiscrepancies` was `discrepancies.length` — capped at that same 50
 * and rendered nowhere on the page. The real total (via the new
 * `countCrossSourceDiscrepancies`, sharing the discrepancy predicate with
 * the list query) can be well over 100.
 *
 * This file pins the view-side disclosure added alongside the query fix —
 * matching the existing Price Freshness "(50 stalest of N held
 * securities)" / "Showing the 50 stalest rows — N fresher securities
 * hidden." pattern and the Snapshot Reconciliation row-limit disclosure in
 * the same component, with the row cap extracted into a named constant so
 * the heading, footer, and slice can never drift apart.
 *
 * DataHealthView is "use client" with no jsdom/@testing-library/react
 * harness in this repo (see precedent notes in
 * tests/dashboard/data-health-view-pluralization.test.ts and
 * tests/dashboard/data-health-reconciliation-disclosure.test.ts) — pinned
 * with a source scan, same pattern as those files.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const VIEW_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/DataHealthView.tsx",
);

/** Source slice from a heading's text through the end of its <section>. */
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

describe("DataHealthView — Cross-Source Discrepancies row-limit disclosure", () => {
  const source = readFileSync(VIEW_PATH, "utf8");
  const block = sectionAfterHeading(source, "Cross-Source Discrepancies");

  it("extracts the row cap into a named constant", () => {
    expect(source).toMatch(/const DISCREPANCY_ROW_LIMIT = 20;/);
  });

  it("the slice uses the constant, not a bare literal 20", () => {
    expect(block).toMatch(
      /discrepancies\.slice\(0,\s*DISCREPANCY_ROW_LIMIT\)/,
    );
    expect(block).not.toMatch(/discrepancies\.slice\(0,\s*20\)/);
  });

  it("the heading references summary.totalDiscrepancies, showing the slice size once the true total exceeds it", () => {
    expect(block).toMatch(
      /\{summary\.totalDiscrepancies > DISCREPANCY_ROW_LIMIT\s*\n?\s*\?\s*` · showing \$\{DISCREPANCY_ROW_LIMIT\} of \$\{summary\.totalDiscrepancies\}`\s*\n?\s*:\s*` · \$\{summary\.totalDiscrepancies\}`\}/,
    );
  });

  it("a footer discloses the hidden row count, gated on the true total exceeding the cap", () => {
    expect(block).toMatch(
      /\{summary\.totalDiscrepancies > DISCREPANCY_ROW_LIMIT && \(/,
    );
    expect(block).toMatch(
      /Showing the \{DISCREPANCY_ROW_LIMIT\} largest discrepancies/,
    );
    expect(block).toMatch(
      /\{summary\.totalDiscrepancies - DISCREPANCY_ROW_LIMIT\} hidden\./,
    );
  });

  it("the footer is styled like the Price Freshness / Snapshot Reconciliation footers", () => {
    expect(block).toMatch(
      /<div className="px-5 py-2 border-t border-edge text-xs text-ink-faint">\s*\n\s*Showing the \{DISCREPANCY_ROW_LIMIT\} largest discrepancies/,
    );
  });

  it("does not derive the count from discrepancies.length (that array is already LIMIT-50-truncated)", () => {
    // The heading/footer disclosure must read the true total off the
    // summary, never off the (possibly truncated) list itself.
    expect(block).not.toMatch(/discrepancies\.length > DISCREPANCY_ROW_LIMIT/);
  });
});
