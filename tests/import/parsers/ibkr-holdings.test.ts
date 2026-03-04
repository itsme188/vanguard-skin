import { describe, it, expect } from "vitest";
import { parseIbkrHoldings } from "@/lib/import/parsers/ibkr-holdings";
import fs from "node:fs";
import path from "node:path";

const fixture = fs.readFileSync(
  path.join(__dirname, "../../fixtures/ibkr-holdings-sample.csv"),
  "utf-8"
);

describe("IBKR holdings parser", () => {
  it("returns correct source type", () => {
    const result = parseIbkrHoldings(fixture, "holdings_current.csv");
    expect(result.sourceType).toBe("ibkr-holdings");
  });

  it("extracts all holdings", () => {
    const result = parseIbkrHoldings(fixture, "holdings_current.csv");
    expect(result.holdings).toHaveLength(3);
  });

  it("parses holding fields correctly", () => {
    const result = parseIbkrHoldings(fixture, "holdings_current.csv");
    const aapl = result.holdings.find((h) => h.symbol === "AAPL");
    expect(aapl).toBeTruthy();
    expect(aapl!.quantity).toBe(100);
    expect(aapl!.costBasis).toBe(19000);
    expect(aapl!.marketValue).toBe(19550);
    expect(aapl!.accountName).toBe("IBKR");
  });

  it("extracts securities", () => {
    const result = parseIbkrHoldings(fixture, "holdings_current.csv");
    expect(result.securities).toHaveLength(3);
    const spy = result.securities.find((s) => s.symbol === "SPY");
    expect(spy).toBeTruthy();
    expect(spy!.name).toBe("SPDR S&P 500 ETF TRUST");
    expect(spy!.securityType).toBe("ETF");
  });

  it("has no errors", () => {
    const result = parseIbkrHoldings(fixture, "holdings_current.csv");
    expect(result.errors).toHaveLength(0);
  });
});
