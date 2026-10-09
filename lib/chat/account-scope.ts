import type Database from "better-sqlite3";
import { resolveScope } from "@/lib/queries/accounts";

/**
 * Resolve a chat tool's `account_name` to the account ids it names.
 *
 * An exact account name is that one account. Anything else is read as a
 * scope word through `resolveScope` (the same resolver the Performance page
 * and /api/compute/* use), so "ibkr" or "vanguard" is the scope's WHOLE id
 * list, never its first account. Undefined means every account: no name was
 * given, or nothing matched (the same fallback the single-id resolver had).
 *
 * Takes `db` as a parameter and imports nothing from lib/chat/tools, so the
 * tool dispatcher can import it without a cycle.
 */
export function resolveAccountScopeIds(
  db: Database.Database,
  accountName: string | undefined,
): number[] | undefined {
  if (!accountName) return undefined;
  const exact = db.prepare("SELECT id FROM accounts WHERE name = ?").get(accountName) as
    | { id: number }
    | undefined;
  if (exact) return [exact.id];
  return resolveScope(db, accountName);
}
