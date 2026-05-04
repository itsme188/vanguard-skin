import type Database from "better-sqlite3";
import type { Account } from "@/lib/types";

export function getAllAccounts(db: Database.Database): Account[] {
  return db.prepare("SELECT id, name FROM accounts ORDER BY id").all() as Account[];
}

export function getAccountByName(db: Database.Database, name: string): Account | null {
  return (db.prepare("SELECT id, name FROM accounts WHERE name = ?").get(name) as Account) ?? null;
}

export function getAccountById(db: Database.Database, id: number): Account | null {
  return (db.prepare("SELECT id, name FROM accounts WHERE id = ?").get(id) as Account) ?? null;
}

/**
 * Resolve a scope string ("vanguard", "ibkr", "roth", "all") to account IDs.
 * Returns undefined for "all" or when no matching accounts are found
 * (meaning: use all accounts).
 *
 * Scopes are disjoint: "vanguard" excludes "roth" so that Vanguard + Roth +
 * IBKR partition the portfolio. Otherwise selecting "Vanguard" would silently
 * include Roth holdings, making the Roth scope redundant.
 */
export function resolveScope(
  db: Database.Database,
  scope: string | null | undefined
): number[] | undefined {
  if (!scope || scope === "all") return undefined;
  const needle = scope.toLowerCase();
  const accounts = getAllAccounts(db);
  const ids = accounts
    .filter((a) => {
      const name = a.name.toLowerCase();
      if (needle === "vanguard") return name.includes("vanguard") && !name.includes("roth");
      return name.includes(needle);
    })
    .map((a) => a.id);
  return ids.length > 0 ? ids : undefined;
}

/**
 * Resolve scope to a single accountId for APIs that only accept one.
 * Returns the first matching account ID, or undefined for "all".
 */
export function resolveScopeToSingleId(
  db: Database.Database,
  scope: string | null | undefined
): number | undefined {
  const ids = resolveScope(db, scope);
  return ids?.[0];
}
