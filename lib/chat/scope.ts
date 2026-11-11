import type Database from "better-sqlite3";
import type { ChatScope } from "@/lib/types";
import { getAllAccounts, resolveScope } from "@/lib/queries/accounts";
import { resolveChatAccounts, type ChatAccount } from "@/lib/chat/account-scope";

/**
 * Chat account-scope enforcement.
 *
 * A chat conversation carries a `scope` (all | macro | one specific account).
 * Historically scope was ADVISORY: the route filled a tool's `account_name`
 * only when the model left it blank, so the model could widen a single-account
 * chat by passing a different `account_name`, and the system prompt's persona
 * even invited cross-account comparison. Result: a Vanguard-scoped chat leaked
 * IBKR positions (U2c).
 *
 * These helpers make scope an ENFORCED boundary. When a single-account scope is
 * active, `clampToolInputToScope` HARD-OVERRIDES `account_name` to the scope's
 * account for every tool that accepts one — overriding any model-supplied value,
 * not just blanks. The model literally cannot query another account's portfolio
 * data in a scoped chat. Genuinely global tools (FRED, research, calendar)
 * have no `account_name` and pass through unchanged (the market snapshot is
 * NOT one of them since 2026-10-08: its held rows carry account, quantity and
 * value, so it declares `account_name` and is clamped like the rest), as do
 * the `all` and `macro` scopes (where there is no single account to clamp to).
 */

/**
 * The scope word each single-account chat scope resolves through (P10). A
 * chat scope is resolved by its scope WORD through `resolveScope`, never by
 * exact account name: an account called "IBKR" beside "IBKR Two" must not
 * collapse the IBKR scope to one account. The taxable scope's word is
 * "vanguard", which `resolveScope` already reads as "Vanguard, not the Roth".
 */
const SCOPE_WORD: Partial<Record<ChatScope, string>> = {
  ibkr: "ibkr",
  "vanguard-taxable": "vanguard",
  "vanguard-roth-ira": "roth",
};

export type ChatScopeResolution =
  /** `all` and `macro`: every account (no clamp). */
  | { kind: "all" }
  /** A single-account scope: its whole id list (one or more accounts). */
  | { kind: "accounts"; accounts: ChatAccount[] }
  /** A single-account scope that matches no account: read nothing. */
  | { kind: "none" };

/**
 * Resolve a chat scope to the accounts it reads (plan Contract I, P1, P10).
 * A scope whose word matches no account is `none`, never every account.
 */
export function resolveChatScope(db: Database.Database, scope: ChatScope): ChatScopeResolution {
  const word = SCOPE_WORD[scope];
  if (!word) return { kind: "all" };
  const ids = resolveScope(db, word);
  if (!ids || ids.length === 0) return { kind: "none" };
  const accounts = getAllAccounts(db)
    .filter((a) => ids.includes(a.id))
    .map((a) => ({ id: a.id, name: a.name }));
  return accounts.length > 0 ? { kind: "accounts", accounts } : { kind: "none" };
}

/**
 * The scope's account ids for the readers: `undefined` = every account, `[]`
 * = none (the repo's account-scope rule).
 */
export function chatScopeAccountIds(resolution: ChatScopeResolution): number[] | undefined {
  if (resolution.kind === "all") return undefined;
  if (resolution.kind === "none") return [];
  return resolution.accounts.map((a) => a.id);
}

/**
 * The `account_name` a single-account scope forces onto every account-bearing
 * tool. Returns undefined for the `all` and `macro` scopes, meaning "no clamp:
 * the model may query across accounts."
 *
 * One account in scope: its exact DB name. Several accounts, or none: the
 * scope word, which the dispatcher resolves to the scope's whole id list (a
 * one-account tool then answers with its per-account error) or to an error
 * naming no account. Never the whole book.
 */
export function scopeToAccountName(
  db: Database.Database,
  scope: ChatScope,
): string | undefined {
  return scopeClampName(scope, resolveChatScope(db, scope));
}

export function scopeClampName(scope: ChatScope, resolution: ChatScopeResolution): string | undefined {
  const word = SCOPE_WORD[scope];
  if (!word || resolution.kind === "all") return undefined;
  if (resolution.kind === "accounts" && resolution.accounts.length === 1) {
    return resolution.accounts[0].name;
  }
  return word;
}

interface ToolSchemaLike {
  properties?: Record<string, unknown>;
}

/** The scope's id list, so a narrower model-supplied account can be kept (P2). */
export interface ClampScopeIds {
  db: Database.Database;
  accountIds: readonly number[];
}

/**
 * Hard-clamp a chat tool's input to the active account scope.
 *
 * When `scopeAccountName` is set (a single-account scope) AND the tool accepts
 * an `account_name`, force `account_name` to the scope — OVERRIDING any
 * model-supplied value. One exception (P2): when the scope covers several
 * accounts and `scope` is passed, a model-supplied `account_name` that
 * resolves to a non-empty SUBSET of the scope's ids is kept, so a two-account
 * IBKR chat can still call a one-account tool for one of its accounts.
 * Otherwise return the input unchanged.
 */
export function clampToolInputToScope(
  input: Record<string, unknown>,
  toolSchema: ToolSchemaLike | undefined,
  scopeAccountName: string | undefined,
  scope?: ClampScopeIds,
): Record<string, unknown> {
  if (!scopeAccountName || !toolSchema?.properties?.account_name) return input;

  const supplied = typeof input.account_name === "string" ? input.account_name.trim() : "";
  if (scope && scope.accountIds.length > 1 && supplied) {
    const resolved = resolveChatAccounts(scope.db, supplied);
    if (
      resolved.kind === "accounts" &&
      resolved.accounts.length > 0 &&
      resolved.accounts.every((a) => scope.accountIds.includes(a.id))
    ) {
      return input;
    }
  }
  return { ...input, account_name: scopeAccountName };
}
