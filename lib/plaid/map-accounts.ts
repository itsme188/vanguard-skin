import type { PlaidAccount } from "./client";

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
    const label = `${pa.name} ${pa.subtype ?? ""}`.toLowerCase();
    const target = label.includes("roth") ? rothLocal : vanguardLocal;
    if (target) map[pa.account_id] = target.id;
  }
  return map;
}
