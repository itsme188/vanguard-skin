/**
 * QA finding data-health-snapshot-reconciliation--30-of-311-no-disclosure-mostly-live-self-comparisons:
 * the Snapshot Reconciliation panel silently `.slice(0, 30)`d ~300 rows with
 * no count and no footer, while the underlying query (see
 * tests/queries/data-health-snapshot-reconciliation.test.ts) mostly returned
 * live-snapshot rows compared against themselves. The query fix excludes
 * live sources so only statement-authority rows remain; this file pins the
 * view-side disclosure that was added alongside it — matching the existing
 * Price Freshness "(50 stalest of N held securities)" / "Showing the 50
 * stalest rows — N fresher securities hidden." pattern in the same
 * component, with the row cap extracted into a named constant so the
 * heading, footer, and slice can never drift apart.
 *
 * DataHealthView is "use client" with no jsdom/@testing-library/react
 * harness in this repo (see precedent notes in
 * tests/dashboard/data-health-view-pluralization.test.ts and
 * tests/dashboard/data-health-view-scrollfade.test.ts) — pinned with a
 * source scan, same pattern as those two files.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const VIEW_PATH = path.join(
  process.cwd(),
  "app/dashboard/components/DataHealthView.tsx",
);
const QUERY_PATH = path.join(process.cwd(), "lib/queries/data-health.ts");

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

describe("DataHealthView — Snapshot Reconciliation row-limit disclosure", () => {
  const source = readFileSync(VIEW_PATH, "utf8");
  const block = sectionAfterHeading(source, "Snapshot Reconciliation");

  it("extracts the row cap into a named constant", () => {
    expect(source).toMatch(/const RECONCILIATION_ROW_LIMIT = 30;/);
  });

  it("the slice uses the constant, not a bare literal 30", () => {
    expect(block).toMatch(
      /reconciliation\.slice\(0,\s*RECONCILIATION_ROW_LIMIT\)/,
    );
    // No more `.slice(0, 30)` anywhere in this section — it must route
    // through the constant.
    expect(block).not.toMatch(/reconciliation\.slice\(0,\s*30\)/);
  });

  it("the heading discloses the row count once the list exceeds the cap", () => {
    expect(block).toMatch(
      /\{reconciliation\.length > RECONCILIATION_ROW_LIMIT\s*\n?\s*\?\s*` · newest \$\{RECONCILIATION_ROW_LIMIT\} of \$\{reconciliation\.length\}`\s*\n?\s*:\s*""\}/,
    );
  });

  it("a footer discloses the hidden row count, gated on exceeding the cap", () => {
    expect(block).toMatch(
      /\{reconciliation\.length > RECONCILIATION_ROW_LIMIT && \(/,
    );
    expect(block).toMatch(/Showing the \{RECONCILIATION_ROW_LIMIT\} newest rows/);
    expect(block).toMatch(
      /\{reconciliation\.length - RECONCILIATION_ROW_LIMIT\} older hidden\./,
    );
  });

  it("the footer is styled like the Price Freshness footer", () => {
    expect(block).toMatch(
      /<div className="px-5 py-2 border-t border-edge text-xs text-ink-faint">\s*\n\s*Showing the \{RECONCILIATION_ROW_LIMIT\} newest rows/,
    );
  });
});

describe("getSnapshotReconciliation query — excludes live snapshot sources", () => {
  const source = readFileSync(QUERY_PATH, "utf8");

  it("imports excludeLiveSnapshotsSql from lib/db/live-sources", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*\bexcludeLiveSnapshotsSql\b[^}]*\}\s*from\s*["']@\/lib\/db\/live-sources["']/,
    );
  });

  function functionBody(fnName: string): string {
    const startIdx = source.indexOf(`export function ${fnName}`);
    if (startIdx === -1) {
      throw new Error(`function not found: ${fnName}`);
    }
    const nextFnIdx = source.indexOf("export function", startIdx + 1);
    const endIdx = nextFnIdx === -1 ? source.length : nextFnIdx;
    return source.slice(startIdx, endIdx);
  }

  it("getSnapshotReconciliation's SQL applies excludeLiveSnapshotsSql to COALESCE(ms.source, 'manual') so an explicit-NULL source is not dropped", () => {
    const body = functionBody("getSnapshotReconciliation");
    expect(body).toMatch(/excludeLiveSnapshotsSql\(["']COALESCE\(ms\.source,\s*'manual'\)["']\)/);
  });
});
