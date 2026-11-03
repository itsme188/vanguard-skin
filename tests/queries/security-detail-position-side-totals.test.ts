/**
 * Hub Positions: a name held long in one account and short in another shows
 * LONG and SHORT total rows, never one netted total (2026-11-01 ruling,
 * item 12). Synthetic symbols and round invented numbers only.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  computePositionSideTotals,
  computePositionTotals,
  type SecurityPosition,
} from "@/lib/queries/security-detail";
import { anchorIndex } from "@/tests/helpers/source-anchor";

function pos(over: Partial<SecurityPosition>): SecurityPosition {
  return {
    account_id: 1,
    account_name: "Acct One",
    quantity: 0,
    cost_basis: null,
    as_of_date: "2026-07-10",
    current_price: null,
    current_value: null,
    unrealized_gain: null,
    security_type: "Stock",
    multiplier: 1,
    ...over,
  };
}

describe("computePositionSideTotals", () => {
  it("splits a long and a short into their own totals", () => {
    const r = computePositionSideTotals([
      pos({ account_id: 1, quantity: 100, cost_basis: 1000, current_value: 1500, unrealized_gain: 500 }),
      pos({ account_id: 2, account_name: "Acct Two", quantity: -40, cost_basis: -800, current_value: -600, unrealized_gain: 200 }),
    ]);
    expect(r.mixed).toBe(true);
    expect(r.long).toMatchObject({ totalCostBasis: 1000, totalValue: 1500, totalUnrealizedGain: 500, totalGainRatio: 0.5 });
    expect(r.short).toMatchObject({ totalCostBasis: -800, totalValue: -600, totalUnrealizedGain: 200, totalGainRatio: 0.25 });
  });

  it("long-only is not mixed and equals computePositionTotals", () => {
    const rows = [
      pos({ account_id: 1, quantity: 100, cost_basis: 1000, current_value: 1500, unrealized_gain: 500 }),
      pos({ account_id: 2, quantity: 50, cost_basis: 400, current_value: 500, unrealized_gain: 100 }),
    ];
    const r = computePositionSideTotals(rows);
    expect(r.mixed).toBe(false);
    expect(r.short).toBeNull();
    expect(r.long).toEqual(computePositionTotals(rows));
  });

  it("an unknown-basis short does not touch the long side", () => {
    const r = computePositionSideTotals([
      pos({ account_id: 1, quantity: 100, cost_basis: 1000, current_value: 1500, unrealized_gain: 500 }),
      pos({ account_id: 2, account_name: "Acct Two", quantity: -40, cost_basis: null, current_value: -600 }),
    ]);
    expect(r.short!.totalCostBasis).toBeNull();
    expect(r.short!.positionsWithoutBasis.map((p) => p.account_id)).toEqual([2]);
    expect(r.long!.positionsWithoutBasis).toEqual([]);
    expect(r.long!.totalCostBasis).toBe(1000);
  });
});

describe("hub page source: mixed Long / Short total rows", () => {
  const src = readFileSync("app/dashboard/security/[id]/page.tsx", "utf8");
  const start = anchorIndex(src, "{/* Positions */}");
  const end = anchorIndex(src, "{/* Tax Lots */}", start);
  const block = src.slice(start, end);
  const mixedStart = anchorIndex(block, "positionSides.mixed");
  const mixedBranch = block.slice(mixedStart, anchorIndex(block, ") : (", mixedStart));

  it("renders Long and Short labels from positionSides", () => {
    expect(mixedBranch).toContain('label: "Long"');
    expect(mixedBranch).toContain('label: "Short"');
    expect(mixedBranch).toContain("short-sale proceeds");
  });

  it("the mixed branch never reads the netted totals", () => {
    expect(mixedBranch).not.toContain("detail.totalCostBasis");
    expect(mixedBranch).not.toContain("detail.totalValue");
    expect(mixedBranch).not.toContain("detail.totalGainRatio");
  });
});
