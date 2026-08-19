import { describe, it, expect } from "vitest";
import { computeLotCoverageGaps } from "@/lib/compute/lot-coverage";

describe("computeLotCoverageGaps", () => {
  it("returns no gaps when lots exactly cover the position", () => {
    const positions = [{ account_id: 1, account_name: "Taxable", quantity: 150 }];
    const openLots = [
      { account_id: 1, quantity_remaining: 100 },
      { account_id: 1, quantity_remaining: 50 },
    ];
    expect(computeLotCoverageGaps(positions, openLots)).toEqual([]);
  });

  it("flags partial coverage (150 shares held, only 125 in lots)", () => {
    const positions = [{ account_id: 1, account_name: "Taxable", quantity: 150 }];
    const openLots = [{ account_id: 1, quantity_remaining: 125 }];
    expect(computeLotCoverageGaps(positions, openLots)).toEqual([
      {
        accountId: 1,
        accountName: "Taxable",
        positionQty: 150,
        coveredQty: 125,
        missingQty: 25,
      },
    ]);
  });

  it("flags an account with a position but zero lots as a full gap", () => {
    const positions = [{ account_id: 2, account_name: "IBKR", quantity: 50 }];
    const openLots: { account_id: number; quantity_remaining: number }[] = [];
    expect(computeLotCoverageGaps(positions, openLots)).toEqual([
      {
        accountId: 2,
        accountName: "IBKR",
        positionQty: 50,
        coveredQty: 0,
        missingQty: 50,
      },
    ]);
  });

  it("evaluates multi-account positions independently — one matches, one doesn't", () => {
    const positions = [
      { account_id: 1, account_name: "Taxable", quantity: 150 },
      { account_id: 2, account_name: "IBKR", quantity: 50 },
    ];
    const openLots = [
      { account_id: 1, quantity_remaining: 150 },
      // account 2 has no lots at all
    ];
    expect(computeLotCoverageGaps(positions, openLots)).toEqual([
      {
        accountId: 2,
        accountName: "IBKR",
        positionQty: 50,
        coveredQty: 0,
        missingQty: 50,
      },
    ]);
  });

  it("tolerates float noise within epsilon", () => {
    const positions = [{ account_id: 1, account_name: "Taxable", quantity: 100.0000001 }];
    const openLots = [
      { account_id: 1, quantity_remaining: 33.3333334 },
      { account_id: 1, quantity_remaining: 66.6666667 },
    ];
    expect(computeLotCoverageGaps(positions, openLots)).toEqual([]);
  });

  it("does not compare quantities across accounts", () => {
    // Account 1 is short 10, account 2 has 10 extra unmatched lots — a naive
    // global sum would net these to zero and hide both mismatches.
    const positions = [
      { account_id: 1, account_name: "Taxable", quantity: 100 },
      { account_id: 2, account_name: "Roth", quantity: 40 },
    ];
    const openLots = [
      { account_id: 1, quantity_remaining: 90 },
      { account_id: 2, quantity_remaining: 50 },
    ];
    const gaps = computeLotCoverageGaps(positions, openLots);
    expect(gaps).toHaveLength(2);
    expect(gaps).toEqual(
      expect.arrayContaining([
        { accountId: 1, accountName: "Taxable", positionQty: 100, coveredQty: 90, missingQty: 10 },
        { accountId: 2, accountName: "Roth", positionQty: 40, coveredQty: 50, missingQty: -10 },
      ])
    );
  });

  it("returns [] for empty positions", () => {
    expect(computeLotCoverageGaps([], [])).toEqual([]);
  });

  it("skips short positions (negative quantity) even with matching positive short lots", () => {
    // Short lots are stored with POSITIVE quantity_remaining and is_short=1,
    // while the position query (includeShorts) reports a NEGATIVE quantity
    // for the same short. A naive comparison of -3 vs +3 would produce a
    // nonsense gap ("6 more shares in lots than the position shows"); shorts
    // must be skipped entirely rather than reconciled.
    const positions = [{ account_id: 1, account_name: "IBKR", quantity: -3 }];
    const openLots = [{ account_id: 1, quantity_remaining: 3 }];
    expect(computeLotCoverageGaps(positions, openLots)).toEqual([]);
  });
});
