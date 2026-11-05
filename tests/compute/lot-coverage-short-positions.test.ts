/**
 * qa: dashboard-security-1754-qqq-and-dashboard-security-1762-smh-positions-vs-open-tax-lots-live-short-po
 *
 * A live SHORT position with no matching short lots used to print no
 * coverage line at all, while a long with no lots did. A short is now
 * compared on absolute quantity against the account's SHORT, non-pending
 * open lots (a short lot stores a positive quantity with is_short=1; ruling
 * of 2026-10-26). Synthetic accounts and round numbers.
 */
import { describe, it, expect } from "vitest";
import { computeLotCoverageGaps } from "@/lib/compute/lot-coverage";

const shortPos = [{ account_id: 1, account_name: "AAA Taxable", quantity: -50 }];
const longPos = [{ account_id: 1, account_name: "AAA Taxable", quantity: 100 }];

describe("computeLotCoverageGaps: short positions", () => {
  it("a short with no lots → one short gap of the full quantity", () => {
    expect(computeLotCoverageGaps(shortPos, [])).toEqual([
      { accountId: 1, accountName: "AAA Taxable", side: "short", positionQty: -50, coveredQty: 0, missingQty: 50 },
    ]);
  });

  it("a short fully covered by short lots → no gap", () => {
    const lots = [
      { account_id: 1, quantity_remaining: 20, is_short: 1 },
      { account_id: 1, quantity_remaining: 30, is_short: true },
    ];
    expect(computeLotCoverageGaps(shortPos, lots)).toEqual([]);
  });

  it("a short partly covered by short lots → gap of the remainder", () => {
    const lots = [{ account_id: 1, quantity_remaining: 20, is_short: 1 }];
    expect(computeLotCoverageGaps(shortPos, lots)).toEqual([
      { accountId: 1, accountName: "AAA Taxable", side: "short", positionQty: -50, coveredQty: 20, missingQty: 30 },
    ]);
  });

  it("short lots over-covering a short → negative missingQty", () => {
    const lots = [{ account_id: 1, quantity_remaining: 100, is_short: 1 }];
    expect(computeLotCoverageGaps(shortPos, lots)).toEqual([
      { accountId: 1, accountName: "AAA Taxable", side: "short", positionQty: -50, coveredQty: 100, missingQty: -50 },
    ]);
  });

  it("long lots never cover a short", () => {
    const lots = [{ account_id: 1, quantity_remaining: 50, is_short: 0 }];
    expect(computeLotCoverageGaps(shortPos, lots)).toEqual([
      { accountId: 1, accountName: "AAA Taxable", side: "short", positionQty: -50, coveredQty: 0, missingQty: 50 },
    ]);
  });

  it("pending short lots do not count", () => {
    const lots = [
      { account_id: 1, quantity_remaining: 30, is_short: 1, pending_statement: false },
      { account_id: 1, quantity_remaining: 20, is_short: 1, pending_statement: true },
    ];
    expect(computeLotCoverageGaps(shortPos, lots)).toEqual([
      { accountId: 1, accountName: "AAA Taxable", side: "short", positionQty: -50, coveredQty: 30, missingQty: 20 },
    ]);
  });

  it("short lots in another account do not count", () => {
    const lots = [{ account_id: 2, quantity_remaining: 50, is_short: 1 }];
    expect(computeLotCoverageGaps(shortPos, lots)).toEqual([
      { accountId: 1, accountName: "AAA Taxable", side: "short", positionQty: -50, coveredQty: 0, missingQty: 50 },
    ]);
  });
});

describe("computeLotCoverageGaps: long positions keep today's behaviour", () => {
  it("a long over short lots only → gap with coveredQty 0, side long", () => {
    const lots = [{ account_id: 1, quantity_remaining: 100, is_short: 1 }];
    expect(computeLotCoverageGaps(longPos, lots)).toEqual([
      { accountId: 1, accountName: "AAA Taxable", side: "long", positionQty: 100, coveredQty: 0, missingQty: 100 },
    ]);
  });

  it("a long fully covered by long lots → no gap", () => {
    const lots = [{ account_id: 1, quantity_remaining: 100, is_short: 0 }];
    expect(computeLotCoverageGaps(longPos, lots)).toEqual([]);
  });

  it("long and short positions in two accounts are each judged on their own side", () => {
    const positions = [
      { account_id: 1, account_name: "AAA Taxable", quantity: 100 },
      { account_id: 2, account_name: "ZZZ Margin", quantity: -50 },
    ];
    const lots = [
      { account_id: 1, quantity_remaining: 100, is_short: 0 },
      { account_id: 2, quantity_remaining: 50, is_short: 1 },
    ];
    expect(computeLotCoverageGaps(positions, lots)).toEqual([]);
  });
});
