import { describe, it, expect } from "vitest";
import { proposeAccountMap } from "@/lib/plaid/map-accounts";
import type { PlaidAccount } from "@/lib/plaid/client";

function pa(id: string, name: string, subtype: string | null): PlaidAccount {
  return { account_id: id, name, mask: null, subtype, balances: { current: null, available: null } };
}

describe("proposeAccountMap", () => {
  const locals = [
    { id: 1, name: "Vanguard Taxable" },
    { id: 2, name: "Vanguard Roth IRA" },
    { id: 3, name: "IBKR" },
  ];

  it("maps roth plaid account to local roth, brokerage to vanguard non-roth", () => {
    const map = proposeAccountMap(
      [pa("pA", "Roth IRA Brokerage", "roth"), pa("pB", "Individual Brokerage", "brokerage")],
      locals,
    );
    expect(map).toEqual({ pA: 2, pB: 1 });
  });

  it("omits plaid accounts with no local match", () => {
    const map = proposeAccountMap([pa("pC", "529 Plan", "529")], [{ id: 3, name: "IBKR" }]);
    expect(map).toEqual({});
  });
});
