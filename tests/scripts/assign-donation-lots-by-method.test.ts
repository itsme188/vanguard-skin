import { describe, it, expect } from "vitest";
import {
  selectLotsFifo,
  selectLotsMinTax,
  mintaxBucket,
} from "../../scripts/assign-donation-lots-by-method";
import type { OpenLotForDonation } from "../../lib/queries/giving-view";

let nextId = 1;
function lot(overrides: Partial<OpenLotForDonation>): OpenLotForDonation {
  const id = nextId++;
  return {
    acquisitionTransactionId: id,
    acquisitionDate: "2023-01-01",
    costBasis: 1000,
    quantityAcquired: 100,
    remainingAsOfDonationDate: 100,
    isLongTerm: true,
    gainPerShare: 1,
    suggested: false,
    suggestedQuantity: 0,
    currentlyAssignedQuantity: 0,
    ...overrides,
  };
}

describe("selectLotsFifo", () => {
  it("consumes lots in acquisition-date order across lot boundaries", () => {
    const lots = [
      lot({ acquisitionDate: "2023-06-01", remainingAsOfDonationDate: 50 }),
      lot({ acquisitionDate: "2023-01-01", remainingAsOfDonationDate: 30 }),
    ];
    const result = selectLotsFifo(lots, 60);
    expect(result.shortfall).toBe(0);
    expect(result.picks.map((p) => [p.acquisitionDate, p.quantity])).toEqual([
      ["2023-01-01", 30],
      ["2023-06-01", 30],
    ]);
  });

  it("skips exhausted lots and reports a shortfall when open lots can't cover", () => {
    const lots = [
      lot({ acquisitionDate: "2023-01-01", remainingAsOfDonationDate: 0 }),
      lot({ acquisitionDate: "2023-02-01", remainingAsOfDonationDate: 25 }),
    ];
    const result = selectLotsFifo(lots, 40);
    expect(result.picks).toHaveLength(1);
    expect(result.picks[0].quantity).toBe(25);
    expect(result.shortfall).toBeCloseTo(15);
  });
});

describe("mintaxBucket ordering", () => {
  it("ranks ST loss < LT loss < ST zero < LT zero < LT gain < ST gain", () => {
    const stLoss = lot({ isLongTerm: false, gainPerShare: -5 });
    const ltLoss = lot({ isLongTerm: true, gainPerShare: -5 });
    const stZero = lot({ isLongTerm: false, gainPerShare: 0 });
    const ltZero = lot({ isLongTerm: true, gainPerShare: 0 });
    const ltGain = lot({ isLongTerm: true, gainPerShare: 5 });
    const stGain = lot({ isLongTerm: false, gainPerShare: 5 });
    const buckets = [stLoss, ltLoss, stZero, ltZero, ltGain, stGain].map(mintaxBucket);
    expect(buckets).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("treats sub-half-cent gains as zero and null gain as unrankable", () => {
    expect(mintaxBucket(lot({ isLongTerm: false, gainPerShare: 0.004 }))).toBe(2);
    expect(mintaxBucket(lot({ gainPerShare: null }))).toBeNull();
  });
});

describe("selectLotsMinTax", () => {
  it("exhausts losses (largest total loss first) before touching gains", () => {
    const smallLoss = lot({ acquisitionDate: "2023-01-01", isLongTerm: true, gainPerShare: -1, remainingAsOfDonationDate: 10 });
    const bigLoss = lot({ acquisitionDate: "2023-02-01", isLongTerm: true, gainPerShare: -10, remainingAsOfDonationDate: 10 });
    const gain = lot({ acquisitionDate: "2020-01-01", isLongTerm: true, gainPerShare: 50, remainingAsOfDonationDate: 100 });
    const result = selectLotsMinTax([smallLoss, gain, bigLoss], 25);
    expect("unrankable" in result).toBe(false);
    if ("unrankable" in result) return;
    expect(result.picks.map((p) => [p.acquisitionDate, p.quantity])).toEqual([
      ["2023-02-01", 10], // biggest total loss first
      ["2023-01-01", 10],
      ["2020-01-01", 5], // gains only after losses are gone
    ]);
  });

  it("prefers LT gains (smallest first) over ST gains regardless of size", () => {
    const stTinyGain = lot({ isLongTerm: false, gainPerShare: 0.5, remainingAsOfDonationDate: 100, acquisitionDate: "2026-01-01" });
    const ltBigGain = lot({ isLongTerm: true, gainPerShare: 40, remainingAsOfDonationDate: 100, acquisitionDate: "2020-01-01" });
    const ltSmallGain = lot({ isLongTerm: true, gainPerShare: 2, remainingAsOfDonationDate: 100, acquisitionDate: "2021-01-01" });
    const result = selectLotsMinTax([stTinyGain, ltBigGain, ltSmallGain], 150);
    if ("unrankable" in result) throw new Error("unexpected unrankable");
    expect(result.picks.map((p) => p.acquisitionDate)).toEqual(["2021-01-01", "2020-01-01"]);
  });

  it("is unrankable when any live lot has no gain figure", () => {
    const result = selectLotsMinTax([lot({ gainPerShare: null })], 10);
    expect("unrankable" in result).toBe(true);
  });

  it("ignores a null-gain lot that is already exhausted", () => {
    const dead = lot({ gainPerShare: null, remainingAsOfDonationDate: 0 });
    const live = lot({ gainPerShare: 3, remainingAsOfDonationDate: 50 });
    const result = selectLotsMinTax([dead, live], 20);
    if ("unrankable" in result) throw new Error("unexpected unrankable");
    expect(result.picks).toHaveLength(1);
    expect(result.picks[0].quantity).toBe(20);
  });
});
