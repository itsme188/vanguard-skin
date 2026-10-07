import { describe, it, expect } from "vitest";
import {
  FUND_DEFAULT_DURATION_YEARS,
  couponBondModifiedDuration,
  estimateBondRateLeg,
  isFixedIncomeFund,
  isTreasuryBillName,
  remainingCouponDates,
  rateLegForDuration,
  summarizeUnmodelledBonds,
  type RateLegInputs,
} from "@/lib/compute/bond-duration";
import { addDays } from "@/lib/calendar/date-utils";

/** Synthetic figures only: ZZ* names, round numbers. */
const TODAY = "2030-01-15";

function row(over: Partial<RateLegInputs>): RateLegInputs {
  return {
    security_type: "Bond",
    security_name: "ZZ Corp note",
    sector: null,
    fund_category: null,
    duration_years: null,
    maturity_date: null,
    coupon_rate: null,
    bond_price: 100,
    ...over,
  };
}

describe("rateLegForDuration", () => {
  it("is the convexity-aware exponential and never reaches -100%", () => {
    expect(rateLegForDuration(5, 200)).toBeCloseTo(Math.exp(-5 * 0.02) - 1, 12);
    expect(rateLegForDuration(30, 5000)).toBeGreaterThan(-1);
    expect(rateLegForDuration(5, -100)).toBeGreaterThan(0);
    expect(rateLegForDuration(0, 200)).toBe(0);
  });
});

describe("isTreasuryBillName", () => {
  it("recognises the statement spellings of a Treasury bill", () => {
    expect(isTreasuryBillName("T-Bill (due 03/14/30)")).toBe(true);
    expect(isTreasuryBillName("U S TREASURY BILL DUE 03/14/30 DTD 09/14/29")).toBe(true);
    expect(isTreasuryBillName("US Treasury Bills 0% 2030")).toBe(true);
  });
  it("does not fire on a note, a bond, or an issuer that merely contains the word", () => {
    expect(isTreasuryBillName("T-Note 4% (due 01/15/2035)")).toBe(false);
    expect(isTreasuryBillName("U S TREASURY BOND 4.75 05/15/55 05/15/25")).toBe(false);
    expect(isTreasuryBillName("ZZ Billing Holdings 3% 2032")).toBe(false);
    expect(isTreasuryBillName("Bill Holdings Inc conv note")).toBe(false);
    expect(isTreasuryBillName(null)).toBe(false);
  });
});

describe("isFixedIncomeFund", () => {
  it("is a non-bond, non-option holding whose sector normalizes to Fixed Income", () => {
    expect(isFixedIncomeFund({ security_type: "Mutual Fund", sector: "Fixed Income", fund_category: "ZZ Bond" })).toBe(true);
    expect(isFixedIncomeFund({ security_type: "ETF", sector: " fixed income ", fund_category: null })).toBe(true);
  });
  it("never claims a cash equivalent, an individual bond, an option or an equity fund", () => {
    expect(isFixedIncomeFund({ security_type: "Mutual Fund", sector: "Fixed Income", fund_category: "Cash Equivalent" })).toBe(false);
    expect(isFixedIncomeFund({ security_type: "money_market", sector: "Fixed Income", fund_category: null })).toBe(false);
    expect(isFixedIncomeFund({ security_type: "Bond", sector: "Fixed Income", fund_category: null })).toBe(false);
    expect(isFixedIncomeFund({ security_type: "Option", sector: "Fixed Income", fund_category: null })).toBe(false);
    expect(isFixedIncomeFund({ security_type: "ETF", sector: "Technology", fund_category: null })).toBe(false);
    expect(isFixedIncomeFund({ security_type: "ETF", sector: null, fund_category: null })).toBe(false);
  });
  it("applies to funds only: a Stock, CD or Preferred with a Fixed Income sector is not a bond fund", () => {
    for (const type of ["Stock", "stock", "CD", "Preferred", "Closed-End Fund", "Future"]) {
      expect(isFixedIncomeFund({ security_type: type, sector: "Fixed Income", fund_category: "US Aggregate Bond" }), type).toBe(false);
    }
    for (const type of ["ETF", "etf", "Mutual Fund", "mutual_fund", " mutual fund "]) {
      expect(isFixedIncomeFund({ security_type: type, sector: "Fixed Income", fund_category: null }), type).toBe(true);
    }
  });
  it("leaves out leveraged and inverse funds: an inverse Treasury fund gains on a hike", () => {
    expect(isFixedIncomeFund({ security_type: "ETF", sector: "Fixed Income", fund_category: "Leveraged/Inverse" })).toBe(false);
    expect(isFixedIncomeFund({ security_type: "ETF", sector: "Fixed Income", fund_category: " leveraged/inverse (Treasury) " })).toBe(false);
  });
  it("takes a fund whose normalized category is a bond category even with no sector", () => {
    expect(isFixedIncomeFund({ security_type: "Mutual Fund", sector: null, fund_category: "US Mortgage-Backed Securities" })).toBe(true);
    expect(isFixedIncomeFund({ security_type: "ETF", sector: null, fund_category: " us long-term treasury " })).toBe(true);
    expect(isFixedIncomeFund({ security_type: "ETF", sector: "Technology", fund_category: "TIPS" })).toBe(true);
    expect(isFixedIncomeFund({ security_type: "ETF", sector: null, fund_category: "US Large Cap Equity" })).toBe(false);
  });
});

describe("couponBondModifiedDuration", () => {
  it("a par bond on a coupon date matches the closed-form modified duration", () => {
    // 4% semiannual, exactly ten calendar years before a mid-January
    // maturity: 20 flows left (today's coupon is already paid), no accrued.
    const res = couponBondModifiedDuration({ couponRatePct: 4, cleanPrice: 100, maturityDate: "2040-01-15", today: TODAY });
    if (!res.ok) throw new Error("expected a duration");
    expect(res.remainingFlows).toBe(20);
    expect(res.yieldToMaturity).toBeCloseTo(0.04, 9);
    // Closed form for a par bond: (1 - (1 + y/2)^-n) / y, n = 20.
    const closedForm = (1 - Math.pow(1.02, -20)) / 0.04;
    expect(res.modifiedDuration).toBeCloseTo(closedForm, 6);
  });

  it("a discount bond has a higher yield and a duration below its maturity", () => {
    const maturity = addDays(TODAY, 3650);
    const res = couponBondModifiedDuration({ couponRatePct: 4, cleanPrice: 90, maturityDate: maturity, today: TODAY });
    if (!res.ok) throw new Error("expected a duration");
    expect(res.yieldToMaturity).toBeGreaterThan(0.04);
    expect(res.modifiedDuration).toBeGreaterThan(7);
    expect(res.modifiedDuration).toBeLessThan(10);
  });

  it("a longer bond has a longer duration", () => {
    const d = (days: number) => {
      const r = couponBondModifiedDuration({ couponRatePct: 4, cleanPrice: 100, maturityDate: addDays(TODAY, days), today: TODAY });
      if (!r.ok) throw new Error("expected a duration");
      return r.modifiedDuration;
    };
    expect(d(365 * 30)).toBeGreaterThan(d(365 * 10));
    expect(d(365 * 10)).toBeGreaterThan(d(365 * 2));
  });

  it("steps the schedule back by calendar months, so a leap-day maturity behaves", () => {
    // Four years to a 29 February maturity: coupons fall on 29 Aug and the
    // last day of February, eight of them, and a par bond still yields its coupon.
    expect(remainingCouponDates("2032-02-29", "2028-02-29")).toEqual([
      "2028-08-29", "2029-02-28", "2029-08-29", "2030-02-28", "2030-08-29", "2031-02-28", "2031-08-29", "2032-02-29",
    ]);
    const res = couponBondModifiedDuration({ couponRatePct: 4, cleanPrice: 100, maturityDate: "2032-02-29", today: "2028-02-29" });
    if (!res.ok) throw new Error("expected a duration");
    expect(res.remainingFlows).toBe(8);
    expect(res.yieldToMaturity).toBeCloseTo(0.04, 9);
    expect(res.modifiedDuration).toBeCloseTo((1 - Math.pow(1.02, -8)) / 0.04, 9);
  });

  it("the day before a coupon date still counts that coupon", () => {
    expect(remainingCouponDates("2040-01-15", "2030-01-14")).toHaveLength(21);
    expect(remainingCouponDates("2040-01-15", "2030-01-15")).toHaveLength(20);
    expect(remainingCouponDates("2040-01-15", "2030-01-16")).toHaveLength(20);
  });

  it("one flow left: the duration is the time to maturity, with no yield solve", () => {
    for (const [days, price] of [[7, 100.4], [7, 99.6], [30, 101.5], [30, 98.5]] as const) {
      const res = couponBondModifiedDuration({ couponRatePct: 4, cleanPrice: price, maturityDate: addDays(TODAY, days), today: TODAY });
      if (!res.ok) throw new Error(`expected a duration at ${days}d / ${price}`);
      expect(res.remainingFlows).toBe(1);
      expect(res.modifiedDuration).toBeCloseTo(days / 365, 12);
      expect(res.yieldToMaturity).toBeNull();
    }
  });

  it("refuses a price no yield in range can explain", () => {
    const res = couponBondModifiedDuration({ couponRatePct: 4, cleanPrice: 100000, maturityDate: addDays(TODAY, 3650), today: TODAY });
    expect(res).toEqual({ ok: false, reason: "no-yield" });
  });
});

describe("estimateBondRateLeg", () => {
  it("returns null for anything that is neither a bond nor a bond fund", () => {
    expect(estimateBondRateLeg(row({ security_type: "Stock", sector: "Technology" }), 200, TODAY)).toBeNull();
    expect(estimateBondRateLeg(row({ security_type: "Option", sector: "Fixed Income" }), 200, TODAY)).toBeNull();
    expect(estimateBondRateLeg(row({ security_type: "Stock", sector: "Fixed Income" }), 200, TODAY)).toBeNull();
    expect(
      estimateBondRateLeg(row({ security_type: "ETF", sector: "Fixed Income", fund_category: "Leveraged/Inverse" }), 200, TODAY),
    ).toBeNull();
    expect(
      estimateBondRateLeg(row({ security_type: "Mutual Fund", sector: "Fixed Income", fund_category: "Cash Equivalent" }), 200, TODAY),
    ).toBeNull();
  });

  it("a stored duration wins over everything else", () => {
    const res = estimateBondRateLeg(row({ duration_years: 7, maturity_date: addDays(TODAY, 60), security_name: "T-Bill" }), 100, TODAY)!;
    expect(res.durationSource).toBe("stored");
    expect(res.durationYears).toBe(7);
    expect(res.changePercent).toBeCloseTo(Math.exp(-7 * 0.01) - 1, 12);
  });

  it("a two-month bill loses about its years to maturity times the move, not a 5-year figure", () => {
    const res = estimateBondRateLeg(
      row({ security_name: "T-Bill (due 03/16/30)", maturity_date: addDays(TODAY, 60) }),
      200,
      TODAY,
    )!;
    expect(res.durationSource).toBe("bill-maturity");
    expect(res.durationYears).toBeCloseTo(60 / 365, 12);
    expect(res.changePercent).toBeCloseTo(Math.exp(-(60 / 365) * 0.02) - 1, 12);
    expect(res.changePercent).toBeGreaterThan(-0.004); // about -0.33%
    expect(res.changePercent).toBeLessThan(-0.003);
    // The old 5-year default gave about -9.5%.
    expect(Math.abs(res.changePercent)).toBeLessThan(Math.abs(Math.exp(-5 * 0.02) - 1) / 20);
  });

  it("a stored zero coupon is a zero-coupon instrument whatever its name", () => {
    const res = estimateBondRateLeg(row({ coupon_rate: 0, maturity_date: addDays(TODAY, 730) }), 100, TODAY)!;
    expect(res.durationSource).toBe("bill-maturity");
    expect(res.durationYears).toBeCloseTo(2, 12);
  });

  it("a coupon bond with coupon, maturity and price uses the derived modified duration", () => {
    const maturity = addDays(TODAY, 3650);
    const res = estimateBondRateLeg(row({ coupon_rate: 4, maturity_date: maturity, bond_price: 100 }), 100, TODAY)!;
    const derived = couponBondModifiedDuration({ couponRatePct: 4, cleanPrice: 100, maturityDate: maturity, today: TODAY });
    if (!derived.ok) throw new Error("expected a duration");
    expect(res.durationSource).toBe("coupon-yield");
    expect(res.durationYears).toBeCloseTo(derived.modifiedDuration, 12);
    expect(res.changePercent).toBeCloseTo(Math.exp(-derived.modifiedDuration * 0.01) - 1, 12);
    expect(res.unmodelledReason).toBeUndefined();
  });

  it("a bond with no maturity date contributes zero and says why", () => {
    const res = estimateBondRateLeg(row({ coupon_rate: 4 }), 200, TODAY)!;
    expect(res.changePercent).toBe(0);
    expect(res.unmodelledReason).toBe("no-maturity");
    expect(res.durationYears).toBeUndefined();
  });

  it("a coupon bond with no stored coupon is unmodelled: no coupon is assumed", () => {
    const res = estimateBondRateLeg(row({ maturity_date: addDays(TODAY, 3650) }), 200, TODAY)!;
    expect(res.changePercent).toBe(0);
    expect(res.unmodelledReason).toBe("no-coupon");
  });

  it("a coupon bond with no usable price is unmodelled: no yield is assumed", () => {
    const res = estimateBondRateLeg(row({ coupon_rate: 4, maturity_date: addDays(TODAY, 3650), bond_price: null }), 200, TODAY)!;
    expect(res.unmodelledReason).toBe("no-price");
    expect(res.changePercent).toBe(0);
  });

  it("a row named like a bill that carries a positive stored coupon is a coupon bond", () => {
    const res = estimateBondRateLeg(
      row({ security_name: "U S TREASURY BILL (mislabelled)", coupon_rate: 4, maturity_date: "2040-01-15", bond_price: 100 }),
      100,
      TODAY,
    )!;
    expect(res.durationSource).toBe("coupon-yield");
    expect(res.durationYears!).toBeGreaterThan(7.5);
    // ...and the same name with no coupon, or a zero coupon, is a bill.
    for (const coupon of [null, 0]) {
      const bill = estimateBondRateLeg(row({ security_name: "U S TREASURY BILL", coupon_rate: coupon, maturity_date: "2040-01-15" }), 100, TODAY)!;
      expect(bill.durationSource).toBe("bill-maturity");
    }
  });

  it("a bond within one coupon period of maturity uses its time to maturity, whatever the price noise or coupon", () => {
    for (const [days, price] of [[7, 100.4], [30, 98.5]] as const) {
      const res = estimateBondRateLeg(row({ coupon_rate: 4, maturity_date: addDays(TODAY, days), bond_price: price }), 200, TODAY)!;
      expect(res.unmodelledReason).toBeUndefined();
      expect(res.durationSource).toBe("single-flow");
      expect(res.durationYears).toBeCloseTo(days / 365, 12);
      expect(res.changePercent).toBeCloseTo(Math.exp(-(days / 365) * 0.02) - 1, 12);
    }
    // One flow left needs neither the coupon nor the price.
    const bare = estimateBondRateLeg(row({ maturity_date: addDays(TODAY, 30), bond_price: null }), 200, TODAY)!;
    expect(bare.durationSource).toBe("single-flow");
    // Seven months out there are two flows, so the coupon is needed again.
    expect(estimateBondRateLeg(row({ maturity_date: addDays(TODAY, 215) }), 200, TODAY)!.unmodelledReason).toBe("no-coupon");
  });

  it("a bond past its maturity date is matured even when a duration is stored", () => {
    const res = estimateBondRateLeg(row({ duration_years: 7, maturity_date: addDays(TODAY, -3) }), 200, TODAY)!;
    expect(res.unmodelledReason).toBe("matured");
    expect(res.changePercent).toBe(0);
    expect(res.durationSource).toBeUndefined();
  });

  it("a bond past its maturity date is unmodelled, and one maturing today has no rate risk", () => {
    expect(estimateBondRateLeg(row({ coupon_rate: 0, maturity_date: addDays(TODAY, -3) }), 200, TODAY)!.unmodelledReason).toBe("matured");
    const today = estimateBondRateLeg(row({ coupon_rate: 0, maturity_date: TODAY }), 200, TODAY)!;
    expect(today.unmodelledReason).toBeUndefined();
    expect(today.changePercent).toBe(0);
  });

  it("an unreadable maturity date is treated as missing", () => {
    expect(estimateBondRateLeg(row({ coupon_rate: 0, maturity_date: "soon" }), 200, TODAY)!.unmodelledReason).toBe("no-maturity");
  });

  it("a bond fund uses its stored duration, else the 5-year default; an individual bond never does", () => {
    const fund = { security_type: "Mutual Fund", sector: "Fixed Income", fund_category: "ZZ Bond", security_name: "ZZ Bond Fund" };
    const stored = estimateBondRateLeg(row({ ...fund, duration_years: 2 }), 200, TODAY)!;
    expect(stored.durationSource).toBe("fund-stored");
    expect(stored.changePercent).toBeCloseTo(Math.exp(-2 * 0.02) - 1, 12);

    const defaulted = estimateBondRateLeg(row(fund), 200, TODAY)!;
    expect(FUND_DEFAULT_DURATION_YEARS).toBe(5);
    expect(defaulted.durationSource).toBe("fund-default");
    expect(defaulted.durationYears).toBe(5);
    expect(defaulted.changePercent).toBeCloseTo(Math.exp(-5 * 0.02) - 1, 12);
    expect(defaulted.unmodelledReason).toBeUndefined();

    const bond = estimateBondRateLeg(row({}), 200, TODAY)!;
    expect(bond.durationSource).toBeUndefined();
    expect(bond.changePercent).toBe(0);
  });
});

describe("summarizeUnmodelledBonds", () => {
  it("counts left-out bonds and their share of individual-bond value", () => {
    const summary = summarizeUnmodelledBonds([
      { securityType: "Bond", currentValue: 3000 },
      { securityType: "bond", currentValue: 1000, bondUnmodelledReason: "no-maturity" },
      { securityType: "Mutual Fund", currentValue: 9000 },
      { securityType: "Stock", currentValue: 50000 },
    ]);
    expect(summary).toEqual({ count: 1, valueShare: 0.25 });
  });
  it("is zero when nothing is left out", () => {
    expect(summarizeUnmodelledBonds([{ securityType: "Bond", currentValue: 10 }])).toEqual({ count: 0, valueShare: 0 });
    expect(summarizeUnmodelledBonds([])).toEqual({ count: 0, valueShare: 0 });
  });
});
