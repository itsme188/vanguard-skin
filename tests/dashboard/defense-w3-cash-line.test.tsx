import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// Owner ruling 2026-11-16 (Defense view): a separate, labelled cash line near
// the protection ratio, read from the analysis' cashLine (the concentration
// card's splitConcentrationUniverse figure), never added into the ratio.
// Hidden when the scope holds none; borrowing is said instead of a share.
// No DOM harness for this async server component: source pins.
const src = readFileSync("app/dashboard/components/DefenseView.tsx", "utf8");

describe("Defense cash line (owner ruling 2026-11-16)", () => {
  it("is labelled, rendered through Pct, and sits in the headline strip after the protection ratio", () => {
    const ratio = anchorIndex(src, "Protection ratio");
    // Searched from the ratio: the empty state renders the line too (FX4).
    const line = anchorIndex(src, "<DefenseCashLineView cash={analysis.cashLine} />", ratio);
    expect(line).toBeGreaterThan(ratio);
    anchorIndex(src, "Cash-equivalent funds:");
    anchorIndex(src, "<Pct value={cash.weight * 100} digits={1}");
    anchorIndex(src, "of this scope");
  });

  it("says when the scope holds no cash-equivalent fund, and says borrowing when cash is negative", () => {
    anchorIndex(src, "if (cash.holdingCount === 0 && cash.borrowed.holdingCount === 0) {");
    anchorIndex(src, "{DEFENSE_NO_CASH_FUNDS_NOTE}");
    anchorIndex(src, "Borrowed cash:");
    anchorIndex(src, "<Money value={cash.borrowed.marketValue}");
  });

  it("carries the one-line caption: cash is not a hedge of the long book", () => {
    anchorIndex(src, "Cash lowers what can be lost, but it is not a hedge against the long book");
  });

  it("never enters the protection ratio's figure", () => {
    const ratioCell = src.slice(anchorIndex(src, "Protection ratio"), anchorIndex(src, "Net exposure"));
    expect(ratioCell).not.toMatch(/cash/i);
  });
});
