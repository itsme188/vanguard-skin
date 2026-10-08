import { describe, it, expect } from "vitest";
import { computeLotCoverageGaps, computeLotSignMismatches } from "@/lib/compute/lot-coverage";

/**
 * qa: security-detail-positions--short-position-over-long-open-lots-no-coverage-note
 * A short position over long open lots printed with no note, because the
 * coverage check skips shorts. Synthetic accounts and round numbers.
 */
describe("computeLotSignMismatches", () => {
  const short = [{ account_id: 1, account_name: "Taxable", quantity: -175 }];

  it("names a short position that sits over long open lots", () => {
    const lots = [
      { account_id: 1, quantity_remaining: 100, is_short: 0 },
      { account_id: 1, quantity_remaining: 150, is_short: 0 },
    ];
    expect(computeLotSignMismatches(short, lots)).toEqual([
      { accountId: 1, accountName: "Taxable", positionQty: -175, longLotQty: 250, longLotCount: 2 },
    ]);
    // The coverage check still says nothing about a short: the disclosure
    // above is the only line for this account.
    expect(computeLotCoverageGaps(short, lots)).toEqual([]);
  });

  it("a short over its own short-sale lots is not a mismatch", () => {
    const lots = [{ account_id: 1, quantity_remaining: 175, is_short: 1 }];
    expect(computeLotSignMismatches(short, lots)).toEqual([]);
  });

  it("counts only the long lots when both kinds are open", () => {
    const lots = [
      { account_id: 1, quantity_remaining: 175, is_short: 1 },
      { account_id: 1, quantity_remaining: 40, is_short: 0 },
    ];
    expect(computeLotSignMismatches(short, lots)).toEqual([
      { accountId: 1, accountName: "Taxable", positionQty: -175, longLotQty: 40, longLotCount: 1 },
    ]);
  });

  it("is per account: long lots in another account do not count", () => {
    const lots = [{ account_id: 2, quantity_remaining: 250, is_short: 0 }];
    expect(computeLotSignMismatches(short, lots)).toEqual([]);
  });

  it("a long or flat position never reports one", () => {
    const lots = [{ account_id: 1, quantity_remaining: 250, is_short: 0 }];
    expect(
      computeLotSignMismatches(
        [
          { account_id: 1, account_name: "Taxable", quantity: 250 },
          { account_id: 1, account_name: "Taxable", quantity: 0 },
        ],
        lots
      )
    ).toEqual([]);
  });

  it("ignores float-dust lots and a short with no lots at all", () => {
    expect(
      computeLotSignMismatches(short, [{ account_id: 1, quantity_remaining: 1e-9, is_short: 0 }])
    ).toEqual([]);
    expect(computeLotSignMismatches(short, [])).toEqual([]);
  });
});
