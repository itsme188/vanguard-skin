import { describe, it, expect } from "vitest";
import {
  computePositionDayMove,
  type PositionDayMoveInput,
} from "@/lib/compute/day-move";

// Every figure here is invented and round. Each expectation is worked by hand
// in the comment above it.

function move(overrides: Partial<PositionDayMoveInput>) {
  return computePositionDayMove({
    priorQty: null,
    currentQty: 0,
    priorClose: null,
    latestClose: null,
    priorCostBasis: null,
    currentCostBasis: null,
    multiplier: 1,
    ...overrides,
  });
}

describe("computePositionDayMove — a position held through the session", () => {
  it("unchanged: the whole quantity gets the close-to-close move", () => {
    // 10 sh, 100 -> 105: gain 10 x 5 = 50; prior value 10 x 100 = 1,000.
    const m = move({ priorQty: 10, currentQty: 10, priorClose: 100, latestClose: 105 });
    expect(m.gain).toBeCloseTo(50, 9);
    expect(m.base).toBeCloseTo(1000, 9);
    expect(m.basis).toBe("prior_close");
    expect(m.openedToday).toBe(false);
    expect(m.addedQty).toBe(0);
    expect(m.addedCostUnknown).toBe(false);
  });

  it("unchanged: cost basis is never read", () => {
    const m = move({
      priorQty: 10, currentQty: 10, priorClose: 100, latestClose: 105,
      priorCostBasis: 1, currentCostBasis: 999_999,
    });
    expect(m.gain).toBeCloseTo(50, 9);
    expect(m.basis).toBe("prior_close");
  });

  it("reduced: only the quantity still held gets the move, and no realised figure is invented", () => {
    // 10 -> 4 sh, 100 -> 105: gain 4 x 5 = 20; prior value of what is still held 400.
    const m = move({
      priorQty: 10, currentQty: 4, priorClose: 100, latestClose: 105,
      priorCostBasis: 900, currentCostBasis: 360,
    });
    expect(m.gain).toBeCloseTo(20, 9);
    expect(m.base).toBeCloseTo(400, 9);
    expect(m.basis).toBe("prior_close");
    expect(m.addedQty).toBe(0);
    expect(m.openedToday).toBe(false);
  });

  it("a short partly covered: only the quantity still short gets the move", () => {
    // -10 -> -4 sh, 50 -> 45: gain -4 x -5 = +20; prior value |−4 x 50| = 200.
    const m = move({ priorQty: -10, currentQty: -4, priorClose: 50, latestClose: 45 });
    expect(m.gain).toBeCloseTo(20, 9);
    expect(m.base).toBeCloseTo(200, 9);
    expect(m.basis).toBe("prior_close");
  });

  it("a held short gains when the price falls", () => {
    // -10 sh, 50 -> 45: gain -10 x -5 = +50.
    const m = move({ priorQty: -10, currentQty: -10, priorClose: 50, latestClose: 45 });
    expect(m.gain).toBeCloseTo(50, 9);
    expect(m.base).toBeCloseTo(500, 9);
  });

  it("no prior close: the move is unknown, never zero", () => {
    const m = move({ priorQty: 10, currentQty: 10, priorClose: null, latestClose: 105 });
    expect(m.gain).toBeNull();
    expect(m.base).toBeNull();
    expect(m.basis).toBe("unpriced");
  });

  it("no latest close: the move is unknown", () => {
    const m = move({ priorQty: 10, currentQty: 10, priorClose: 100, latestClose: null });
    expect(m.gain).toBeNull();
    expect(m.basis).toBe("unpriced");
  });
});

describe("computePositionDayMove — a position opened today", () => {
  it("with a cost: measured from cost, not from the prior close", () => {
    // 10 sh bought at 102 (cost 1,020), close 105: gain 10 x 3 = 30.
    // The prior close (100) would have credited 50.
    const m = move({ priorQty: null, currentQty: 10, priorClose: 100, latestClose: 105, currentCostBasis: 1020 });
    expect(m.gain).toBeCloseTo(30, 9);
    expect(m.base).toBeCloseTo(1020, 9);
    expect(m.basis).toBe("cost");
    expect(m.openedToday).toBe(true);
    expect(m.addedQty).toBe(10);
  });

  it("a prior quantity of zero (a tombstone) is the same as absent", () => {
    const m = move({ priorQty: 0, currentQty: 10, priorClose: 100, latestClose: 105, currentCostBasis: 1020 });
    expect(m.gain).toBeCloseTo(30, 9);
    expect(m.openedToday).toBe(true);
  });

  it("with a cost and no prior close at all: still measured, the prior close is not needed", () => {
    const m = move({ priorQty: null, currentQty: 10, priorClose: null, latestClose: 105, currentCostBasis: 1020 });
    expect(m.gain).toBeCloseTo(30, 9);
    expect(m.basis).toBe("cost");
  });

  it("without a cost: excluded, never credited with the move since the prior close", () => {
    for (const cost of [null, 0, Number.NaN]) {
      const m = move({ priorQty: null, currentQty: 10, priorClose: 100, latestClose: 105, currentCostBasis: cost });
      expect(m.gain).toBeNull();
      expect(m.base).toBeNull();
      expect(m.basis).toBe("excluded");
      expect(m.openedToday).toBe(true);
    }
  });

  it("an implausible cost is treated as unknown (band: a third to three times the latest close)", () => {
    // Close 105. Per-share 315 is exactly 3x: kept. 316: excluded.
    expect(move({ currentQty: 10, latestClose: 105, currentCostBasis: 3150 }).basis).toBe("cost");
    expect(move({ currentQty: 10, latestClose: 105, currentCostBasis: 3160 }).basis).toBe("excluded");
    // Per-share 35 is exactly a third: kept. 34: excluded.
    expect(move({ currentQty: 10, latestClose: 105, currentCostBasis: 350 }).basis).toBe("cost");
    expect(move({ currentQty: 10, latestClose: 105, currentCostBasis: 340 }).basis).toBe("excluded");
    // Kept at the 3x edge: gain 10 x (105 - 315) = -2,100.
    expect(move({ currentQty: 10, latestClose: 105, currentCostBasis: 3150 }).gain).toBeCloseTo(-2100, 9);
  });

  it("a short opened today gains when the price falls below the sale price", () => {
    // Sold 10 short at 50 (the live writer stores quantity x average cost = -500), close 45:
    // gain (45 - 50) x -10 = +50; base 500.
    const m = move({ priorQty: null, currentQty: -10, priorClose: 52, latestClose: 45, currentCostBasis: -500 });
    expect(m.gain).toBeCloseTo(50, 9);
    expect(m.base).toBeCloseTo(500, 9);
    expect(m.basis).toBe("cost");
    expect(m.addedQty).toBe(-10);
  });

  it("a short opened today loses when the price rises above the sale price", () => {
    // Sold 10 short at 50, close 53: gain (53 - 50) x -10 = -30.
    const m = move({ currentQty: -10, latestClose: 53, currentCostBasis: -500 });
    expect(m.gain).toBeCloseTo(-30, 9);
  });

  it("a short whose proceeds are stored as a positive magnitude reads the same", () => {
    const m = move({ currentQty: -10, latestClose: 45, currentCostBasis: 500 });
    expect(m.gain).toBeCloseTo(50, 9);
    expect(m.base).toBeCloseTo(500, 9);
  });

  it("a flip through zero (long yesterday, short today) is a position opened today", () => {
    // Was +10, now -5 sold at 50 (cost -250), close 45: gain (45 - 50) x -5 = +25.
    const m = move({
      priorQty: 10, currentQty: -5, priorClose: 52, latestClose: 45,
      priorCostBasis: 480, currentCostBasis: -250,
    });
    expect(m.gain).toBeCloseTo(25, 9);
    expect(m.base).toBeCloseTo(250, 9);
    expect(m.basis).toBe("cost");
    expect(m.openedToday).toBe(true);
    expect(m.addedQty).toBe(-5);
  });

  it("an option: the multiplier scales the value, the cost is total dollars", () => {
    // 2 contracts x 100, bought at 5.00 (cost 1,000), close 6.00: gain 1 x 2 x 100 = 200.
    const m = move({ currentQty: 2, latestClose: 6, currentCostBasis: 1000, multiplier: 100, priorClose: 2 });
    expect(m.gain).toBeCloseTo(200, 9);
    expect(m.base).toBeCloseTo(1000, 9);
    expect(m.basis).toBe("cost");
  });

  it("an option cost that forgot the multiplier is implausible and excluded", () => {
    // Cost 10 for 2 contracts x 100 is 0.05 a share against a 6.00 close.
    const m = move({ currentQty: 2, latestClose: 6, currentCostBasis: 10, multiplier: 100 });
    expect(m.basis).toBe("excluded");
    expect(m.gain).toBeNull();
  });

  it("a bond: a 0.01 value factor (price per 100 face)", () => {
    // 10,000 face bought at 98 (cost 9,800), close 99: gain (99 - 98) x 10,000 x 0.01 = 100.
    const m = move({ currentQty: 10_000, latestClose: 99, currentCostBasis: 9800, multiplier: 0.01 });
    expect(m.gain).toBeCloseTo(100, 9);
    expect(m.base).toBeCloseTo(9800, 9);
  });

  it("no latest close: unknown, and still flagged as opened", () => {
    const m = move({ currentQty: 10, latestClose: null, currentCostBasis: 1020 });
    expect(m.gain).toBeNull();
    expect(m.basis).toBe("unpriced");
    expect(m.openedToday).toBe(true);
  });
});

describe("computePositionDayMove — an add to an existing position", () => {
  it("held quantity gets close-to-close, added quantity is measured from its own cost", () => {
    // 10 -> 15 sh. Prior close 100, latest 105. Total cost 900 -> 1,410, so the
    // 5 added shares cost 510 = 102 each.
    // Held: 10 x 5 = 50. Added: 5 x (105 - 102) = 15. Gain 65.
    // Base: 10 x 100 + 510 = 1,510.
    const m = move({
      priorQty: 10, currentQty: 15, priorClose: 100, latestClose: 105,
      priorCostBasis: 900, currentCostBasis: 1410,
    });
    expect(m.gain).toBeCloseTo(65, 9);
    expect(m.base).toBeCloseTo(1510, 9);
    expect(m.basis).toBe("mixed");
    expect(m.openedToday).toBe(false);
    expect(m.addedQty).toBe(5);
    expect(m.addedCostUnknown).toBe(false);
  });

  it("either cost basis missing: the added quantity is left out and flagged", () => {
    // Only the 10 held shares count: 10 x 5 = 50, base 1,000.
    for (const [prior, current] of [[null, 1410], [900, null], [0, 1410], [900, 0]] as const) {
      const m = move({
        priorQty: 10, currentQty: 15, priorClose: 100, latestClose: 105,
        priorCostBasis: prior, currentCostBasis: current,
      });
      expect(m.gain).toBeCloseTo(50, 9);
      expect(m.base).toBeCloseTo(1000, 9);
      expect(m.basis).toBe("prior_close");
      expect(m.addedQty).toBe(5);
      expect(m.addedCostUnknown).toBe(true);
    }
  });

  it("a derived cost that is not positive is left out", () => {
    // Total cost fell while the quantity rose: 900 -> 850 gives -10 a share.
    const m = move({
      priorQty: 10, currentQty: 15, priorClose: 100, latestClose: 105,
      priorCostBasis: 900, currentCostBasis: 850,
    });
    expect(m.gain).toBeCloseTo(50, 9);
    expect(m.addedCostUnknown).toBe(true);
  });

  it("a derived cost outside the band is left out", () => {
    // 5 added shares for 5 dollars in total = 1 a share against a 105 close.
    const low = move({
      priorQty: 10, currentQty: 15, priorClose: 100, latestClose: 105,
      priorCostBasis: 900, currentCostBasis: 905,
    });
    expect(low.addedCostUnknown).toBe(true);
    expect(low.gain).toBeCloseTo(50, 9);
    // 5 added shares for 2,000 = 400 a share, more than 3 x 105.
    const high = move({
      priorQty: 10, currentQty: 15, priorClose: 100, latestClose: 105,
      priorCostBasis: 900, currentCostBasis: 2900,
    });
    expect(high.addedCostUnknown).toBe(true);
    expect(high.gain).toBeCloseTo(50, 9);
  });

  it("an add to a short: both parts carry the short's sign", () => {
    // -10 -> -15. Prior close 50, latest 45. Proceeds -520 -> -760: the 5 added
    // were sold for 240 = 48 each.
    // Held: -10 x -5 = +50. Added: (45 - 48) x -5 = +15. Gain 65.
    // Base: 10 x 50 + 240 = 740.
    const m = move({
      priorQty: -10, currentQty: -15, priorClose: 50, latestClose: 45,
      priorCostBasis: -520, currentCostBasis: -760,
    });
    expect(m.gain).toBeCloseTo(65, 9);
    expect(m.base).toBeCloseTo(740, 9);
    expect(m.basis).toBe("mixed");
    expect(m.addedQty).toBe(-5);
  });

  it("an add to a short whose two rows disagree on sign convention is left out, not guessed", () => {
    // +520 then -760 derives 256 a share against a 45 close: outside the band.
    const m = move({
      priorQty: -10, currentQty: -15, priorClose: 50, latestClose: 45,
      priorCostBasis: 520, currentCostBasis: -760,
    });
    expect(m.addedCostUnknown).toBe(true);
    expect(m.gain).toBeCloseTo(50, 9);
    expect(m.base).toBeCloseTo(500, 9);
  });

  it("an option add uses the multiplier on both parts", () => {
    // 1 -> 3 contracts x 100. Prior close 4, latest 6. Cost 380 -> 1,380: the 2
    // added cost 1,000 = 5.00 a share.
    // Held: 1 x 2 x 100 = 200. Added: 2 x (6 - 5) x 100 = 200. Gain 400.
    // Base: 1 x 4 x 100 + 1,000 = 1,400.
    const m = move({
      priorQty: 1, currentQty: 3, priorClose: 4, latestClose: 6,
      priorCostBasis: 380, currentCostBasis: 1380, multiplier: 100,
    });
    expect(m.gain).toBeCloseTo(400, 9);
    expect(m.base).toBeCloseTo(1400, 9);
    expect(m.basis).toBe("mixed");
  });

  it("no prior close: the whole row is unknown rather than half measured", () => {
    const m = move({
      priorQty: 10, currentQty: 15, priorClose: null, latestClose: 105,
      priorCostBasis: 900, currentCostBasis: 1410,
    });
    expect(m.gain).toBeNull();
    expect(m.basis).toBe("unpriced");
    expect(m.addedQty).toBe(5);
  });
});

describe("computePositionDayMove — guards", () => {
  it("a zero current quantity has no move", () => {
    const m = move({ priorQty: 10, currentQty: 0, priorClose: 100, latestClose: 105 });
    expect(m.gain).toBeNull();
    expect(m.basis).toBe("unpriced");
    expect(m.openedToday).toBe(false);
  });

  it("a missing or bad multiplier counts as 1", () => {
    for (const multiplier of [Number.NaN, 0, -100]) {
      const m = move({ priorQty: 10, currentQty: 10, priorClose: 100, latestClose: 105, multiplier });
      expect(m.gain).toBeCloseTo(50, 9);
    }
  });
});

// Codex review 2026-10-08: a short's total cost can be stored as positive
// proceeds. Held short 100 from prior close 60 to 57: 100 x 3 = +300.
// 50 more shorted today at 58: (58 - 57) x 50 = +50. Total +350.
// Base: 100 x 60 + 50 x 58 = 8,900.
describe("computePositionDayMove — adding to a short, either cost convention", () => {
  const base = { priorQty: -100, currentQty: -150, priorClose: 60, latestClose: 57, multiplier: 1 };

  it("negative stored cost (the live writer's quantity x average cost)", () => {
    const m = computePositionDayMove({ ...base, priorCostBasis: -6000, currentCostBasis: -8900 });
    expect(m.gain).toBeCloseTo(350, 9);
    expect(m.base).toBeCloseTo(8900, 9);
    expect(m.basis).toBe("mixed");
    expect(m.addedCostUnknown).toBe(false);
  });

  it("positive stored proceeds give the same answer", () => {
    const m = computePositionDayMove({ ...base, priorCostBasis: 6000, currentCostBasis: 8900 });
    expect(m.gain).toBeCloseTo(350, 9);
    expect(m.base).toBeCloseTo(8900, 9);
    expect(m.addedCostUnknown).toBe(false);
  });

  it("a total cost that shrank while the quantity grew is left out, not guessed", () => {
    const m = computePositionDayMove({ ...base, priorCostBasis: -6000, currentCostBasis: -5000 });
    expect(m.gain).toBeCloseTo(300, 9);
    expect(m.addedCostUnknown).toBe(true);
  });
});

