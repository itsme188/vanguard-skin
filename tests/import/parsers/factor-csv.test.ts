import { describe, it, expect } from "vitest";
import { parseFactorCsv } from "@/lib/import/parsers/factor-csv";
import { detectSourceType } from "@/lib/import/detect";

// ─── Parser tests ──────────────────────────────────────────────────

describe("parseFactorCsv", () => {
  const HEADER =
    "symbol,sector,industry,interest_rate_sensitive,growth_vs_value,cyclical,international_exposure,geopolitical_onshoring,tariff_exposure,ai_exposure,crypto_adjacent,regulatory_risk";

  it("parses a well-formed factor CSV", () => {
    const csv = [
      HEADER,
      "AAPL,Technology,Consumer Electronics,Low,Growth,Moderate,Low,Low,Moderate,High,No,Moderate",
      "MSFT,Technology,Software,Low,Growth,Moderate,Moderate,Low,Low,Very High,No,Moderate",
    ].join("\n");

    const result = parseFactorCsv(csv, "factors.csv");

    expect(result.sourceType).toBe("factor-csv");
    expect(result.factors).toHaveLength(2);
    expect(result.transactions).toHaveLength(0);
    expect(result.securities).toHaveLength(0);
    expect(result.holdings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);

    const aapl = result.factors![0];
    expect(aapl.symbol).toBe("AAPL");
    expect(aapl.sector).toBe("Technology");
    expect(aapl.industry).toBe("Consumer Electronics");
    expect(aapl.interest_rate_sensitive).toBe("Low");
    expect(aapl.growth_vs_value).toBe("Growth");
    expect(aapl.ai_exposure).toBe("High");
    expect(aapl.crypto_adjacent).toBe("No");

    const msft = result.factors![1];
    expect(msft.symbol).toBe("MSFT");
    expect(msft.ai_exposure).toBe("Very High");
  });

  it("normalizes 'Unknown', '0', and empty values to undefined", () => {
    const csv = [
      HEADER,
      "GOOG,Technology,,Low,Growth,Moderate,Unknown,Low,0,,No,",
    ].join("\n");

    const result = parseFactorCsv(csv, "factors.csv");
    expect(result.factors).toHaveLength(1);

    const goog = result.factors![0];
    expect(goog.industry).toBeUndefined();
    expect(goog.international_exposure).toBeUndefined(); // "Unknown"
    expect(goog.tariff_exposure).toBeUndefined(); // "0"
    expect(goog.ai_exposure).toBeUndefined(); // empty
    expect(goog.regulatory_risk).toBeUndefined(); // empty
    // Non-null values preserved
    expect(goog.interest_rate_sensitive).toBe("Low");
    expect(goog.growth_vs_value).toBe("Growth");
  });

  it("skips rows with no symbol", () => {
    const csv = [HEADER, ",Technology,,Low,,,,,,,No,"].join("\n");

    const result = parseFactorCsv(csv, "factors.csv");
    expect(result.factors).toHaveLength(0);
  });

  it("skips rows with no factor data, no sector, no industry", () => {
    const csv = [HEADER, "EMPTY,,,,,,,,,,,"].join("\n");

    const result = parseFactorCsv(csv, "factors.csv");
    expect(result.factors).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("EMPTY");
  });

  it("preserves rows with only sector/industry (no factor columns)", () => {
    const csv = [HEADER, "XYZ,Financials,Banking,,,,,,,,,"].join("\n");

    const result = parseFactorCsv(csv, "factors.csv");
    expect(result.factors).toHaveLength(1);
    expect(result.factors![0].sector).toBe("Financials");
    expect(result.factors![0].industry).toBe("Banking");
  });

  it("trims whitespace from symbol and values", () => {
    const csv = [
      HEADER,
      " TSLA , Technology , Auto ,  High , Growth , High , Low , Moderate , Very High , High , No , Moderate ",
    ].join("\n");

    const result = parseFactorCsv(csv, "factors.csv");
    expect(result.factors).toHaveLength(1);
    expect(result.factors![0].symbol).toBe("TSLA");
    expect(result.factors![0].sector).toBe("Technology");
    expect(result.factors![0].tariff_exposure).toBe("Very High");
  });

  it("handles empty CSV", () => {
    const result = parseFactorCsv(HEADER + "\n", "empty.csv");
    expect(result.factors).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ─── Detection tests ───────────────────────────────────────────────

describe("detectSourceType — factor CSV", () => {
  it("detects factor CSV by interest_rate_sensitive header", () => {
    const csv =
      "symbol,sector,industry,interest_rate_sensitive,growth_vs_value\nAAPL,Tech,,Low,Growth";
    expect(detectSourceType(csv, "mapping.csv")).toBe("factor-csv");
  });

  it("detects factor CSV by tariff_exposure header", () => {
    const csv =
      "symbol,name,tariff_exposure,ai_exposure\nAAPL,Apple,Moderate,High";
    expect(detectSourceType(csv, "factors.csv")).toBe("factor-csv");
  });

  it("detects factor CSV by ai_exposure header", () => {
    const csv = "symbol,ai_exposure\nMSFT,Very High";
    expect(detectSourceType(csv, "ai.csv")).toBe("factor-csv");
  });

  it("does not detect factor CSV from unrelated CSV", () => {
    const csv = "symbol,name,type,price,quantity,value\nVMFXX,VMF,Fund,1,100,100";
    expect(detectSourceType(csv, "holdings.csv")).not.toBe("factor-csv");
  });
});
