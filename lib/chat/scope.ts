import type Database from "better-sqlite3";
import type { ChatScope } from "@/lib/types";
import { resolveAccountName } from "@/lib/chat/tools";

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
 * data in a scoped chat. Genuinely global tools (FRED, research, market
 * snapshot, calendar) have no `account_name` and pass through unchanged, as do
 * the `all` and `macro` scopes (where there is no single account to clamp to).
 */

const SCOPE_ACCOUNT_HINT: Partial<Record<ChatScope, string>> = {
  ibkr: "IBKR",
  "vanguard-taxable": "Vanguard Taxable",
  "vanguard-roth-ira": "Vanguard Roth IRA",
};

/**
 * Resolve a single-account chat scope to its exact DB account name. Returns
 * undefined for the `all` and `macro` scopes (and any scope without an account
 * hint), meaning "no clamp — the model may query across accounts."
 */
export function scopeToAccountName(
  db: Database.Database,
  scope: ChatScope,
): string | undefined {
  const hint = SCOPE_ACCOUNT_HINT[scope];
  return hint ? resolveAccountName(db, hint) : undefined;
}

interface ToolSchemaLike {
  properties?: Record<string, unknown>;
}

/**
 * Hard-clamp a chat tool's input to the active account scope.
 *
 * When `scopeAccountName` is set (a single-account scope) AND the tool accepts
 * an `account_name`, force `account_name` to the scope's account — OVERRIDING
 * any model-supplied value. Otherwise return the input unchanged.
 */
export function clampToolInputToScope(
  input: Record<string, unknown>,
  toolSchema: ToolSchemaLike | undefined,
  scopeAccountName: string | undefined,
): Record<string, unknown> {
  if (scopeAccountName && toolSchema?.properties?.account_name) {
    return { ...input, account_name: scopeAccountName };
  }
  return input;
}
