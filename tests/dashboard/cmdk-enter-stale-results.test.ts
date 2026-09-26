/**
 * QA findings global-cmdk--enter-with-stale-results-navigates-to-previous-query-top-result
 * and global-cmdk--enter-before-results-render-is-no-op-regression-1: the
 * result list is fetched on a 150 ms debounce, but Enter read whatever
 * `results` held at keydown time. Type MSFT, wait, clear, type NVDA and hit
 * Enter at once: Enter navigated to MSFT's hub (the stale list). Hit Enter
 * before any list existed: Enter was a silent no-op.
 *
 * Fix: the palette remembers which query the current list answers
 * (`resultsQuery`); Enter navigates only when that matches the typed query,
 * otherwise it queues a pending submit that fires when the matching fetch
 * resolves. A response for a query that is no longer current is dropped.
 *
 * No jsdom / @testing-library harness in this repo — pinned with a source
 * scan, same as tests/dashboard/cmdk-hover-and-option-ranking.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const src = readFileSync(
  path.join(process.cwd(), "app/dashboard/components/CommandPalette.tsx"),
  "utf8",
);

describe("CommandPalette — Enter vs. stale / not-yet-loaded results", () => {
  it("tracks which query the result list answers", () => {
    expect(src).toMatch(/resultsQuery/);
    expect(src).toMatch(/setResultsQuery\(/);
  });

  it("Enter navigates only when the results match the typed query, else queues a pending submit", () => {
    const enter = src.slice(src.indexOf('e.key === "Enter"'));
    expect(enter).toMatch(/resultsQuery === /);
    expect(enter).toMatch(/pendingSubmit\.current = true/);
  });

  it("the fetch drops a response for a query that is no longer current and fires the pending submit", () => {
    expect(src).toMatch(/latestQuery\.current !== /);
    const fetchBlock = src.slice(src.indexOf("/api/search?q="));
    expect(fetchBlock).toMatch(/pendingSubmit\.current[\s\S]{0,200}navigate\(/);
  });
});
