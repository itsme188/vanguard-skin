import type { PlaidAccount } from "./client";

// Plaid subtypes that identify a taxable investment account. Deliberately
// narrow: the 2026-07-11 sandbox E2E proved an unguarded else-branch maps
// EVERY non-roth account in the Item (checking, mortgage, student loan…)
// onto the taxable Vanguard account — one sync would then write foreign
// holdings into it. Under-map and let the user finish the mapping in
// Settings; never over-map.
const TAXABLE_INVESTMENT_SUBTYPES = new Set(["brokerage", "mutual fund", "non-taxable brokerage account"]);
const ROTH_SUBTYPES = new Set(["roth", "roth 401k", "roth ira"]);

// Auto-match Plaid accounts to local accounts rows. Mirrors resolveScope's
// disjointness rule: "vanguard" means vanguard-and-NOT-roth.
export function proposeAccountMap(
  plaidAccounts: PlaidAccount[],
  localAccounts: { id: number; name: string }[],
): Record<string, number> {
  const rothLocal = localAccounts.find((a) => a.name.toLowerCase().includes("roth"));
  const vanguardLocal = localAccounts.find((a) => {
    const n = a.name.toLowerCase();
    return n.includes("vanguard") && !n.includes("roth");
  });
  const map: Record<string, number> = {};
  for (const pa of plaidAccounts) {
    const subtype = (pa.subtype ?? "").toLowerCase();
    const label = `${pa.name} ${subtype}`.toLowerCase();
    if (ROTH_SUBTYPES.has(subtype) || label.includes("roth")) {
      if (rothLocal) map[pa.account_id] = rothLocal.id;
    } else if (TAXABLE_INVESTMENT_SUBTYPES.has(subtype)) {
      if (vanguardLocal) map[pa.account_id] = vanguardLocal.id;
    }
    // Anything else (checking, savings, credit, loans, plain "ira", …)
    // stays unmapped — the Settings mapping UI is the completion path.
  }
  return map;
}
