/**
 * Ledger finding alerts--view-param-ignored-acted-dismissed-all-fall-through-
 * to-pending: the Alerts page used to parse `?view=` with a nested ternary
 * that recognized only review/armed/conflicts/emails and silently fell back
 * to "pending" for the other five FILTER_OPTIONS tabs (acted, ignored,
 * dismissed, all — and the pending default itself).
 *
 * This is a SOURCE SCAN, not a render test — this repo has no jsdom/RTL
 * harness (see tests/alerts/view-param.test.ts for the behavioral coverage
 * of the parser itself). It pins two things on
 * app/dashboard/alerts/page.tsx: (1) the page imports the single-sourced
 * parser/option-list from lib/alerts/view-param.ts instead of re-declaring
 * StreamFilter/FILTER_OPTIONS locally, and (2) the old nested-ternary
 * `viewParam === "review" ? ... : viewParam === "armed" ? ...` chain is
 * gone, so a future edit can't silently reintroduce the fall-through bug.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

function read(relPath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relPath), "utf8");
}

const ALERTS_PAGE = "app/dashboard/alerts/page.tsx";

describe("alerts page — ?view= parsing is single-sourced", () => {
  const src = read(ALERTS_PAGE);

  it("imports FILTER_OPTIONS, parseAlertsViewParam, and the StreamFilter type from lib/alerts/view-param", () => {
    // [^}]* (not `.` + an /s flag) matches across the multi-line import
    // block — this repo's tsconfig target doesn't support the dotAll flag.
    expect(src).toMatch(
      /import\s*\{[^}]*\bFILTER_OPTIONS\b[^}]*\}\s*from\s*["']@\/lib\/alerts\/view-param["']/
    );
    expect(src).toMatch(
      /import\s*\{[^}]*\bparseAlertsViewParam\b[^}]*\}\s*from\s*["']@\/lib\/alerts\/view-param["']/
    );
    expect(src).toMatch(
      /import\s*\{[^}]*\btype StreamFilter\b[^}]*\}\s*from\s*["']@\/lib\/alerts\/view-param["']/
    );
  });

  it("never re-declares StreamFilter or FILTER_OPTIONS locally (single-sourced, not a parallel copy)", () => {
    expect(src).not.toMatch(/^type StreamFilter\s*=/m);
    expect(src).not.toMatch(/^const FILTER_OPTIONS\s*[:=]/m);
  });

  it("derives initialFilter via parseAlertsViewParam, not a hand-rolled ternary", () => {
    expect(src).toMatch(
      /const initialFilter:\s*StreamFilter\s*=\s*parseAlertsViewParam\(viewParam\)/
    );
  });

  it("the old nested-ternary viewParam fall-through chain is gone", () => {
    expect(src).not.toMatch(/viewParam === "review"\s*\n?\s*\?/);
    expect(src).not.toMatch(/viewParam === "armed"/);
    expect(src).not.toMatch(/viewParam === "conflicts"/);
    expect(src).not.toMatch(/viewParam === "emails"/);
  });
});
