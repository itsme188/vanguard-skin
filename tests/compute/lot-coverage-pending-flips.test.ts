/**
 * Coverage and sign-mismatch notes never treat a pending or opposite-side lot
 * as covering a position (plan docs/superpowers/plans/
 * 2026-10-26-pending-lots-options-shorts-plan.md Task 10; ruling R9 and
 * OPEN-1). Both flip directions. Synthetic accounts and round numbers.
 */
import { describe, it, expect } from "vitest";
import { computeLotCoverageGaps, computeLotSignMismatches } from "@/lib/compute/lot-coverage";

const longPos = [{ account_id: 1, account_name: "Taxable", quantity: 10 }];
const shortPos = [{ account_id: 1, account_name: "Taxable", quantity: -10 }];

describe("computeLotCoverageGaps: long position vs short or pending lots (R9)", () => {
  it("long position 10 over only a pending short lot of 10 → a coverage gap of 10 (no long lots), not a match", () => {
    const lots = [{ account_id: 1, quantity_remaining: 10, is_short: 1, pending_statement: true }];
    expect(computeLotCoverageGaps(longPos, lots)).toEqual([
      { accountId: 1, accountName: "Taxable", positionQty: 10, coveredQty: 0, missingQty: 10 },
    ]);
  });

  it("long position over long lots plus a pending short lot → the short lot does not count", () => {
    const lots = [
      { account_id: 1, quantity_remaining: 10, is_short: 0, pending_statement: false },
      { account_id: 1, quantity_remaining: 4, is_short: 1, pending_statement: true },
    ];
    expect(computeLotCoverageGaps(longPos, lots)).toEqual([]);
  });

  it("a non-pending short lot does not cover a long position either", () => {
    const lots = [{ account_id: 1, quantity_remaining: 10, is_short: true, pending_statement: false }];
    expect(computeLotCoverageGaps(longPos, lots)).toEqual([
      { accountId: 1, accountName: "Taxable", positionQty: 10, coveredQty: 0, missingQty: 10 },
    ]);
  });

  it("a pending long lot does not cover a long position", () => {
    const lots = [
      { account_id: 1, quantity_remaining: 6, is_short: 0, pending_statement: false },
      { account_id: 1, quantity_remaining: 4, is_short: 0, pending_statement: true },
    ];
    expect(computeLotCoverageGaps(longPos, lots)).toEqual([
      { accountId: 1, accountName: "Taxable", positionQty: 10, coveredQty: 6, missingQty: 4 },
    ]);
  });

  it("lots with no side or pending field read as long and not pending (older callers)", () => {
    expect(computeLotCoverageGaps(longPos, [{ account_id: 1, quantity_remaining: 10 }])).toEqual([]);
  });

  it("short positions stay skipped", () => {
    const lots = [{ account_id: 1, quantity_remaining: 3, is_short: 1, pending_statement: false }];
    expect(computeLotCoverageGaps(shortPos, lots)).toEqual([]);
  });
});

describe("computeLotSignMismatches: short position vs pending long lots (OPEN-1)", () => {
  it("short position over pending long lots (PR #123 flip) → no sign-mismatch row", () => {
    const lots = [
      { account_id: 1, quantity_remaining: 6, is_short: 0, pending_statement: true },
      { account_id: 1, quantity_remaining: 4, is_short: 0, pending_statement: true },
    ];
    expect(computeLotSignMismatches(shortPos, lots)).toEqual([]);
  });

  it("short position over NON-pending long lots → sign-mismatch row (control)", () => {
    const lots = [
      { account_id: 1, quantity_remaining: 6, is_short: 0, pending_statement: false },
      { account_id: 1, quantity_remaining: 4, is_short: 0 },
    ];
    expect(computeLotSignMismatches(shortPos, lots)).toEqual([
      { accountId: 1, accountName: "Taxable", positionQty: -10, longLotQty: 10, longLotCount: 2 },
    ]);
  });

  it("counts only the non-pending long lots when both kinds are open", () => {
    const lots = [
      { account_id: 1, quantity_remaining: 6, is_short: 0, pending_statement: true },
      { account_id: 1, quantity_remaining: 4, is_short: 0, pending_statement: false },
    ];
    expect(computeLotSignMismatches(shortPos, lots)).toEqual([
      { accountId: 1, accountName: "Taxable", positionQty: -10, longLotQty: 4, longLotCount: 1 },
    ]);
  });
});
