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

  it("never auto-maps non-investment accounts to the taxable slot (2026-07-11 sandbox E2E regression)", () => {
    // A full sandbox Item: 12 accounts of which none are brokerage/roth.
    // The pre-fix else-branch mapped ALL of these onto Vanguard Taxable —
    // one sync would have written checking/mortgage "holdings" into the
    // real account. All must stay unmapped.
    const sandboxItem = [
      pa("s1", "Plaid Checking", "checking"),
      pa("s2", "Plaid Saving", "savings"),
      pa("s3", "Plaid CD", "cd"),
      pa("s4", "Plaid Credit Card", "credit card"),
      pa("s5", "Plaid Money Market", "money market"),
      pa("s6", "Plaid IRA", "ira"),
      pa("s7", "Plaid 401k", "401k"),
      pa("s8", "Plaid Student Loan", "student"),
      pa("s9", "Plaid Mortgage", "mortgage"),
      pa("s10", "Plaid HSA", "hsa"),
      pa("s11", "Plaid Cash Management", "cash management"),
      pa("s12", "Plaid Business Credit Card", "credit card"),
    ];
    expect(proposeAccountMap(sandboxItem, locals)).toEqual({});
  });

  it("maps a mutual-fund-subtype account to the taxable slot (legacy Vanguard account shape)", () => {
    const map = proposeAccountMap([pa("pM", "Vanguard Brokerage Account", "mutual fund")], locals);
    expect(map).toEqual({ pM: 1 });
  });
});
