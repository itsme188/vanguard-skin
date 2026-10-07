import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { anchorIndex } from "../helpers/source-anchor";

const src = readFileSync("app/dashboard/components/SignificantMovesCard.tsx", "utf8");

describe("SignificantMovesCard empty states and labels", () => {
  it("checks the trading-day pair before saying nothing moved", () => {
    expect(src).toMatch(/import\s*\{[^}]*computeAnomalies[^}]*resolveTradingDayPair[^}]*\}/);
    const pairUnavailable = anchorIndex(src, "Could not evaluate significant moves");
    const nothingMoved = anchorIndex(src, "No Vanguard holdings moved significantly");
    expect(pairUnavailable).toBeLessThan(nothingMoved);
  });

  it("does not describe the no-movers state as today-only", () => {
    const nothingMoved = src.slice(
      anchorIndex(src, "No Vanguard holdings moved significantly"),
      anchorIndex(src, "</p>", anchorIndex(src, "No Vanguard holdings moved significantly")),
    );
    expect(nothingMoved).not.toContain("today");
    expect(nothingMoved).toMatch(/on \{pair\.latest\}/);
  });

  it("gives truncated company names a title", () => {
    expect(src).toMatch(/title=\{f\.companyName\}/);
  });

  it("renders a privacy-aware coverage line for the evaluated universe", () => {
    expect(src).toMatch(/function CoverageLine/);
    expect(src).toMatch(/Evaluated <Count value=\{evaluated\} \/> of <Count value=\{total\} \/> holdings/);
    expect(src).toMatch(/latestHoldingsPredicate\(\{ includeShorts: false \}\)/);
  });
});
