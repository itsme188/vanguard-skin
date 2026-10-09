import { describe, it, expect } from "vitest";
import { computeBasisDisagreements } from "@/lib/compute/lot-coverage";

const pos = (over = {}) => ({
  account_id: 1,
  account_name: "Taxable",
  quantity: 100,
  cost_basis: 10000 as number | null,
  ...over,
});
const lot = (over = {}) => ({
  account_id: 1,
  quantity_remaining: 100,
  is_short: 0,
  adjusted_cost_basis: 10000 as number | null,
  pending_statement: false,
  expired_option: false,
  ...over,
});

describe("computeBasisDisagreements", () => {
  it("is empty when lot basis equals the holding basis", () => {
    expect(computeBasisDisagreements([pos()], [lot()])).toEqual([]);
  });

  it("reports the signed difference (lots minus holding) when fully covered and beyond tolerance", () => {
    const out = computeBasisDisagreements(
      [pos()],
      [lot({ quantity_remaining: 60, adjusted_cost_basis: 6000 }), lot({ quantity_remaining: 40, adjusted_cost_basis: 4500 })]
    );
    expect(out).toEqual([
      { accountId: 1, accountName: "Taxable", holdingBasis: 10000, lotBasis: 10500, difference: 500 },
    ]);
  });

  it("ignores a gap inside 0.5% of the holding basis", () => {
    expect(computeBasisDisagreements([pos()], [lot({ adjusted_cost_basis: 10049 })])).toEqual([]);
    expect(computeBasisDisagreements([pos()], [lot({ adjusted_cost_basis: 10051 })])).toHaveLength(1);
  });

  it("uses 1.00 as the floor for a small basis", () => {
    const p = pos({ quantity: 1, cost_basis: 50 });
    expect(computeBasisDisagreements([p], [lot({ quantity_remaining: 1, adjusted_cost_basis: 50.9 })])).toEqual([]);
    expect(computeBasisDisagreements([p], [lot({ quantity_remaining: 1, adjusted_cost_basis: 51.5 })])).toHaveLength(1);
  });

  it("scales the 1.00 floor by the currency factor", () => {
    const p = pos({ quantity: 1, cost_basis: 50 });
    const l = lot({ quantity_remaining: 1, adjusted_cost_basis: 52.5 });
    expect(computeBasisDisagreements([p], [l])).toHaveLength(1);
    expect(computeBasisDisagreements([p], [l], { usdPerUnit: 3 })).toEqual([]);
  });

  it("skips an account with a quantity gap (the coverage note owns it)", () => {
    expect(
      computeBasisDisagreements([pos()], [lot({ quantity_remaining: 80, adjusted_cost_basis: 9000 })])
    ).toEqual([]);
  });

  it("skips a position with no known basis", () => {
    expect(computeBasisDisagreements([pos({ cost_basis: null })], [lot({ adjusted_cost_basis: 500 })])).toEqual([]);
    expect(computeBasisDisagreements([pos({ cost_basis: 0 })], [lot({ adjusted_cost_basis: 500 })])).toEqual([]);
  });

  it("skips a pair with a pending-statement lot or an expired-option lot", () => {
    expect(computeBasisDisagreements([pos()], [lot({ adjusted_cost_basis: 12000, pending_statement: true })])).toEqual([]);
    expect(computeBasisDisagreements([pos()], [lot({ adjusted_cost_basis: 12000, expired_option: true })])).toEqual([]);
  });

  it("skips when a lot carries no basis", () => {
    expect(computeBasisDisagreements([pos()], [lot({ adjusted_cost_basis: null })])).toEqual([]);
  });

  it("compares per account, never summed across accounts", () => {
    const out = computeBasisDisagreements(
      [pos(), pos({ account_id: 2, account_name: "Roth" })],
      [lot(), lot({ account_id: 2, adjusted_cost_basis: 11000 })]
    );
    expect(out.map((o) => o.accountId)).toEqual([2]);
  });

  it("compares absolute values for a short and only counts short lots", () => {
    const short = pos({ quantity: -50, cost_basis: -5000 });
    const out = computeBasisDisagreements(
      [short],
      [lot({ quantity_remaining: 50, is_short: 1, adjusted_cost_basis: 5600 }), lot({ adjusted_cost_basis: 99999 })]
    );
    expect(out).toEqual([
      { accountId: 1, accountName: "Taxable", holdingBasis: 5000, lotBasis: 5600, difference: 600 },
    ]);
  });
});
