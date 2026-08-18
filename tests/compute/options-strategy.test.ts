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
