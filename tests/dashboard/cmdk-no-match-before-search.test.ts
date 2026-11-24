/**
 * QA finding: the palette printed "No ticker matches" for every keystroke
 * until the 150 ms debounce fired, because the empty state only looked at
 * `loading` (set inside the timer) and an empty list. A held ticker was
 * briefly reported as unknown.
 *
 * Fix: the empty state is a verdict about ONE query, so it renders only when
 * the list on hand answers the typed query (`resultsQuery`, the state the
 * Enter-key fix already keeps).
 *
 * No DOM harness in this repo: pinned with a source scan.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = readFileSync(
  path.join(process.cwd(), "app/dashboard/components/CommandPalette.tsx"),
  "utf8",
);

describe("CommandPalette: no 'no match' verdict before the search has run", () => {
  const at = anchorIndex(src, "No ticker matches");
  const guard = src.slice(anchorIndex(src, "{/* Empty state */}"), at);

  it("the empty state requires the list to answer the typed query", () => {
    expect(guard).toMatch(/resultsQuery === query\.trim\(\)/);
  });

  it("still waits for the fetch and for an empty list", () => {
    expect(guard).toMatch(/!loading/);
    expect(guard).toMatch(/results\.length === 0/);
  });

  it("a failed fetch still records which query it answered", () => {
    const fetchBody = src.slice(anchorIndex(src, "// Debounced search"), anchorIndex(src, "}, 150);"));
    const catchBlock = fetchBody.slice(anchorIndex(fetchBody, "} catch"));
    expect(catchBlock).toMatch(/setResultsQuery\(q\)/);
  });
});
