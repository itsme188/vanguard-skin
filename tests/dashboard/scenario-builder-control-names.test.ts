/**
 * QA finding: in Build Custom Scenario only the volatility slider had an
 * accessible name. The market-move slider, the rate-move box, each sector
 * row's select and percent box, and the row's remove button were announced
 * without one.
 *
 * No DOM harness in this repo: pinned with a source scan.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const src = readFileSync(
  path.join(process.cwd(), "app/dashboard/components/ScenarioModeling.tsx"),
  "utf8",
);

/** The JSX tag that opens at or before `anchor`, up to its closing bracket. */
function tagAround(anchor: string): string {
  const at = anchorIndex(src, anchor);
  const open = src.lastIndexOf("<", at);
  return src.slice(open, src.indexOf(">\n", at) + 1);
}

describe("custom scenario builder: every control has a name", () => {
  it("market-move slider", () => {
    expect(tagAround("setCustomMarketMove(Number(e.target.value))")).toMatch(/aria-label="Market move in percent"/);
  });

  it("rate-move box", () => {
    expect(tagAround("setCustomRateMove(Number(e.target.value))")).toMatch(/aria-label="Rate move in basis points"/);
  });

  it("sector select, sector percent box and remove button name their row", () => {
    const rows = src.slice(anchorIndex(src, "customSectorOverrides.map((override, i) =>"));
    expect(rows).toMatch(/aria-label=\{`Sector for shock \$\{i \+ 1\}`\}/);
    expect(rows).toMatch(/aria-label=\{`Move in percent for \$\{override\.sector\}`\}/);
    expect(rows).toMatch(/aria-label=\{`Remove the \$\{override\.sector\} shock`\}/);
  });

  it("the volatility slider keeps its name", () => {
    expect(src).toContain('aria-label="Volatility change in points"');
  });
});
