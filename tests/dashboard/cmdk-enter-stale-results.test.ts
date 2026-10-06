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
import { anchorIndex } from "@/tests/helpers/source-anchor";

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
    const enter = src.slice(anchorIndex(src, 'e.key === "Enter"'));
    expect(enter).toMatch(/resultsQuery === /);
    expect(enter).toMatch(/pendingSubmit\.current = true/);
  });

  it("the fetch drops a response for a query that is no longer current and fires the pending submit", () => {
    expect(src).toMatch(/latestQuery\.current !== /);
    const fetchBlock = src.slice(anchorIndex(src, "/api/search?q="));
    expect(fetchBlock).toMatch(/pendingSubmit\.current[\s\S]{0,200}navigate\(/);
  });

  it("a queued Enter is dropped when the palette closes (Esc before results arrive must not navigate later)", () => {
    const openEffectStart = anchorIndex(src, "// Focus input when opened");
    const navigateStart = anchorIndex(src, "const navigate = useCallback");
    expect(openEffectStart).toBeGreaterThan(-1);
    expect(navigateStart).toBeGreaterThan(openEffectStart);
    const openEffect = src.slice(openEffectStart, navigateStart);
    const elseBranchStart = anchorIndex(openEffect, "} else {");
    expect(elseBranchStart).toBeGreaterThan(-1);
    const elseBranch = openEffect.slice(elseBranchStart);
    expect(elseBranch).toMatch(/pendingSubmit\.current = false/);
  });

  it("clearing the query while a fetch is in flight clears the spinner (the !q branch must not skip setLoading(false))", () => {
    const debounceEffectStart = anchorIndex(src, "// Debounced search");
    const timerStart = anchorIndex(src, "const timer = setTimeout");
    expect(debounceEffectStart).toBeGreaterThan(-1);
    expect(timerStart).toBeGreaterThan(debounceEffectStart);
    const debounceEffect = src.slice(debounceEffectStart, timerStart);
    const emptyBranchStart = anchorIndex(debounceEffect, "if (!q) {");
    expect(emptyBranchStart).toBeGreaterThan(-1);
    const emptyBranch = debounceEffect.slice(emptyBranchStart);
    expect(emptyBranch).toMatch(/setLoading\(false\)/);
  });
});
