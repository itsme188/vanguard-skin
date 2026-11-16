/**
 * Cash-Deploy card — owner rulings 24 = B and 25 = A (2026-11-16), source pins.
 *  24: a pick allowed under the small-weight tolerance says so in plain words.
 *  25: sectors short by choice are listed, worded from their causes ("you
 *      hold puts here; not filled"), and the cash left out for them is its own line, through
 *      <Money>, with its own reason.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";

const src = readFileSync("app/dashboard/components/analysis/CashDeployCard.tsx", "utf8");

describe("CashDeployCard ruling 24: small-weight tolerance line", () => {
  it("renders the tolerance line inside each pick when the pick used it", () => {
    const at = anchorIndex(src, "p.toleranceSectors.length > 0 &&");
    expect(at).toBeGreaterThan(anchorIndex(src, "{p.rationale}"));
    expect(src.slice(at, at + 300)).toContain("smallWeightToleranceLine(p.toleranceSectors)");
  });
});

describe("CashDeployCard ruling 25: short-by-choice sectors", () => {
  it("lists each short-held sector with its plain line, after the gap table", () => {
    const at = anchorIndex(src, "result.shortHeldSectors.map(");
    expect(at).toBeGreaterThan(anchorIndex(src, "</table>"));
    expect(src.slice(at, at + 300)).toContain("shortHeldSectorLine(s)");
  });

  it("shows the cash left out for shorts through <Money> with its own reason, under Unallocated", () => {
    // Review fix FX3 A2: the label comes from SHORT_UNALLOCATED_LABEL.
    const at = anchorIndex(src, "{SHORT_UNALLOCATED_LABEL}");
    expect(at).toBeGreaterThan(anchorIndex(src, "Unallocated:"));
    const block = src.slice(at, at + 200);
    expect(block).toContain("<Money value={result.unallocatedShortDollars} />");
    expect(block).toContain("result.unallocatedShortReason");
  });
});
