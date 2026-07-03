import { describe, it, expect } from "vitest";
import { mapPosition, deriveUsdPerUnit, extractLedgerFxRates } from "@/lib/ibkr/map-positions";

describe("IBKR position currency", () => {
  it("carries currency through mapPosition (default USD)", () => {
    expect(mapPosition({ assetClass: "STK", contractDesc: "AAPL", position: 10, mktPrice: 150 }).currency).toBe("USD");
    expect(mapPosition({ assetClass: "STK", contractDesc: "402340", currency: "KRW", position: 10, mktPrice: 1_731_000, mktValue: 12705 }).currency).toBe("KRW");
  });

  it("derives USD-per-unit from mktValue / (mktPrice*qty)", () => {
    expect(deriveUsdPerUnit(12705, 1_731_000, 10, 1)).toBeCloseTo(0.000734, 6);
    expect(deriveUsdPerUnit(null as unknown as number, 1_731_000, 10)).toBeNull();
    expect(deriveUsdPerUnit(12705, 0, 10)).toBeNull();
  });
});

describe("extractLedgerFxRates", () => {
  // Shape from a live 2026-07-03 probe of /portfolio/{acct}/ledger: a
  // currency→{...} map where each non-base entry carries `exchangerate`
  // (USD per unit of that currency).
  const liveShapedLedger = {
    KRW: { currency: "KRW", exchangerate: 0.0006531, cashbalance: -16_329_792 },
    EUR: { currency: "EUR", exchangerate: 1.09, cashbalance: 12.5 },
    USD: { currency: "USD", exchangerate: 1, cashbalance: 90_000 },
    BASE: { currency: "BASE", exchangerate: 1, netliquidationvalue: 470_055.1 },
  };

  it("extracts USD-per-unit for each non-USD, non-BASE currency", () => {
    expect(extractLedgerFxRates(liveShapedLedger)).toEqual({
      KRW: 0.0006531,
      EUR: 1.09,
    });
  });

  it("skips entries with missing, non-finite, or non-positive exchangerate", () => {
    expect(
      extractLedgerFxRates({
        KRW: { currency: "KRW" }, // missing
        JPY: { currency: "JPY", exchangerate: 0 }, // non-positive
        GBP: { currency: "GBP", exchangerate: Number.NaN }, // non-finite
        CAD: { currency: "CAD", exchangerate: "0.73" }, // wrong type
      }),
    ).toEqual({});
  });

  it("returns empty map for empty/undefined ledger", () => {
    expect(extractLedgerFxRates({})).toEqual({});
    expect(extractLedgerFxRates(undefined)).toEqual({});
  });
});
