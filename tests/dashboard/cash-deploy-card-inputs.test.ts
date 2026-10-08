import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";

const src = readFileSync("app/dashboard/components/analysis/CashDeployCard.tsx", "utf8");

describe("CashDeployCard input behavior source pins", () => {
  it("does not cap the sector gap table with slice(0, 8)", () => {
    const tbody = src.slice(
      anchorIndex(src, "<tbody>"),
      anchorIndex(src, "</tbody>", anchorIndex(src, "<tbody>"))
    );
    expect(tbody).toContain("result.gaps.map");
    expect(tbody).not.toContain("result.gaps.slice");
  });

  it("clears stale validation errors when editing the cash amount", () => {
    const input = src.slice(
      anchorIndex(src, 'placeholder="Amount to deploy"') - 500,
      anchorIndex(src, 'placeholder="Amount to deploy"') + 700
    );
    expect(input).toContain("setError(null)");
  });

  it("submits the cash suggestion when Enter is pressed in the amount field", () => {
    const input = src.slice(
      anchorIndex(src, 'placeholder="Amount to deploy"') - 500,
      anchorIndex(src, 'placeholder="Amount to deploy"') + 900
    );
    expect(input).toContain("onKeyDown");
    expect(input).toContain("Enter");
    expect(input).toContain("run()");
  });
});
