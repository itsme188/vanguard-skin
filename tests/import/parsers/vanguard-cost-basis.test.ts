import { describe, it, expect } from "vitest";
import { parseVanguardCostBasis } from "@/lib/import/parsers/vanguard-cost-basis";
import fs from "node:fs";
import path from "node:path";

const fixture = fs.readFileSync(
  path.join(__dirname, "../../fixtures/vanguard-cost-basis-sample.csv"),
  "utf-8"
);

describe("Vanguard cost basis parser", () => {
  it("returns correct source type", () => {
    const result = parseVanguardCostBasis(fixture, "vanguard_cost_basis.csv");
    expect(result.sourceType).toBe("vanguard-cost-basis");
  });

  it("extracts all holdings", () => {
    const result = parseVanguardCostBasis(fixture, "vanguard_cost_basis.csv");
    expect(result.holdings).toHaveLength(4);
  });

  it("maps account names correctly", () => {
    const result = parseVanguardCostBasis(fixture, "vanguard_cost_basis.csv");
    const brokerage = result.holdings.filter((h) => h.accountName === "Vanguard Taxable");
    const roth = result.holdings.filter((h) => h.accountName === "Vanguard Roth IRA");
    expect(brokerage).toHaveLength(3);
    expect(roth).toHaveLength(1);
  });

  it("parses holding fields correctly", () => {
    const result = parseVanguardCostBasis(fixture, "vanguard_cost_basis.csv");
    const vtsax = result.holdings.find(
      (h) => h.symbol === "VTSAX" && h.accountName === "Vanguard Taxable"
    );
    expect(vtsax).toBeTruthy();
    expect(vtsax!.quantity).toBe(500);
    expect(vtsax!.costBasis).toBe(25000);
    expect(vtsax!.marketValue).toBe(30000);
  });

  it("extracts unique securities", () => {
    const result = parseVanguardCostBasis(fixture, "vanguard_cost_basis.csv");
    // VTSAX appears twice (brokerage + roth) but should dedupe
    const symbols = result.securities.map((s) => s.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
    expect(symbols).toContain("VTSAX");
    expect(symbols).toContain("VTI");
  });

  it("has no errors", () => {
    const result = parseVanguardCostBasis(fixture, "vanguard_cost_basis.csv");
    expect(result.errors).toHaveLength(0);
  });
});
