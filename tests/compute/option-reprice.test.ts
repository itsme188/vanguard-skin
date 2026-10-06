import { describe, it, expect } from "vitest";
import {
  repriceOptionUnderShock,
  summarizeUnmodelledOptions,
  MIN_SHOCKED_VOL,
} from "@/lib/compute/option-reprice";
import { putPrice, callPrice } from "@/lib/compute/options-greeks";
import type { OptionElasticityInputs } from "@/lib/compute/option-elasticity";

// All figures synthetic. Fixed clock so time-to-expiry is deterministic.
const TODAY = "2026-06-01";
const NOW = new Date("2026-06-01T15:00:00Z"); // 11:00 ET, market open
const EXPIRY = "2026-08-30"; // 90 days
const T = 90 / 365;
const R = 0.04;

function put(over: Partial<OptionElasticityInputs> = {}): OptionElasticityInputs {
  // Own price is the model price at sigma 0.40, so the solver recovers 0.40.
  return {
    option_type: "PUT",
    strike_price: 50,
    expiration_date: EXPIRY,
    own_price: putPrice(60, 50, T, R, 0.4),
    underlying_price: 60,
    underlying_iv: 0.3,
    ...over,
  };
}
function call(over: Partial<OptionElasticityInputs> = {}): OptionElasticityInputs {
  return { ...put(), option_type: "CALL", strike_price: 60, own_price: callPrice(60, 60, T, R, 0.4), ...over };
}
const shock = (underlyingMove: number, volChange = 0) => ({ underlyingMove, volChange, riskFreeRate: R, today: TODAY, now: NOW });

describe("repriceOptionUnderShock", () => {
  it("zero-shock identity: no move and no volatility change gives exactly zero", () => {
    const r = repriceOptionUnderShock(put(), shock(0));
    expect(r.modelled).toBe(true);
    if (!r.modelled) return;
    expect(r.ivSource).toBe("own-price");
    expect(r.sigma).toBeCloseTo(0.4, 3);
    expect(r.perShareChange).toBe(0);
    expect(r.changePercent).toBe(0);
  });

  it("the finding: a put's shocked value is never below exercise value at the shocked price", () => {
    for (const move of [-0.1, -0.25, -0.5, -0.8]) {
      const r = repriceOptionUnderShock(put(), shock(move));
      if (!r.modelled) throw new Error("expected modelled");
      const shockedUnderlying = 60 * (1 + move);
      expect(r.v1).toBeGreaterThanOrEqual(Math.max(50 - shockedUnderlying, 0) - 1e-9);
    }
    // -50%: underlying 30, exercise value 20. The old linear engine capped
    // the move at +800% of a small premium, far below this.
    const big = repriceOptionUnderShock(put(), shock(-0.5));
    if (!big.modelled) throw new Error("expected modelled");
    expect(big.v1).toBeGreaterThanOrEqual(20 - 1e-9);
    expect(big.changePercent).toBeGreaterThan(8);
  });

  it("sign: a put gains and a call loses on a down move, reversed on an up move", () => {
    const pd = repriceOptionUnderShock(put(), shock(-0.2));
    const cd = repriceOptionUnderShock(call(), shock(-0.2));
    const pu = repriceOptionUnderShock(put(), shock(0.2));
    const cu = repriceOptionUnderShock(call(), shock(0.2));
    if (!pd.modelled || !cd.modelled || !pu.modelled || !cu.modelled) throw new Error("expected modelled");
    expect(pd.perShareChange).toBeGreaterThan(0);
    expect(cd.perShareChange).toBeLessThan(0);
    expect(pu.perShareChange).toBeLessThan(0);
    expect(cu.perShareChange).toBeGreaterThan(0);
  });

  it("monotonic in volatility: raising the volatility change never lowers the shocked value", () => {
    let last = -Infinity;
    for (const vol of [-0.2, 0, 0.15, 0.4]) {
      const r = repriceOptionUnderShock(put(), shock(-0.15, vol));
      if (!r.modelled) throw new Error("expected modelled");
      expect(r.v1).toBeGreaterThanOrEqual(last - 1e-9);
      last = r.v1;
    }
  });

  it("volatility floor: a large negative change is floored, result finite", () => {
    const r = repriceOptionUnderShock(put(), shock(-0.1, -5));
    if (!r.modelled) throw new Error("expected modelled");
    expect(r.sigmaShocked).toBe(MIN_SHOCKED_VOL);
    expect(Number.isFinite(r.v1)).toBe(true);
  });

  it("underlying to zero: a put is worth its strike, a call is worth zero", () => {
    const p = repriceOptionUnderShock(put(), shock(-1.5)); // floored at -100%
    const c = repriceOptionUnderShock(call(), shock(-1));
    if (!p.modelled || !c.modelled) throw new Error("expected modelled");
    expect(p.v1).toBeCloseTo(50, 9);
    expect(c.v1).toBe(0);
    expect(c.changePercent).toBe(-1);
  });

  it("falls back to the broker figure when the own price is below exercise value", () => {
    // Deep in-the-money put quoted under exercise value: no volatility solves it.
    const stale = put({ strike_price: 80, own_price: 5, underlying_price: 60, underlying_iv: 0.35 });
    const r = repriceOptionUnderShock(stale, shock(-0.1));
    if (!r.modelled) throw new Error("expected modelled");
    expect(r.ivSource).toBe("broker-underlying");
    expect(r.sigma).toBe(0.35);
    // Change is model-to-model (v1 - v0), not v1 minus the market price.
    expect(r.perShareChange).toBeCloseTo(r.v1 - r.v0, 12);
    expect(r.changePercent).toBeGreaterThanOrEqual(-1);
  });

  it("a stale quote on the broker source: the change is floored at -100% of the quoted price", () => {
    const stale = put({ strike_price: 80, own_price: 5, underlying_price: 60, underlying_iv: 0.35 });
    const r = repriceOptionUnderShock(stale, shock(0.4));
    expect(r.modelled).toBe(true);
    if (!r.modelled) return;
    expect(r.ivSource).toBe("broker-underlying");
    expect(r.perShareChange / 5).toBeLessThan(-1);
    expect(r.changePercent).toBe(-1);
  });

  it("a quote just under exercise value is never accepted as own-price (American floor)", () => {
    // Exercise value is 20. The European bound K*exp(-rT) - S is about 19.2,
    // so 19.6 still "solves" under the European formula; it must be rejected.
    const r = repriceOptionUnderShock(put({ strike_price: 80, own_price: 19.6, underlying_iv: 0.35 }), shock(-0.1));
    if (!r.modelled) throw new Error("expected modelled");
    expect(r.ivSource).toBe("broker-underlying");
    expect(r.v0).toBeGreaterThanOrEqual(20 - 1e-9);
  });

  it("legacy expiry spelling reprices the same as ISO", () => {
    const iso = repriceOptionUnderShock(put(), shock(-0.2));
    const compact = repriceOptionUnderShock(put({ expiration_date: "20260830" }), shock(-0.2));
    expect(compact).toEqual(iso);
  });

  it("same-day expiry stays finite before the close and is expired after it", () => {
    const sameDay = put({ expiration_date: TODAY, own_price: 0.05 });
    const open = repriceOptionUnderShock(sameDay, shock(-0.2));
    expect(open.modelled).toBe(true);
    if (open.modelled) expect(Number.isFinite(open.v1)).toBe(true);
    const closed = repriceOptionUnderShock(sameDay, { ...shock(-0.2), now: new Date("2026-06-01T21:00:00Z") });
    expect(closed).toEqual({ modelled: false, reason: "expired" });
  });

  it("unmodelled reasons", () => {
    const s = shock(-0.2);
    expect(repriceOptionUnderShock(put({ option_type: null }), s)).toEqual({ modelled: false, reason: "no-option-terms" });
    expect(repriceOptionUnderShock(put({ strike_price: null }), s)).toEqual({ modelled: false, reason: "no-option-terms" });
    expect(repriceOptionUnderShock(put({ expiration_date: "garbage" }), s)).toEqual({ modelled: false, reason: "no-option-terms" });
    expect(repriceOptionUnderShock(put({ expiration_date: "2026-05-01" }), s)).toEqual({ modelled: false, reason: "expired" });
    expect(repriceOptionUnderShock(put({ own_price: null }), s)).toEqual({ modelled: false, reason: "no-option-price" });
    expect(repriceOptionUnderShock(put({ underlying_price: null }), s)).toEqual({ modelled: false, reason: "no-underlying-price" });
    expect(
      repriceOptionUnderShock(put({ strike_price: 80, own_price: 5, underlying_iv: null }), s),
    ).toEqual({ modelled: false, reason: "no-volatility" });
  });
});

describe("summarizeUnmodelledOptions", () => {
  it("counts unmodelled options and their share of option value; ignores non-options", () => {
    const out = summarizeUnmodelledOptions([
      { securityType: "Stock", currentValue: 10000 },
      { securityType: "Option", currentValue: 600 },
      { securityType: "Option", currentValue: -200, unmodelledReason: "no-underlying-price" },
      { securityType: "Option", currentValue: 0, unmodelledReason: "no-option-price" },
    ]);
    expect(out.count).toBe(2);
    expect(out.valueShare).toBeCloseTo(200 / 800, 12);
    expect(out.unpricedCount).toBe(1);
  });
  it("no options at all gives zero and zero", () => {
    expect(summarizeUnmodelledOptions([{ securityType: "Stock", currentValue: 1 }])).toEqual({ count: 0, valueShare: 0, unpricedCount: 0 });
  });
});
