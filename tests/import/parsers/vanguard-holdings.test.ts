import { describe, it, expect } from "vitest";
import { parseVanguardHoldings } from "@/lib/import/parsers/vanguard-holdings";
import fs from "node:fs";
import path from "node:path";

const fixture = fs.readFileSync(
  path.join(__dirname, "../../fixtures/vanguard-holdings-sample.csv"),
  "utf-8"
);

describe("Vanguard holdings parser", () => {
  it("returns correct source type", () => {
    const result = parseVanguardHoldings(fixture, "vanguard_holdings.csv");
    expect(result.sourceType).toBe("vanguard-holdings");
  });

  it("extracts all holdings", () => {
    const result = parseVanguardHoldings(fixture, "vanguard_holdings.csv");
    expect(result.holdings).toHaveLength(4);
  });

  it("parses holding fields correctly", () => {
    const result = parseVanguardHoldings(fixture, "vanguard_holdings.csv");
    const vti = result.holdings.find((h) => h.symbol === "VTI");
    expect(vti).toBeTruthy();
    expect(vti!.quantity).toBe(50);
    expect(vti!.marketValue).toBe(13500);
    expect(vti!.accountName).toBe("Vanguard Taxable");
  });

  it("extracts prices from holdings", () => {
    const result = parseVanguardHoldings(fixture, "vanguard_holdings.csv");
    expect(result.prices.length).toBeGreaterThan(0);
    const vtiPrice = result.prices.find((p) => p.symbol === "VTI");
    expect(vtiPrice).toBeTruthy();
    expect(vtiPrice!.closePrice).toBe(270);
  });

  it("extracts securities", () => {
    const result = parseVanguardHoldings(fixture, "vanguard_holdings.csv");
    const symbols = result.securities.map((s) => s.symbol);
    expect(symbols).toContain("VMFXX");
    expect(symbols).toContain("VTSAX");
  });

  it("has no errors", () => {
    const result = parseVanguardHoldings(fixture, "vanguard_holdings.csv");
    expect(result.errors).toHaveLength(0);
  });
});
