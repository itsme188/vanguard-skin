import { describe, it, expect } from "vitest";
import { extractCouponRate } from "@/lib/bonds";

/** Synthetic names only, in the shapes the maturity parser's tests already cover. */
describe("extractCouponRate: a coupon is read only from a percent sign or an explicit CPN token", () => {
  it("reads a percent figure: 'ZZ Note 4.375% (due 05/15/34)'", () => {
    expect(extractCouponRate("ZZ Note 4.375% (due 05/15/34)")).toBe(4.375);
    expect(extractCouponRate("ZZ Bond 3.5% (due 02/15/2053)")).toBe(3.5);
  });

  it("reads a CPN token with a percent sign: 'ZZ TREASURY NOTE CPN 4.125% DUE 11/15/32 DTD 11/15/22 FC 05/15/23'", () => {
    expect(extractCouponRate("ZZ TREASURY NOTE CPN 4.125% DUE 11/15/32 DTD 11/15/22 FC 05/15/23")).toBe(4.125);
    expect(extractCouponRate("ZZ TREASURY BOND CPN 3.000% DUE 02/15/48 DTD 02/15/18 FC 08/15/18 00000ZZZ -")).toBe(3);
  });

  it("reads a CPN token with no percent sign: 'ZZ TREASURY NOTE CPN 2.50000  MTD 2034-08-20 DTD 2024-08-20'", () => {
    expect(extractCouponRate("ZZ TREASURY NOTE CPN 2.50000  MTD 2034-08-20 DTD 2024-08-20")).toBe(2.5);
    expect(extractCouponRate("zz treasury note cpn 2.5 mtd 2034-08-20")).toBe(2.5);
  });

  it("zero is a valid coupon", () => {
    expect(extractCouponRate("ZZ TREASURY BILL CPN 0.00000  MTD 2030-08-20 DTD 2030-04-23")).toBe(0);
    expect(extractCouponRate("ZZ Strip 0% (due 05/15/40)")).toBe(0);
  });

  it("a name with only a maturity date gives nothing", () => {
    expect(extractCouponRate("ZZ TREASURY BILL DUE 04/14/30 DTD 12/16/29")).toBeNull();
    expect(extractCouponRate("ZZ-Bill (due 10/23/30)")).toBeNull();
    expect(extractCouponRate("ZZ NOTE MTD 2034-08-20 DTD 2024-08-20")).toBeNull();
  });

  it("a bare number is never a coupon, even in the two-date treasury shape", () => {
    expect(extractCouponRate("ZZ TREASURY NOTE 4.625 02/15/35 02/15/25")).toBeNull();
    expect(extractCouponRate("ZZ TREASURY BOND 3 02/15/48 02/15/18")).toBeNull();
  });

  it("a price-like or year-like number does not match", () => {
    expect(extractCouponRate("ZZ CORP NOTE 98.50 DUE 01/15/30")).toBeNull();
    expect(extractCouponRate("ZZ CORP NOTE @ 101.25 DUE 01/15/30")).toBeNull();
    expect(extractCouponRate("ZZ CORP NOTE $100.00 DUE 01/15/30")).toBeNull();
    expect(extractCouponRate("ZZ CORP NOTE 2030")).toBeNull();
    expect(extractCouponRate("ZZ CORP NOTE 100% GUARANTEED DUE 01/15/30")).toBeNull();
  });

  it("two different percentages give nothing; the same one twice is fine", () => {
    expect(extractCouponRate("ZZ STEP NOTE 4.000% TO 6.000% DUE 01/15/30")).toBeNull();
    expect(extractCouponRate("ZZ NOTE CPN 4.000% DUE 01/15/30 WAS 5%")).toBeNull();
    expect(extractCouponRate("ZZ NOTE CPN 4.000% DUE 01/15/30 ZZ NOTE 4%")).toBe(4);
  });

  it("an option-like name gives nothing", () => {
    expect(extractCouponRate("ZZA 300618 C 175.00")).toBeNull();
    expect(extractCouponRate("ZZA    JUN2030 100 P [ZZA   300618P00100000 100]")).toBeNull();
    expect(extractCouponRate("ZZA   300618C00175000")).toBeNull();
  });

  it("a yield, a floating rate, a spread and a pay-in-kind toggle are not fixed coupons", () => {
    expect(extractCouponRate("ZZ CORP NT YLD 5.1% DUE 2030")).toBeNull();
    expect(extractCouponRate("ZZ BANK FLTG RATE NT VAR 5.310% 01/15/29")).toBeNull();
    expect(extractCouponRate("ZZ CORP SOFR + 0.25% 2030")).toBeNull();
    expect(extractCouponRate("ZZ CORP 6.5%/7.5% PIK TOGGLE 2030")).toBeNull();
    // Each blocking word on its own, any case, whole words only.
    for (const word of ["YLD", "yield", "FLTG", "FLOAT", "Floater", "FLOATING", "FRN", "VAR", "VARIABLE", "STEP", "SOFR", "LIBOR", "PIK", "TOGGLE"]) {
      expect(extractCouponRate(`ZZ CORP ${word} 5.25% 2031`), word).toBeNull();
    }
    expect(extractCouponRate("ZZ CORP STEP-UP 5.25% 2031")).toBeNull();
    // A longer word that merely contains one is not blocked.
    expect(extractCouponRate("ZZ VARCO STEPSTONE 5.25% 2031")).toBe(5.25);
  });

  it("the slash no longer hides a second percent figure", () => {
    expect(extractCouponRate("ZZ CORP 6.5%/7.5% 2030")).toBeNull();
    expect(extractCouponRate("ZZ CORP 6.5% / 6.5% 2030")).toBe(6.5);
  });

  it("a fraction coupon, a price in percent and a call price leave nothing to choose from", () => {
    expect(extractCouponRate("ZZ CORP 4 3/8% 2030")).toBeNull();
    expect(extractCouponRate("ZZ NOTE CPN 4.125 DUE 01/15/30 PRICE 98.5%")).toBeNull();
    // Two different percent figures: nothing in the name says which is the
    // coupon, so neither is taken, even though 100% is plainly a call price.
    expect(extractCouponRate("ZZ CORP 4.375 % DUE 01/15/30 CALLABLE 100%")).toBeNull();
    expect(extractCouponRate("ZZ CORP 4.375 % DUE 01/15/30")).toBe(4.375);
  });

  it("the plain shapes still read", () => {
    expect(extractCouponRate("ZZ TREASURY NOTE 4.250% Due 11/15/34")).toBe(4.25);
    expect(extractCouponRate("ZZ TREASURY BILL CPN 0.00000  MTD 2030-08-20")).toBe(0);
    expect(extractCouponRate("ZZ CORP 5.25% 2031 SR NT")).toBe(5.25);
    expect(extractCouponRate("ZZ TREASURY INFL IX NOTE 0.125% DUE 04/15/32")).toBe(0.125);
  });

  it("an empty or missing name gives nothing", () => {
    expect(extractCouponRate("")).toBeNull();
    expect(extractCouponRate("   ")).toBeNull();
    expect(extractCouponRate(null)).toBeNull();
    expect(extractCouponRate(undefined)).toBeNull();
  });

  it("a figure outside 0 to 25, a spread, or a malformed token gives nothing", () => {
    expect(extractCouponRate("ZZ NOTE CPN 40.000% DUE 01/15/30")).toBeNull();
    expect(extractCouponRate("ZZ FLOATER SOFR+0.25% DUE 01/15/30")).toBeNull();
    expect(extractCouponRate("ZZ NOTE -4% DUE 01/15/30")).toBeNull();
    expect(extractCouponRate("ZZ NOTE CPN 4.1.25 DUE 01/15/30")).toBeNull();
    expect(extractCouponRate("ZZ NOTE CPN DUE 01/15/30")).toBeNull();
  });
});
