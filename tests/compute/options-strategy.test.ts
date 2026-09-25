import { describe, it, expect } from "vitest";
import {
  detectStrategies,
  type PositionLeg,
} from "@/lib/compute/options-strategy";
import { todayET, addDays } from "@/lib/calendar/date-utils";

// ─── Helpers ────────────────────────────────────────────────────

// detectStrategies drops contracts that already expired, so the shared
// fixtures need a LIVE expiry. Anchored a year ahead of today (ET) rather
// than hardcoded, so these tests can never rot into "expired" the way a
// fixed 2026-06-19 did.
const LIVE_EXPIRY = addDays(todayET(), 365);

function stock(symbol: string, qty: number, price?: number): PositionLeg {
  return {
    symbol,
    underlying: symbol,
    securityType: "stock",
    quantity: qty,
    multiplier: 1,
    currentPrice: price ?? 150,
  };
}

function option(
  underlying: string,
  type: "CALL" | "PUT",
  strike: number,
  qty: number,
  opts?: { expiry?: string; price?: number }
): PositionLeg {
  const expiry = opts?.expiry ?? LIVE_EXPIRY;
  return {
    symbol: `${underlying.padEnd(6)}${expiry.replace(/-/g, "").slice(2)}${type[0]}${String(strike * 1000).padStart(8, "0")}`,
    underlying,
    securityType: "option",
    optionType: type,
    strike,
    expiration: expiry,
    quantity: qty,
    multiplier: 100,
    currentPrice: opts?.price ?? 5,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe("detectStrategies", () => {
  it("detects a covered call", () => {
    const positions = [
      stock("AAPL", 100, 180),
      option("AAPL", "CALL", 190, -1, { price: 3 }),
    ];
    const strategies = detectStrategies(positions);
    expect(strategies.length).toBe(1);
    expect(strategies[0].type).toBe("covered_call");
    expect(strategies[0].underlying).toBe("AAPL");
    expect(strategies[0].legs.length).toBe(2);
    expect(strategies[0].breakevens.length).toBe(1);
  });

  it("detects a protective put", () => {
    const positions = [
      stock("MSFT", 200, 400),
      option("MSFT", "PUT", 380, 2, { price: 8 }),
    ];
    const strategies = detectStrategies(positions);
    expect(strategies.length).toBe(1);
    expect(strategies[0].type).toBe("protective_put");
    expect(strategies[0].maxProfit).toBeNull(); // unlimited upside
  });

  it("detects a bull call spread", () => {
    const positions = [
      option("AAPL", "CALL", 180, 1, { price: 10 }),
      option("AAPL", "CALL", 200, -1, { price: 3 }),
    ];
    const strategies = detectStrategies(positions);
    expect(strategies.length).toBe(1);
    expect(strategies[0].type).toBe("bull_call_spread");
    expect(strategies[0].maxLoss).toBeCloseTo(700, 0); // net debit: (10-3)*100
    expect(strategies[0].maxProfit).toBeCloseTo(1300, 0); // spread*100 - debit: 20*100-700
  });

  it("detects a bear put spread", () => {
    const positions = [
      option("SPY", "PUT", 500, 1, { price: 15 }),
      option("SPY", "PUT", 480, -1, { price: 8 }),
    ];
    const strategies = detectStrategies(positions);
    expect(strategies.length).toBe(1);
    expect(strategies[0].type).toBe("bear_put_spread");
    expect(strategies[0].maxLoss).toBeCloseTo(700, 0); // debit: (15-8)*100
    expect(strategies[0].maxProfit).toBeCloseTo(1300, 0); // spread*100 - debit
  });

  it("detects a long straddle", () => {
    const positions = [
      option("TSLA", "CALL", 250, 1, { price: 12 }),
      option("TSLA", "PUT", 250, 1, { price: 10 }),
    ];
    const strategies = detectStrategies(positions);
    expect(strategies.length).toBe(1);
    expect(strategies[0].type).toBe("straddle");
    expect(strategies[0].name).toContain("Long");
    expect(strategies[0].maxProfit).toBeNull(); // unlimited
    expect(strategies[0].breakevens.length).toBe(2);
    expect(strategies[0].breakevens[0]).toBeCloseTo(228, 0); // 250 - 22
    expect(strategies[0].breakevens[1]).toBeCloseTo(272, 0); // 250 + 22
  });

  it("detects a strangle", () => {
    const positions = [
      option("NVDA", "PUT", 800, 1, { price: 15 }),
      option("NVDA", "CALL", 900, 1, { price: 12 }),
    ];
    const strategies = detectStrategies(positions);
    expect(strategies.length).toBe(1);
    expect(strategies[0].type).toBe("strangle");
    expect(strategies[0].breakevens.length).toBe(2);
  });

  it("detects an iron condor", () => {
    const positions = [
      option("SPY", "PUT", 470, 1, { price: 2 }),   // long lower put
      option("SPY", "PUT", 480, -1, { price: 5 }),  // short higher put
      option("SPY", "CALL", 520, -1, { price: 5 }), // short lower call
      option("SPY", "CALL", 530, 1, { price: 2 }),  // long higher call
    ];
    const strategies = detectStrategies(positions);
    const condors = strategies.filter((s) => s.type === "iron_condor");
    expect(condors.length).toBe(1);
    expect(condors[0].legs.length).toBe(4);
    // Net credit = (5-2+5-2)*100 = 600
    expect(condors[0].maxProfit).toBeCloseTo(600, 0);
  });

  it("detects naked short call", () => {
    const positions = [
      option("AMZN", "CALL", 200, -2, { price: 4 }),
    ];
    const strategies = detectStrategies(positions);
    expect(strategies.length).toBe(1);
    expect(strategies[0].type).toBe("naked_call");
    expect(strategies[0].maxLoss).toBeNull(); // unlimited
    expect(strategies[0].maxProfit).toBeCloseTo(800, 0); // 4*100*2
  });

  it("returns empty for no options", () => {
    const positions = [stock("AAPL", 100)];
    expect(detectStrategies(positions)).toEqual([]);
  });

  it("handles covered call + protective put together", () => {
    const positions = [
      stock("AAPL", 200, 180),
      option("AAPL", "CALL", 200, -1, { price: 5 }),
      option("AAPL", "PUT", 170, 1, { price: 3 }),
    ];
    const strategies = detectStrategies(positions);
    const types = strategies.map((s) => s.type);
    expect(types).toContain("covered_call");
    expect(types).toContain("protective_put");
  });

  // QA analysis-detected-strategies--expired-option-rendered-live-protective-put:
  // a put that expired 2026-08-14 still rendered as a live protective put with
  // a MAX LOSS figure, while the Options Greeks table on the same page marked
  // it expired and the Defense hedge book / Option Expirations panel had
  // already excluded it. An expired contract is not a position.
  describe("expired contracts", () => {
    const yesterday = addDays(todayET(), -1);
    const today = todayET();
    const tomorrow = addDays(todayET(), 1);

    it("drops a protective put whose contract expired yesterday", () => {
      const positions = [
        stock("MSFT", 200, 400),
        option("MSFT", "PUT", 380, 2, { expiry: yesterday, price: 8 }),
      ];
      expect(detectStrategies(positions)).toEqual([]);
    });

    it("keeps a contract expiring TODAY (it can still be exercised/traded)", () => {
      const positions = [
        stock("MSFT", 200, 400),
        option("MSFT", "PUT", 380, 2, { expiry: today, price: 8 }),
      ];
      const types = detectStrategies(positions).map((s) => s.type);
      expect(types).toContain("protective_put");
    });

    it("keeps a contract expiring tomorrow", () => {
      const positions = [
        stock("MSFT", 200, 400),
        option("MSFT", "PUT", 380, 2, { expiry: tomorrow, price: 8 }),
      ];
      const types = detectStrategies(positions).map((s) => s.type);
      expect(types).toContain("protective_put");
    });

    it("drops expired legs from every strategy family, not just covered ones", () => {
      const positions = [
        option("AAPL", "CALL", 180, 1, { expiry: yesterday, price: 10 }),
        option("AAPL", "CALL", 200, -1, { expiry: yesterday, price: 3 }),
        option("AMZN", "CALL", 200, -2, { expiry: yesterday, price: 4 }),
      ];
      expect(detectStrategies(positions)).toEqual([]);
    });

    it("also understands the YYYYMMDD expiry spelling some TWS rows carry", () => {
      const compact = (iso: string) => iso.replace(/-/g, "");
      const expired = [
        stock("MSFT", 200, 400),
        option("MSFT", "PUT", 380, 2, { expiry: compact(yesterday), price: 8 }),
      ];
      const live = [
        stock("MSFT", 200, 400),
        option("MSFT", "PUT", 380, 2, { expiry: compact(tomorrow), price: 8 }),
      ];
      expect(detectStrategies(expired)).toEqual([]);
      expect(detectStrategies(live).map((s) => s.type)).toContain("protective_put");
    });

    it("accepts an explicit `today` so callers can pin the cutoff", () => {
      const positions = [
        stock("MSFT", 200, 400),
        option("MSFT", "PUT", 380, 2, { expiry: "2026-08-14", price: 8 }),
      ];
      expect(detectStrategies(positions, { today: "2026-08-15" })).toEqual([]);
      expect(detectStrategies(positions, { today: "2026-08-14" }).map((s) => s.type)).toContain(
        "protective_put"
      );
    });

    it("keeps a contract with no/unparseable expiration rather than guessing", () => {
      const noExpiry: PositionLeg = {
        symbol: "MSFT  UNKNOWN",
        underlying: "MSFT",
        securityType: "option",
        optionType: "PUT",
        strike: 380,
        expiration: undefined,
        quantity: 2,
        multiplier: 100,
        currentPrice: 8,
      };
      const types = detectStrategies([stock("MSFT", 200, 400), noExpiry]).map((s) => s.type);
      expect(types).toContain("protective_put");
    });
  });

  // QA analysis-detected-strategies--protective-put-max-loss-sized-on-option-notional-not-shares:
  // Max Loss was sized on the FULL option notional even when the puts covered
  // more (or fewer) shares than were actually held, while breakeven and the
  // description were built from the share leg. The true worst case only lets
  // the covered shares carry the (stock - strike) loss; every contract's
  // premium is spent regardless, and puts beyond the share count are outright
  // long puts capped at their own premium.
  //
  // 2026-09-11 landing review, round 2: the first fix then swung too far and
  // priced ONLY the covered shares — an under-hedge's naked shares vanished
  // from the worst case, so 250 shares behind a single put reported the loss
  // of a 100-share position. The strategy's legs are the whole stock line, so
  // maxLoss must carry the uncovered shares to zero as well, and breakeven
  // must spread the premium over every share held.
  describe("protective put max loss sizing", () => {
    it("over-hedged: 5 puts cover more shares than are held", () => {
      const positions = [
        stock("QAAA", 250, 82.67),
        option("QAAA", "PUT", 72, 5, { price: 0.07 }),
      ];
      const strategies = detectStrategies(positions);
      expect(strategies.length).toBe(1);
      const pp = strategies[0];
      expect(pp.type).toBe("protective_put");
      // (82.67 - 72) * 250 covered shares + 0.07 * 100 * 5 premium
      expect(pp.maxLoss).toBeCloseTo(2702.5, 2);
      expect(pp.maxProfit).toBeNull();
      // breakeven spreads the total premium over the covered shares: 82.67 + 35/250
      expect(pp.breakevens[0]).toBeCloseTo(82.81, 2);
      expect(pp.description).toContain("cover 500 sh vs 250 held");
    });

    it("fully covered: puts cover exactly the held shares", () => {
      // 200 shares behind 2 puts x 100 = every share hedged, no naked stub.
      // (The fixture used to hold 250 shares, which is a 50-share UNDER-hedge
      // — it never exercised the uncovered === 0 boundary this test names.)
      const positions = [
        stock("QAAA", 200, 82.67),
        option("QAAA", "PUT", 72, 2, { price: 0.07 }),
      ];
      const strategies = detectStrategies(positions);
      const pp = strategies[0];
      // (82.67 - 72) * 200 covered shares + 0.07 * 100 * 2 premium, no
      // uncovered shares to carry down
      expect(pp.maxLoss).toBeCloseTo(2148, 2);
      // premium spreads over every share held: 82.67 + 14/200
      expect(pp.breakevens[0]).toBeCloseTo(82.74, 2);
      expect(pp.description).not.toContain("cover");
      expect(pp.description).not.toContain("unhedged");
    });

    it("under-hedged: the 150 naked shares carry their full cost into max loss", () => {
      const positions = [
        stock("QAAA", 250, 82.67),
        option("QAAA", "PUT", 72, 1, { price: 0.07 }),
      ];
      const strategies = detectStrategies(positions);
      const pp = strategies[0];
      // One put hedges 100 of the 250 shares. Worst case is the stock at 0:
      // the hedged 100 are made whole at the 72 strike (100 x 10.67 = 1,067
      // lost), the naked 150 lose their whole cost (150 x 82.67 = 12,400.50),
      // and the 7.00 premium is spent either way -> 13,474.50. Pricing only
      // the covered shares reported 1,074 — a twelvefold understatement of the
      // worst case on the same position.
      expect(pp.maxLoss).toBeCloseTo(13474.5, 2);
      // premium spreads over every share held: 82.67 + 7/250 = 82.698
      expect(pp.breakevens[0]).toBeCloseTo(82.698, 3);
      // the description has to say the position is only part-hedged
      expect(pp.description).toContain("150 sh unhedged");
    });

    it("under-hedged in-the-money put: the hedged shares risk only time value, the naked ones risk everything", () => {
      const positions = [
        stock("QAAA", 250, 82.67),
        option("QAAA", "PUT", 90, 1, { price: 8 }),
      ];
      const strategies = detectStrategies(positions);
      const pp = strategies[0];
      // strike (90) above spot (82.67): on the 100 covered shares the put's
      // 7.33 intrinsic nets against the 8.00 premium, so only 0.67 x 100 = 67
      // of time value is at risk there. The stock loss and the put payoff
      // offset exactly only on those 100 shares — the other 150 are naked and
      // lose their full 82.67 cost if the stock goes to zero:
      // 100 x (82.67 - 90) + 150 x 82.67 + 800 = 12,467.50.
      expect(pp.maxLoss).toBeCloseTo(12467.5, 2);
    });

    it("over-hedged in-the-money put: extra contracts add their full premium", () => {
      const positions = [
        stock("QAAA", 250, 82.67),
        option("QAAA", "PUT", 90, 5, { price: 8 }),
      ];
      const strategies = detectStrategies(positions);
      const pp = strategies[0];
      // (82.67 - 90) * 250 covered shares + 8 * 100 * 5 premium = 2167.5
      expect(pp.maxLoss).toBeCloseTo(2167.5, 2);
      expect(pp.description).toContain("cover 500 sh vs 250 held");
    });

    it("max loss never goes negative when a stale mark prices the put below intrinsic", () => {
      const positions = [
        stock("QAAA", 100, 80),
        option("QAAA", "PUT", 90, 1, { price: 5 }),
      ];
      const strategies = detectStrategies(positions);
      const pp = strategies[0];
      // (80 - 90) * 100 + 500 = -500 -> floored at 0
      expect(pp.maxLoss).toBe(0);
    });
  });

  it("separates strategies by underlying", () => {
    const positions = [
      option("AAPL", "CALL", 180, 1, { price: 10 }),
      option("AAPL", "CALL", 200, -1, { price: 3 }),
      option("MSFT", "PUT", 400, 1, { price: 12 }),
      option("MSFT", "PUT", 380, -1, { price: 5 }),
    ];
    const strategies = detectStrategies(positions);
    expect(strategies.length).toBe(2);
    const underlyings = strategies.map((s) => s.underlying);
    expect(underlyings).toContain("AAPL");
    expect(underlyings).toContain("MSFT");
  });
});

// QA analysis-detected-strategies--protective-put-missing-put-price-treated-as-zero-premium:
// a leg with no price row used to be priced at $0 premium and the card showed
// the resulting max loss / breakeven as fact. The strategy must still be
// detected (the leg structure is known) but the money figures are withheld.
describe("unpriced legs withhold payoff figures", () => {
  function unpriced(leg: PositionLeg): PositionLeg {
    return { ...leg, currentPrice: null };
  }

  it("protective put with an unpriced put: detected, pricingIncomplete, no figures", () => {
    const strategies = detectStrategies([
      stock("MSFT", 200, 400),
      unpriced(option("MSFT", "PUT", 380, 2)),
    ]);
    expect(strategies.length).toBe(1);
    const s = strategies[0];
    expect(s.type).toBe("protective_put");
    expect(s.pricingIncomplete).toBe(true);
    expect(s.maxLoss).toBeNull();
    expect(s.maxProfit).toBeNull();
    expect(s.breakevens).toEqual([]);
  });

  it("fully priced protective put keeps its figures and pricingIncomplete false", () => {
    const strategies = detectStrategies([
      stock("MSFT", 200, 400),
      option("MSFT", "PUT", 380, 2, { price: 8 }),
    ]);
    const s = strategies[0];
    expect(s.pricingIncomplete).toBe(false);
    // 200 * (400 - 380) + 8 * 100 * 2 = 5600
    expect(s.maxLoss).toBe(5600);
    // 400 + 1600 / 200 = 408
    expect(s.breakevens).toEqual([408]);
  });

  it("an unpriced stock leg also makes the package incomplete", () => {
    const strategies = detectStrategies([
      unpriced(stock("MSFT", 200, 400)),
      option("MSFT", "PUT", 380, 2, { price: 8 }),
    ]);
    expect(strategies[0].pricingIncomplete).toBe(true);
    expect(strategies[0].maxLoss).toBeNull();
  });

  it("covered call with an unpriced call: pricingIncomplete", () => {
    const strategies = detectStrategies([
      stock("AAPL", 100, 180),
      unpriced(option("AAPL", "CALL", 190, -1)),
    ]);
    expect(strategies.length).toBe(1);
    expect(strategies[0].type).toBe("covered_call");
    expect(strategies[0].pricingIncomplete).toBe(true);
    expect(strategies[0].maxProfit).toBeNull();
    expect(strategies[0].maxLoss).toBeNull();
    expect(strategies[0].breakevens).toEqual([]);
  });

  it("vertical spread with one unpriced leg: pricingIncomplete", () => {
    const strategies = detectStrategies([
      option("AAPL", "CALL", 180, 1, { price: 10 }),
      unpriced(option("AAPL", "CALL", 200, -1)),
    ]);
    expect(strategies.length).toBe(1);
    expect(strategies[0].type).toBe("bull_call_spread");
    expect(strategies[0].pricingIncomplete).toBe(true);
    expect(strategies[0].maxProfit).toBeNull();
    expect(strategies[0].maxLoss).toBeNull();
    expect(strategies[0].breakevens).toEqual([]);
  });

  it("a NaN price counts as unpriced", () => {
    const strategies = detectStrategies([
      option("AAPL", "PUT", 180, -1, { price: Number.NaN }),
    ]);
    expect(strategies[0].type).toBe("naked_put");
    expect(strategies[0].pricingIncomplete).toBe(true);
  });

  it("naked call with no price: pricingIncomplete", () => {
    const strategies = detectStrategies([
      unpriced(option("AAPL", "CALL", 180, -1)),
    ]);
    expect(strategies[0].type).toBe("naked_call");
    expect(strategies[0].pricingIncomplete).toBe(true);
    expect(strategies[0].maxProfit).toBeNull();
    expect(strategies[0].breakevens).toEqual([]);
  });

  it("fully priced strategies all report pricingIncomplete false", () => {
    const strategies = detectStrategies([
      option("SPY", "PUT", 400, 1, { price: 2 }),
      option("SPY", "PUT", 420, -1, { price: 4 }),
      option("SPY", "CALL", 460, -1, { price: 4 }),
      option("SPY", "CALL", 480, 1, { price: 2 }),
    ]);
    expect(strategies.length).toBeGreaterThan(0);
    for (const s of strategies) expect(s.pricingIncomplete).toBe(false);
  });
});
