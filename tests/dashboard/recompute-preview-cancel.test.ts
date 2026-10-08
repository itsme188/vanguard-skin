/**
 * The Recompute preview relabels the one button to "Confirm recompute". Without
 * a Cancel the only way out was to leave the page (browser check 2026-10-07).
 * Source-pin: there is no DOM harness for client components.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

const src = readFileSync(join(process.cwd(), "app/dashboard/components/RecomputeButton.tsx"), "utf8");

describe("Recompute preview can be cancelled", () => {
  it("a Cancel button shows only while a preview is open and clears it without a request", () => {
    const start = anchorIndex(src, "{summary && !isLoading && (");
    const block = src.slice(start, start + 400);
    expect(block).toContain("onClick={() => setSummary(null)}");
    expect(block).toContain("Cancel");
    expect(block).not.toContain("fetch(");
  });
});
