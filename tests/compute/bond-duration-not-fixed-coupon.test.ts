import { describe, it, expect } from "vitest";
import { couponBondModifiedDuration, estimateBondRateLeg, type RateLegInputs } from "@/lib/compute/bond-duration";
import { isNotFixedCouponName } from "@/lib/bonds";
import { addDays } from "@/lib/calendar/date-utils";

/**
 * A note whose NAME says its coupon floats, steps or follows an index is never
 * given a duration from a coupon, stored or read. Synthetic figures only.
 */
const TODAY = "2030-01-15";
const FIFTEEN_YEARS = addDays(TODAY, 15 * 365);

function row(over: Partial<RateLegInputs>): RateLegInputs {
  return {
    security_type: "Bond",
    security_name: "ZZ Corp note",
    sector: null,
    fund_category: null,
    duration_years: null,
    maturity_date: FIFTEEN_YEARS,
    coupon_rate: null,
    bond_price: 100,
    ...over,
  };
}

const NOT_FIXED_NAMES = [
  "ZZ BANK CMS NOTE DUE 01/11/45",
  "ZZ BANK CMS10 STEEPENER NT DUE 01/11/45",
  "ZZ BANK CONSTANT MATURITY SWAP NT DUE 01/11/45",
  "ZZ BANK CPI LINKED NOTE DUE 01/11/45",
  "ZZ BANK RANGE ACCRUAL NT DUE 01/11/45",
  "ZZ BANK FXD/FLT NT DUE 01/11/45",
  "ZZ BANK FIXED TO FLOATING RATE NT DUE 01/11/45",
  "ZZ BANK FIX-TO-FLOAT NT DUE 01/11/45",
  "ZZ BANK FLTG RATE NT DUE 01/11/45",
  "ZZ CORP STEP-UP NT DUE 01/11/45",
  "ZZ CORP PIK TOGGLE NT DUE 01/11/45",
];

describe("estimateBondRateLeg: a floating or index-linked note is never given a figure", () => {
  it("a stored zero coupon does not turn it into a bill", () => {
    for (const name of NOT_FIXED_NAMES) {
      const res = estimateBondRateLeg(row({ security_name: name, coupon_rate: 0 }), 100, TODAY)!;
      expect(res.unmodelledReason, name).toBe("not-fixed-coupon");
      expect(res.changePercent, name).toBe(0);
      expect(res.durationYears, name).toBeUndefined();
      expect(res.durationSource, name).toBeUndefined();
      expect(res.couponSource, name).toBeUndefined();
    }
  });

  it("a stored positive coupon does not turn it into a plain fixed bond", () => {
    for (const name of NOT_FIXED_NAMES) {
      const res = estimateBondRateLeg(row({ security_name: name, coupon_rate: 8 }), 100, TODAY)!;
      expect(res.unmodelledReason, name).toBe("not-fixed-coupon");
      expect(res.changePercent, name).toBe(0);
      expect(res.durationYears, name).toBeUndefined();
    }
  });

  it("with no coupon stored the reason is the same, whatever the name's percent figure", () => {
    for (const name of NOT_FIXED_NAMES) {
      expect(estimateBondRateLeg(row({ security_name: name }), 100, TODAY)!.unmodelledReason, name).toBe("not-fixed-coupon");
      expect(estimateBondRateLeg(row({ security_name: `${name} 6.000%` }), 100, TODAY)!.unmodelledReason, name).toBe(
        "not-fixed-coupon",
      );
    }
  });

  it("is left out even with one payment left, and whatever the price", () => {
    const soon = addDays(TODAY, 30);
    const res = estimateBondRateLeg(row({ security_name: "ZZ BANK CMS NOTE", coupon_rate: 8, maturity_date: soon }), 100, TODAY)!;
    expect(res.unmodelledReason).toBe("not-fixed-coupon");
    expect(estimateBondRateLeg(row({ security_name: "ZZ BANK CMS NOTE", coupon_rate: 8, bond_price: null }), 100, TODAY)!.unmodelledReason).toBe(
      "not-fixed-coupon",
    );
  });

  it("the earlier rules still come first: matured, a stored duration, no maturity date", () => {
    const name = "ZZ BANK CMS NOTE";
    expect(estimateBondRateLeg(row({ security_name: name, maturity_date: addDays(TODAY, -1) }), 100, TODAY)!.unmodelledReason).toBe("matured");
    const stored = estimateBondRateLeg(row({ security_name: name, duration_years: 0.25, coupon_rate: 8 }), 100, TODAY)!;
    expect(stored.durationSource).toBe("stored");
    expect(stored.durationYears).toBe(0.25);
    expect(estimateBondRateLeg(row({ security_name: name, maturity_date: null }), 100, TODAY)!.unmodelledReason).toBe("no-maturity");
  });

  it("a look-alike name is still a plain bond: a stored zero is a bill, a stored coupon is a coupon bond", () => {
    const lookAlikes = [
      "ZZ STEEPLE CORP NT DUE 01/11/45",
      "ZZ RANGE CORP NT DUE 01/11/45",
      "ZZ ACCRUAL CORP NT DUE 01/11/45",
      "ZZ CONSTANT CORP NT DUE 01/11/45",
      "ZZ FXD RATE NT DUE 01/11/45",
      "ZZ FIXED RATE NT DUE 01/11/45",
      "ZZ CPIX LINKEDGE CMSA NT DUE 01/11/45",
    ];
    const derived = couponBondModifiedDuration({ couponRatePct: 8, cleanPrice: 100, maturityDate: FIFTEEN_YEARS, today: TODAY });
    if (!derived.ok) throw new Error("expected a duration");
    for (const name of lookAlikes) {
      const zero = estimateBondRateLeg(row({ security_name: name, coupon_rate: 0 }), 100, TODAY)!;
      expect(zero.durationSource, name).toBe("bill-maturity");
      expect(zero.couponSource, name).toBe("broker");
      expect(zero.durationYears, name).toBeCloseTo(15, 12);
      const fixed = estimateBondRateLeg(row({ security_name: name, coupon_rate: 8 }), 100, TODAY)!;
      expect(fixed.durationSource, name).toBe("coupon-yield");
      expect(fixed.durationYears, name).toBeCloseTo(derived.modifiedDuration, 12);
    }
  });

  it("a yield quoted in the name does not make a bond with a stored coupon floating", () => {
    // "YLD 5.1%" says the percent figure is a yield, not that the coupon floats.
    const res = estimateBondRateLeg(row({ security_name: "ZZ CORP NT YLD 5.1% DUE 2045", coupon_rate: 8 }), 100, TODAY)!;
    expect(res.durationSource).toBe("coupon-yield");
    expect(res.couponSource).toBe("broker");
    // With nothing stored the yield figure is still never read as a coupon.
    expect(estimateBondRateLeg(row({ security_name: "ZZ CORP NT YLD 5.1% DUE 2045" }), 100, TODAY)!.unmodelledReason).toBe("no-coupon");
  });

  it("a Treasury inflation-indexed note keeps its fixed real coupon, stored or read from the name", () => {
    for (const name of ["ZZ TREASURY INFL IX NOTE 0.125% DUE 01/11/45", "ZZ TREASURY INFLATION INDEXED NOTE 0.125% DUE 01/11/45"]) {
      expect(isNotFixedCouponName(name), name).toBe(false);
      expect(estimateBondRateLeg(row({ security_name: name }), 100, TODAY)!.durationSource, name).toBe("coupon-yield-name");
      expect(estimateBondRateLeg(row({ security_name: name, coupon_rate: 0.125 }), 100, TODAY)!.durationSource, name).toBe("coupon-yield");
    }
  });

  it("a fund is untouched by the name test", () => {
    const fund = estimateBondRateLeg(
      row({ security_type: "ETF", security_name: "ZZ FLOATING RATE BOND FUND", sector: "Fixed Income", fund_category: "Diversified Bond" }),
      100,
      TODAY,
    )!;
    expect(fund.durationSource).toBe("fund-default");
  });
});
