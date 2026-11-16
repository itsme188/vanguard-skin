/**
 * TrustStrip (review round 2, 2026-11-15): a refresh that fails while the
 * figures are already on screen showed the error line but no Retry button,
 * unlike a failed first load. Source pin: the repo has no DOM test harness.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";

const trust = readFileSync("app/dashboard/components/analysis/TrustStrip.tsx", "utf8");

describe("TrustStrip: a failed refresh with figures on screen offers Retry", () => {
  it("the error line after the cells carries the same Retry as a failed load", () => {
    const cellsEnd = anchorIndex(trust, 'label="Bond duration"');
    const drawer = anchorIndex(trust, "{activePanel && (", cellsEnd);
    const block = trust.slice(cellsEnd, drawer);
    expect(block).toContain("{loadError && (");
    expect(block).toContain("{loadError}");
    expect(block).toContain("onClick={retry}");
    expect(block).toContain("Retry");
  });
});
