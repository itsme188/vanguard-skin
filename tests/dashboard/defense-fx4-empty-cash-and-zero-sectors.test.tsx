import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "@/tests/helpers/source-anchor";
import { protectsLabel } from "@/app/dashboard/components/DefenseTables";

// FX4-UI (browser pass 2026-11-16).
//  1. A scope with no options or shorts still shows the cash-equivalent funds
//     line under the empty-state sentence (same component, same captions).
//  2. "Protects" leaves out a sector whose share rounds to 0%; when every
//     share is 0%, the unfiltered wording stays.
const src = readFileSync("app/dashboard/components/DefenseView.tsx", "utf8");

describe("Defense empty state keeps the cash line (FX4 item 1)", () => {
  it("renders DefenseCashLineView after the empty-state sentence", () => {
    const emptyReason = anchorIndex(src, "No options or short positions in this scope");
    const emptyEnd = anchorIndex(src, "const protectionInterp");
    const block = src.slice(emptyReason, emptyEnd);
    expect(block).toContain("<DefenseCashLineView cash={analysis.cashLine} />");
    // No early return of the bare empty section that would skip the line.
    expect(block).not.toMatch(/return empty;/);
  });
});

describe("Protects leaves out 0% sectors (FX4 item 2)", () => {
  it("drops a sector whose share rounds to 0%", () => {
    expect(
      protectsLabel("sector: Technology 60% / Energy 0% / Financials 40% / Real Estate 0%"),
    ).toBe("Technology sector (60%), Financials sector (40%)");
  });

  it("drops a -0% share too", () => {
    expect(protectsLabel("sector: Technology 100% / Utilities -0%")).toBe("Technology sector (100%)");
  });

  it("keeps the existing wording when every share is 0%", () => {
    expect(protectsLabel("sector: Energy 0% / Utilities 0%")).toBe("Energy sector (0%), Utilities sector (0%)");
  });

  it("leaves a sector part without a share alone", () => {
    expect(protectsLabel("sector: Technology")).toBe("Technology sector");
  });
});
