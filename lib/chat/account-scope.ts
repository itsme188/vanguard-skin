import type Database from "better-sqlite3";
import { getAllAccounts, resolveScope } from "@/lib/queries/accounts";

/**
 * The scope words a chat tool's `account_name` may carry: the same set the
 * dashboard's scope selector offers. Each one is read through `resolveScope`,
 * so the scopes stay disjoint ("vanguard" EXCLUDES the Roth).
 */
export const CHAT_SCOPE_WORDS = ["vanguard", "roth", "ibkr", "all"] as const;

export interface ChatAccount {
  id: number;
  name: string;
}

export type ChatAccountResolution =
  /** No name, or the word "all": every account. */
  | { kind: "all" }
  /** One account, or a scope's whole list (never its first account). */
  | { kind: "accounts"; accounts: ChatAccount[] }
  /** Ambiguous or unknown: a plain message for the model, listing its options. */
  | { kind: "error"; error: string };

function optionsText(accounts: ChatAccount[]): string {
  const names = accounts.map((a) => `"${a.name}"`).join(", ");
  const words = CHAT_SCOPE_WORDS.map((w) => `"${w}"`).join(", ");
  return `Pass an exact account name (${names}) or a scope word (${words}). If it is not clear which account the user means, ask.`;
}

/**
 * Resolve a chat tool's model-supplied `account_name` to the accounts it
 * names. Order of precedence:
 *
 *  1. an exact account name is that one account (as written first; then in
 *     any letter case, once the scope words have been read);
 *  2. a scope word is that scope's id list, exactly as `resolveScope` gives
 *     it to the Performance page and /api/compute/*;
 *  3. any other text is accepted only when it is part of exactly ONE
 *     account's name;
 *  4. everything else is an error that lists the names and words to use.
 *
 * It never falls back to the first match and never widens to the whole book:
 * a scope word that names no account is an error too.
 *
 * The exact name as written is tried before the scope words so that an
 * account called "IBKR" beside one called "IBKR Two" is still reachable by
 * its own name, while the word "ibkr" stays the whole scope.
 *
 * Takes `db` as a parameter and imports nothing from lib/chat/tools, so the
 * tool dispatcher can import it without a cycle.
 */
export function resolveChatAccounts(
  db: Database.Database,
  accountName: string | undefined,
): ChatAccountResolution {
  const wanted = accountName?.trim();
  if (!wanted) return { kind: "all" };

  const accounts: ChatAccount[] = getAllAccounts(db).map((a) => ({ id: a.id, name: a.name }));
  const needle = wanted.toLowerCase();

  const asWritten = accounts.filter((a) => a.name === wanted);
  if (asWritten.length === 1) return { kind: "accounts", accounts: asWritten };

  if ((CHAT_SCOPE_WORDS as readonly string[]).includes(needle)) {
    if (needle === "all") return { kind: "all" };
    const ids = resolveScope(db, needle);
    if (!ids) {
      return {
        kind: "error",
        error: `No account is in the "${needle}" scope. ${optionsText(accounts)}`,
      };
    }
    return { kind: "accounts", accounts: accounts.filter((a) => ids.includes(a.id)) };
  }

  const anyCase = accounts.filter((a) => a.name.toLowerCase() === needle);
  if (anyCase.length === 1) return { kind: "accounts", accounts: anyCase };

  const partial =
    anyCase.length > 1 ? anyCase : accounts.filter((a) => a.name.toLowerCase().includes(needle));
  if (partial.length === 1) return { kind: "accounts", accounts: partial };

  if (partial.length > 1) {
    const matched = partial.map((a) => `"${a.name}"`).join(", ");
    return {
      kind: "error",
      error: `"${wanted}" matches more than one account (${matched}). ${optionsText(accounts)}`,
    };
  }
  return {
    kind: "error",
    error: `No account matches "${wanted}". ${optionsText(accounts)}`,
  };
}

/**
 * The id list for a chat tool's `account_name`: undefined means every
 * account (no name, or "all"); an ambiguous or unknown name is an EMPTY list,
 * which every scope-aware engine reads as "no accounts", never the whole
 * book. Tools should prefer `resolveChatAccounts` so they can return its
 * error message.
 */
export function resolveAccountScopeIds(
  db: Database.Database,
  accountName: string | undefined,
): number[] | undefined {
  const resolved = resolveChatAccounts(db, accountName);
  if (resolved.kind === "all") return undefined;
  if (resolved.kind === "error") return [];
  return resolved.accounts.map((a) => a.id);
}
