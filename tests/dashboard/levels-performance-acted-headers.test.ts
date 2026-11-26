import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { anchorIndex } from "../helpers/source-anchor";

// The three P&L columns all average acted alerts only (pnl_acted_30d / 60d / 90d)
// and stay empty below 3 samples. Every header must say so, or a column of
// dashes reads as missing price data.
const src = readFileSync(
  join(process.cwd(), "app/dashboard/levels/performance/page.tsx"),
  "utf8",
);

describe("level performance: acted-only P&L columns are labelled", () => {
  it("each window's header says acted", () => {
    for (const days of [30, 60, 90]) {
      anchorIndex(src, `P&amp;L ${days}d (acted)</th>`, 0, `${days}d header`);
    }
    expect(src).not.toMatch(/P&amp;L \d+d<\/th>/);
  });

  it("the rule box states the acted-only, 3-sample rule for those columns", () => {
    const start = anchorIndex(src, "Attribution rule");
    const end = anchorIndex(src, "<table", start);
    const box = src.slice(start, end).replace(/\s+/g, " ");
    expect(box).toContain("average only alerts you acted on");
    expect(box).toContain("has 3 of them");
  });
});
