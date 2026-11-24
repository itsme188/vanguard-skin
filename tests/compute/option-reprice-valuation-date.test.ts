import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repriceOptionUnderShock, type OptionRepriceShock } from "@/lib/compute/option-reprice";
import { putPrice, callPrice, yearsToExpiry } from "@/lib/compute/options-greeks";
import type { OptionElasticityInputs } from "@/lib/compute/option-elasticity";

// All figures synthetic. Fixed clock so time-to-expiry is deterministic.
const TODAY = "2026-06-01";
const NOW = new Date("2026-06-01T15:00:00Z"); // 11:00 ET, market open
const EXPIRY = "2026-08-30"; // 90 days
const T = 90 / 365;
const R = 0.04;

interface PinCase {
  name: string;
  input: OptionElasticityInputs;
  shock: Omit<OptionRepriceShock, "now"> & { now: string };
  result: unknown;
}
const pin: PinCase[] = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "option-reprice-legacy-pin.json"), "utf8"),
);

function put(over: Partial<OptionElasticityInputs> = {}): OptionElasticityInputs {
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
const shock = (underlyingMove: number, extra: Partial<OptionRepriceShock> = {}): OptionRepriceShock => ({
  underlyingMove,
  volChange: 0,
  riskFreeRate: R,
  today: TODAY,
  now: NOW,
  ...extra,
});

function modelled(r: ReturnType<typeof repriceOptionUnderShock>) {
  if (!r.modelled) throw new Error(`expected modelled, got ${r.reason}`);
  return r;
}

describe("repriceOptionUnderShock: valuation date and unpriced options", () => {
  it("legacy pin: without the new options the result is exactly the legacy object", () => {
    expect(pin.length).toBeGreaterThanOrEqual(12);
    for (const c of pin) {
      const r = repriceOptionUnderShock(c.input, { ...c.shock, now: new Date(c.shock.now) });
      expect(r, c.name).toStrictEqual(c.result);
      expect("priceSource" in r).toBe(false);
      expect("expiresBeforeDate" in r).toBe(false);
      expect("v1IfMoveFirst" in r).toBe(false);
    }
  });

  it("valuation date today keeps the identity", () => {
    const r = modelled(repriceOptionUnderShock(put(), shock(0, { valuationDate: TODAY })));
    expect(r.perShareChange).toBe(0);
    expect(r.priceSource).toBe("own-price");

    // A contract expiring today, before the close (11:00 ET).
    const T0 = yearsToExpiry(TODAY, TODAY, NOW);
    const sameDay = put({ expiration_date: TODAY, strike_price: 60, own_price: putPrice(60, 60, T0, R, 0.4) });
    const s = modelled(repriceOptionUnderShock(sameDay, shock(0, { valuationDate: TODAY })));
    expect(s.perShareChange).toBe(0);
    expect(s.v1).toBe(s.v0);
  });

  it("time decay: 0% move at a later date loses on the long, gains on the written", () => {
    const later = "2026-07-01"; // today + 30, expiry 60 days after it
    for (const opt of [put(), call()]) {
      const r = modelled(repriceOptionUnderShock(opt, shock(0, { valuationDate: later })));
      expect(r.v1).toBeLessThan(r.v0);
      expect(r.perShareChange).toBeLessThan(0); // long loses
      expect(-r.perShareChange).toBeGreaterThan(0); // written gains
      expect(r.priceSource).toBe("own-price");
      expect("expiresBeforeDate" in r).toBe(false);
      expect("v1IfMoveFirst" in r).toBe(false);
    }
    // The later value is the model at T1 = days left / 365, at the solved volatility.
    const p = modelled(repriceOptionUnderShock(put(), shock(0, { valuationDate: later })));
    expect(p.v1).toBeCloseTo(putPrice(60, 50, 60 / 365, R, p.sigma), 12);
  });

  it("expires on the date: intrinsic at the moved price", () => {
    const expiry = "2026-06-15";
    const T0 = 14 / 365;
    const opt = put({ expiration_date: expiry, own_price: putPrice(60, 50, T0, R, 0.4) });
    const r = modelled(repriceOptionUnderShock(opt, shock(-0.2, { valuationDate: expiry })));
    expect(r.v1).toBeCloseTo(2, 10);
    expect("expiresBeforeDate" in r).toBe(false);
  });

  it("expires before the date: both cases are returned and flagged", () => {
    const expiry = "2026-06-15";
    const T0 = 14 / 365;
    const opt = put({ expiration_date: expiry, own_price: putPrice(60, 50, T0, R, 0.4) });
    const r = modelled(repriceOptionUnderShock(opt, shock(-0.3, { valuationDate: "2026-07-01" })));
    expect(r.v1).toBe(0);
    expect(r.v1IfMoveFirst).toBeCloseTo(8, 10);
    expect(r.expiresBeforeDate).toBe(true);
  });

  it("expired after the close is still 'expired' with a valuation date", () => {
    const after = new Date("2026-06-01T21:00:00Z"); // 17:00 ET
    const opt = put({ expiration_date: TODAY, own_price: 1 });
    const r = repriceOptionUnderShock(opt, shock(-0.2, { now: after, valuationDate: "2026-07-01", modelWhenUnpriced: true }));
    expect(r).toStrictEqual({ modelled: false, reason: "expired" });
  });

  it("unpriced option: modelled from the broker IV and flagged", () => {
    const r = modelled(repriceOptionUnderShock(put({ own_price: null }), shock(-0.2, { modelWhenUnpriced: true })));
    expect(r.priceSource).toBe("model");
    expect(r.ivSource).toBe("broker-underlying");
    expect(r.sigma).toBe(0.3);
    expect(r.v0).toBe(putPrice(60, 50, T, R, 0.3));
    expect(r.v1).toBe(putPrice(48, 50, T, R, 0.3));
    expect(r.changePercent).toBe(Math.max(-1, r.perShareChange / r.v0));
  });

  it("unpriced option with no IV is not modelled; the default volatility is never read", () => {
    for (const iv of [null, 0, -0.1]) {
      const r = repriceOptionUnderShock(put({ own_price: null, underlying_iv: iv }), shock(-0.2, { modelWhenUnpriced: true }));
      expect(r).toStrictEqual({ modelled: false, reason: "no-volatility" });
    }
    const noS = repriceOptionUnderShock(put({ own_price: null, underlying_price: null }), shock(-0.2, { modelWhenUnpriced: true }));
    expect(noS).toStrictEqual({ modelled: false, reason: "no-underlying-price" });
    const noFlag = repriceOptionUnderShock(put({ own_price: null }), shock(-0.2));
    expect(noFlag).toStrictEqual({ modelled: false, reason: "no-option-price" });

    const src = readFileSync(join(__dirname, "..", "..", "lib", "compute", "option-reprice.ts"), "utf8");
    expect(src).not.toContain("DEFAULT_FALLBACK_VOL");
  });

  it("an own price above the no-arbitrage bound falls back to the broker IV (ivSource tells)", () => {
    const opt = call({ strike_price: 50, own_price: 70 });
    const r = modelled(repriceOptionUnderShock(opt, shock(-0.2, { valuationDate: TODAY })));
    expect(r.ivSource).toBe("broker-underlying");
    expect(r.priceSource).toBe("own-price");
  });

  it("a malformed or impossible valuation date throws the invalid-date error, never a modelled value", () => {
    for (const bad of ["2026-13-01", "2026-06-31", "2026-02-30", "", "9999-99-99", "2026-7-01"]) {
      expect(() => repriceOptionUnderShock(put(), shock(-0.2, { valuationDate: bad })), bad).toThrow(
        "valuationDate is not a valid date",
      );
    }
    // A real later day still works.
    expect(repriceOptionUnderShock(put(), shock(-0.2, { valuationDate: "2026-07-01" })).modelled).toBe(true);
  });

  it("the model-row trap: changePercent is 0 while perShareChange is not, so never scale changePercent by market value", () => {
    // Unpriced, deep out-of-the-money call: the model value today is exactly 0.
    const opt = call({ strike_price: 600, expiration_date: "2026-06-15", own_price: null });
    const r = modelled(repriceOptionUnderShock(opt, shock(9, { modelWhenUnpriced: true })));
    expect(r.priceSource).toBe("model");
    expect(r.v0).toBe(0);
    expect(r.perShareChange).toBeGreaterThan(0);
    expect(r.changePercent).toBe(0);
  });

  it("valuation date before today throws", () => {
    expect(() => repriceOptionUnderShock(put(), shock(0, { valuationDate: "2026-05-31" }))).toThrow(
      "valuationDate is before today",
    );
  });
});
