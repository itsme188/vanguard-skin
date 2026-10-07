// Review fixes for the Detected Strategies engine (lib/compute/options-strategy.ts):
//  1. the stale-mark gate checks every option against the underlying's price,
//     including spreads and naked options that carry no stock leg;
//  2. a withheld strategy says WHY;
//  3. multi-leg structures are sized on their contract count;
//  4. a partially covered call names its uncovered contracts.
// All symbols and prices are invented.
import { describe, it, expect } from "vitest";
import {
  detectStrategies,
  pricingIncompleteNote,
  type DetectedStrategy,
  type PositionLeg,
} from "@/lib/compute/options-strategy";
import { todayET, addDays } from "@/lib/calendar/date-utils";

const LIVE_EXPIRY = addDays(todayET(), 365);

function stock(symbol: string, qty: number, price: number | null): PositionLeg {
  return {
    symbol,
    underlying: symbol,
    securityType: "stock",
    quantity: qty,
    multiplier: 1,
    currentPrice: price,
  };
}

function option(
  underlying: string,
  type: "CALL" | "PUT",
  strike: number,
  qty: number,
  price: number | null
): PositionLeg {
  return {
    symbol: `${underlying}-${type}-${strike}`,
    underlying,
    securityType: "option",
    optionType: type,
    strike,
    expiration: LIVE_EXPIRY,
    quantity: qty,
    multiplier: 100,
    currentPrice: price,
  };
}

function only(strategies: DetectedStrategy[], type: string): DetectedStrategy {
  const hits = strategies.filter((s) => s.type === type);
  expect(hits.length).toBe(1);
  return hits[0];
}

function expectWithheld(s: DetectedStrategy, reason: string) {
  expect(s.pricingIncomplete).toBe(true);
  expect(s.pricingIncompleteReason).toBe(reason);
  expect(s.maxProfit).toBeNull();
  expect(s.maxLoss).toBeNull();
  expect(s.breakevens).toEqual([]);
}

describe("stale-mark gate uses the underlying's price, not the strategy's own legs", () => {
  it("naked short put marked far below intrinsic is withheld (stock 30, 45 put at 1.21)", () => {
    const s = only(
      detectStrategies([stock("AAA", 100, 30), option("AAA", "PUT", 45, -1, 1.21)]),
      "naked_put"
    );
    expectWithheld(s, "below_intrinsic");
  });

  it("call spread with a long leg marked below intrinsic is withheld (stock 60, 50 call at 2.40)", () => {
    const s = only(
      detectStrategies([
        stock("AAA", 100, 60),
        option("AAA", "CALL", 50, 1, 2.4),
        option("AAA", "CALL", 55, -1, 0.95),
      ]),
      "bull_call_spread"
    );
    expectWithheld(s, "below_intrinsic");
  });

  it("with no price for the underlying, intrinsic cannot be checked and the marks stand", () => {
    const s = only(
      detectStrategies([
        option("AAA", "CALL", 50, 1, 2.4),
        option("AAA", "CALL", 55, -1, 0.95),
      ]),
      "bull_call_spread"
    );
    expect(s.pricingIncomplete).toBe(false);
    expect(s.pricingIncompleteReason).toBeNull();
    expect(s.maxLoss).toBeCloseTo(145, 2);
    expect(s.maxProfit).toBeCloseTo(355, 2);
    expect(s.breakevens[0]).toBeCloseTo(51.45, 2);
  });

  describe("tolerance: withheld only below intrinsic by more than max(0.05, 1% of intrinsic)", () => {
    // Stock 40, 50 put: intrinsic 10, tolerance 0.10.
    it("intrinsic 10: a mark 0.09 below stands", () => {
      const s = only(
        detectStrategies([stock("AAA", 100, 40), option("AAA", "PUT", 50, -1, 9.91)]),
        "naked_put"
      );
      expect(s.pricingIncomplete).toBe(false);
      expect(s.maxProfit).toBeCloseTo(991, 2);
    });
    it("intrinsic 10: a mark 0.11 below is withheld", () => {
      const s = only(
        detectStrategies([stock("AAA", 100, 40), option("AAA", "PUT", 50, -1, 9.89)]),
        "naked_put"
      );
      expectWithheld(s, "below_intrinsic");
    });
    // Stock 48, 50 put: intrinsic 2, 1% is 0.02, so the 0.05 floor applies.
    it("intrinsic 2: a mark 0.04 below stands (the 0.05 floor)", () => {
      const s = only(
        detectStrategies([stock("AAA", 100, 48), option("AAA", "PUT", 50, -1, 1.96)]),
        "naked_put"
      );
      expect(s.pricingIncomplete).toBe(false);
    });
    it("intrinsic 2: a mark 0.06 below is withheld", () => {
      const s = only(
        detectStrategies([stock("AAA", 100, 48), option("AAA", "PUT", 50, -1, 1.94)]),
        "naked_put"
      );
      expectWithheld(s, "below_intrinsic");
    });
  });
});

describe("a withheld strategy carries its reason", () => {
  it("missing price", () => {
    const s = only(
      detectStrategies([stock("AAA", 100, 60), option("AAA", "PUT", 50, 1, null)]),
      "protective_put"
    );
    expectWithheld(s, "missing_price");
  });
  it("zero mark", () => {
    const s = only(
      detectStrategies([stock("AAA", 100, 60), option("AAA", "PUT", 50, 1, 0)]),
      "protective_put"
    );
    expectWithheld(s, "zero_mark");
  });
  it("a missing price outranks a below-intrinsic mark on another leg", () => {
    const s = only(
      detectStrategies([
        stock("AAA", 100, 60),
        option("AAA", "CALL", 50, 1, 2.4),
        option("AAA", "CALL", 55, -1, null),
      ]),
      "bull_call_spread"
    );
    expectWithheld(s, "missing_price");
  });
  it("a priced strategy has a null reason", () => {
    const [s] = detectStrategies([stock("AAA", 100, 60), option("AAA", "PUT", 50, 1, 1.5)]);
    expect(s.pricingIncomplete).toBe(false);
    expect(s.pricingIncompleteReason).toBeNull();
  });
});

describe("multi-leg structures are sized on the contract count", () => {
  // Per share: debit / credit 2.40 - 0.95 = 1.45 on a 5-wide spread.
  const verticals: Array<{
    type: string;
    legs: (n: number) => PositionLeg[];
    profit1: number;
    loss1: number;
    breakeven: number;
  }> = [
    {
      type: "bull_call_spread",
      legs: (n) => [option("AAA", "CALL", 50, n, 2.4), option("AAA", "CALL", 55, -n, 0.95)],
      profit1: 355,
      loss1: 145,
      breakeven: 51.45,
    },
    {
      type: "bear_call_spread",
      legs: (n) => [option("AAA", "CALL", 50, -n, 2.4), option("AAA", "CALL", 55, n, 0.95)],
      profit1: 145,
      loss1: 355,
      breakeven: 51.45,
    },
    {
      type: "bear_put_spread",
      legs: (n) => [option("AAA", "PUT", 55, n, 2.4), option("AAA", "PUT", 50, -n, 0.95)],
      profit1: 355,
      loss1: 145,
      breakeven: 53.55,
    },
    {
      type: "bull_put_spread",
      legs: (n) => [option("AAA", "PUT", 55, -n, 2.4), option("AAA", "PUT", 50, n, 0.95)],
      profit1: 145,
      loss1: 355,
      breakeven: 53.55,
    },
  ];

  for (const v of verticals) {
    for (const n of [1, 3]) {
      it(`${v.type} x${n}`, () => {
        const s = only(detectStrategies(v.legs(n)), v.type);
        expect(s.maxProfit).toBeCloseTo(v.profit1 * n, 2);
        expect(s.maxLoss).toBeCloseTo(v.loss1 * n, 2);
        expect(s.breakevens[0]).toBeCloseTo(v.breakeven, 2);
      });
    }
  }

  it("the reviewer's probe: 3 bull call spreads lose at most 435.00 and make at most 1,065.00", () => {
    const s = only(detectStrategies(verticals[0].legs(3)), "bull_call_spread");
    expect(s.maxLoss).toBeCloseTo(435.0, 2);
    expect(s.maxProfit).toBeCloseTo(1065.0, 2);
    expect(s.description).toContain("(3 contracts)");
  });

  // Straddle at 50: call 2.00 + put 1.50 = 3.50 per share.
  for (const n of [1, 3]) {
    it(`long straddle x${n}`, () => {
      const s = only(
        detectStrategies([option("AAA", "CALL", 50, n, 2), option("AAA", "PUT", 50, n, 1.5)]),
        "straddle"
      );
      expect(s.maxLoss).toBeCloseTo(350 * n, 2);
      expect(s.maxProfit).toBeNull();
      expect(s.breakevens[0]).toBeCloseTo(46.5, 2);
      expect(s.breakevens[1]).toBeCloseTo(53.5, 2);
    });
    it(`short straddle x${n}`, () => {
      const s = only(
        detectStrategies([option("AAA", "CALL", 50, -n, 2), option("AAA", "PUT", 50, -n, 1.5)]),
        "straddle"
      );
      expect(s.maxProfit).toBeCloseTo(350 * n, 2);
      expect(s.maxLoss).toBeNull();
      expect(s.breakevens[0]).toBeCloseTo(46.5, 2);
      expect(s.breakevens[1]).toBeCloseTo(53.5, 2);
    });
    // Strangle 45 put 1.00 + 55 call 1.25 = 2.25 per share.
    it(`long strangle x${n}`, () => {
      const s = only(
        detectStrategies([option("AAA", "PUT", 45, n, 1), option("AAA", "CALL", 55, n, 1.25)]),
        "strangle"
      );
      expect(s.maxLoss).toBeCloseTo(225 * n, 2);
      expect(s.maxProfit).toBeNull();
      expect(s.breakevens[0]).toBeCloseTo(42.75, 2);
      expect(s.breakevens[1]).toBeCloseTo(57.25, 2);
    });
    // Condor 40/45 puts, 55/60 calls: credit 1.40 - 0.40 + 1.50 - 0.50 = 2.00
    // per share on 5-wide wings, so the worst case is 3.00 per share.
    it(`iron condor x${n}`, () => {
      const s = only(
        detectStrategies([
          option("AAA", "PUT", 40, n, 0.5),
          option("AAA", "PUT", 45, -n, 1.5),
          option("AAA", "CALL", 55, -n, 1.4),
          option("AAA", "CALL", 60, n, 0.4),
        ]),
        "iron_condor"
      );
      expect(s.maxProfit).toBeCloseTo(200 * n, 2);
      expect(s.maxLoss).toBeCloseTo(300 * n, 2);
      expect(s.breakevens[0]).toBeCloseTo(43, 2);
      expect(s.breakevens[1]).toBeCloseTo(57, 2);
    });
  }

  it("unequal legs: sized on the matched count, the remainder is named", () => {
    const s = only(
      detectStrategies([option("AAA", "CALL", 50, 3, 2.4), option("AAA", "CALL", 55, -1, 0.95)]),
      "bull_call_spread"
    );
    expect(s.maxLoss).toBeCloseTo(145, 2);
    expect(s.maxProfit).toBeCloseTo(355, 2);
    expect(s.description).toContain("figures sized on 1 contract;");
    expect(s.description).toContain("2 long $50 calls unmatched and not in these figures");
  });

  it("unequal straddle legs: the extra short put is named", () => {
    const s = only(
      detectStrategies([option("AAA", "CALL", 50, -2, 2), option("AAA", "PUT", 50, -3, 1.5)]),
      "straddle"
    );
    expect(s.maxProfit).toBeCloseTo(700, 2);
    expect(s.description).toContain("figures sized on 2 contracts; 1 short $50 put unmatched");
  });

  it("a single matched contract adds no sizing note", () => {
    const s = only(detectStrategies(verticals[0].legs(1)), "bull_call_spread");
    expect(s.description).not.toContain("contract");
  });
});

describe("partially covered call", () => {
  it("150 shares against 2 short calls: covered figures as before, the naked contract is stated", () => {
    const s = only(
      detectStrategies([stock("AAA", 150, 50), option("AAA", "CALL", 55, -2, 1.25)]),
      "covered_call"
    );
    // 150 x 50 down to zero, less one covered contract's premium (125).
    expect(s.maxLoss).toBeCloseTo(7375, 2);
    expect(s.description).toContain(
      "1 call contract is uncovered: unlimited loss above $55"
    );
    // Net short above the strike, so profit peaks AT the strike, not
    // "unlimited": 150 shares x (55 - 50) + both calls' premium (2 x 125).
    expect(s.maxProfit).toBeCloseTo(1000, 2);
  });

  it("100 shares against 3 short calls: two contracts are uncovered", () => {
    const s = only(
      detectStrategies([stock("AAA", 100, 50), option("AAA", "CALL", 55, -3, 1.25)]),
      "covered_call"
    );
    expect(s.description).toContain(
      "2 call contracts are uncovered: unlimited loss above $55"
    );
  });

  it("a fully covered call says nothing about uncovered contracts", () => {
    const s = only(
      detectStrategies([stock("AAA", 200, 50), option("AAA", "CALL", 55, -2, 1.25)]),
      "covered_call"
    );
    expect(s.description).not.toContain("uncovered");
  });
});

describe("the withheld-figures note is worded from the reason", () => {
  it("only a missing price says there is no price yet", () => {
    expect(pricingIncompleteNote("missing_price")).toContain("no price yet");
    expect(pricingIncompleteNote("zero_mark")).not.toContain("no price yet");
    expect(pricingIncompleteNote("below_intrinsic")).not.toContain("no price yet");
  });
  it("names a zero mark and a below-intrinsic mark for what they are", () => {
    expect(pricingIncompleteNote("zero_mark")).toContain("marked at zero");
    expect(pricingIncompleteNote("below_intrinsic")).toContain("below its intrinsic value");
  });
  it("an absent reason gets neutral wording, never a specific claim", () => {
    for (const absent of [null, undefined]) {
      const note = pricingIncompleteNote(absent);
      expect(note).toContain("no usable price");
      expect(note).not.toContain("no price yet");
    }
  });
});
