import { describe, it, expect } from "vitest";
import { couponBondModifiedDuration, estimateBondRateLeg, type RateLegInputs } from "@/lib/compute/bond-duration";
import { addDays } from "@/lib/calendar/date-utils";

/** Synthetic figures only. */
const TODAY = "2030-01-15";
const TEN_YEARS = addDays(TODAY, 3650);

function row(over: Partial<RateLegInputs>): RateLegInputs {
  return {
    security_type: "Bond",
    security_name: "ZZ Corp note",
    sector: null,
    fund_category: null,
    duration_years: null,
    maturity_date: TEN_YEARS,
    coupon_rate: null,
    bond_price: 100,
    ...over,
  };
}

describe("estimateBondRateLeg: where the coupon came from", () => {
  it("a stored coupon is the broker's and is reported so", () => {
    const res = estimateBondRateLeg(row({ coupon_rate: 4 }), 100, TODAY)!;
    expect(res.durationSource).toBe("coupon-yield");
    expect(res.couponSource).toBe("broker");
  });

  it("with none stored, the coupon is read from the name and reported so", () => {
    const res = estimateBondRateLeg(row({ security_name: "ZZ NOTE CPN 4.000% DUE 01/13/40" }), 100, TODAY)!;
    const derived = couponBondModifiedDuration({ couponRatePct: 4, cleanPrice: 100, maturityDate: TEN_YEARS, today: TODAY });
    if (!derived.ok) throw new Error("expected a duration");
    expect(res.unmodelledReason).toBeUndefined();
    expect(res.durationSource).toBe("coupon-yield-name");
    expect(res.couponSource).toBe("name");
    expect(res.durationYears).toBeCloseTo(derived.modifiedDuration, 12);
    expect(res.changePercent).toBeCloseTo(Math.exp(-derived.modifiedDuration * 0.01) - 1, 12);
  });

  it("the stored coupon wins over a different one in the name", () => {
    const res = estimateBondRateLeg(row({ coupon_rate: 2, security_name: "ZZ NOTE CPN 6.000% DUE 01/13/40" }), 100, TODAY)!;
    const derived = couponBondModifiedDuration({ couponRatePct: 2, cleanPrice: 100, maturityDate: TEN_YEARS, today: TODAY });
    if (!derived.ok) throw new Error("expected a duration");
    expect(res.couponSource).toBe("broker");
    expect(res.durationSource).toBe("coupon-yield");
    expect(res.durationYears).toBeCloseTo(derived.modifiedDuration, 12);
  });

  it("a name that does not parse cleanly leaves the bond not modelled", () => {
    for (const name of ["ZZ TREASURY NOTE 4.625 02/15/35 02/15/25", "ZZ STEP NOTE 4.000% TO 6.000%", "ZZ Corp note", null]) {
      const res = estimateBondRateLeg(row({ security_name: name }), 100, TODAY)!;
      expect(res.unmodelledReason, String(name)).toBe("no-coupon");
      expect(res.changePercent).toBe(0);
      expect(res.couponSource).toBeUndefined();
    }
  });

  it("a zero coupon read from the name is a zero-coupon instrument: years to maturity", () => {
    const res = estimateBondRateLeg(row({ security_name: "ZZ STRIP CPN 0.00000  MTD 2040-01-13" }), 100, TODAY)!;
    expect(res.durationSource).toBe("bill-maturity");
    expect(res.couponSource).toBe("name");
    expect(res.durationYears).toBeCloseTo(3650 / 365, 12);
  });

  it("a stored zero coupon reports the broker; a bill by name alone reports no coupon source", () => {
    expect(estimateBondRateLeg(row({ coupon_rate: 0 }), 100, TODAY)!.couponSource).toBe("broker");
    const bill = estimateBondRateLeg(row({ security_name: "ZZ TREASURY BILL DUE 01/13/40" }), 100, TODAY)!;
    expect(bill.durationSource).toBe("bill-maturity");
    expect(bill.couponSource).toBeUndefined();
  });

  it("a name coupon with no usable price is still not modelled, and says which coupon it had", () => {
    const res = estimateBondRateLeg(row({ security_name: "ZZ NOTE 4% (due 01/13/40)", bond_price: null }), 100, TODAY)!;
    expect(res.unmodelledReason).toBe("no-price");
    expect(res.couponSource).toBe("name");
  });

  it("a stored duration, a single remaining flow and a fund never report a coupon source", () => {
    expect(estimateBondRateLeg(row({ duration_years: 7, coupon_rate: 4 }), 100, TODAY)!.couponSource).toBeUndefined();
    expect(estimateBondRateLeg(row({ coupon_rate: 4, maturity_date: addDays(TODAY, 30) }), 100, TODAY)!.couponSource).toBeUndefined();
    expect(
      estimateBondRateLeg(row({ security_type: "ETF", sector: "Fixed Income", security_name: "ZZ BOND FUND 4%" }), 100, TODAY)!.couponSource,
    ).toBeUndefined();
  });

  it("a stored coupon that is not a usable number is not replaced by the name, and the reason says a coupon is on file", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const res = estimateBondRateLeg(row({ coupon_rate: bad, security_name: "ZZ NOTE CPN 4.000%" }), 100, TODAY)!;
      expect(res.unmodelledReason).toBe("unusable-coupon");
      expect(res.changePercent).toBe(0);
      expect(res.durationYears).toBeUndefined();
    }
    // With nothing stored and nothing in the name the reason is still "no-coupon".
    expect(estimateBondRateLeg(row({}), 100, TODAY)!.unmodelledReason).toBe("no-coupon");
  });

  it("a floater or a yield in the name is never used as a coupon", () => {
    for (const name of ["ZZ BANK FLTG RATE NT VAR 5.310% 01/13/40", "ZZ CORP NT YLD 5.1% DUE 2040", "ZZ CORP 6.5%/7.5% PIK TOGGLE 2040"]) {
      expect(estimateBondRateLeg(row({ security_name: name }), 100, TODAY)!.unmodelledReason, name).toBe("no-coupon");
    }
  });
});
