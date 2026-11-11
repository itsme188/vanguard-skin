/**
 * Shared pieces of the composite chat tools (Portfolio Assistant plan, Task 6).
 *
 * A composite tool is a thin, read-only wrapper over an engine the dashboard
 * already calls. It never recomputes a figure: it picks fields from the
 * engine's result, names their units, and states what the engine left out.
 *
 * Scope (plan Contract H): `ctx.accountIds` is the resolved account id list
 * from the dispatcher. `undefined` = every account; `[]` = no account, which
 * is answered here before any engine runs (some engines read an empty list
 * as the whole book). Account names printed in a result come only from the
 * ids in scope, so a single-account chat never sees another account's name.
 */
import type Database from "better-sqlite3";
import type Anthropic from "@anthropic-ai/sdk";

/** What the dispatcher hands every composite runner. */
export interface CompositeContext {
  /** Resolved account ids. `undefined` = every account; `[]` = none. */
  accountIds: number[] | undefined;
  /** The one account's exact name when the scope is exactly one account. */
  accountName?: string;
  /** The Eastern calendar day (`todayET()`), YYYY-MM-DD. */
  today: string;
  /** Clock for engines that take one (tests pin it). Defaults to the real clock. */
  now?: Date;
}

/** Same shape as a `CHAT_TOOLS` entry (an Anthropic-format tool). */
export type CompositeToolDefinition = Anthropic.Tool;

export type CompositeRunner = (
  db: Database.Database,
  input: Record<string, unknown>,
  ctx: CompositeContext,
) => unknown;

export interface CompositeTool {
  definition: CompositeToolDefinition;
  run: CompositeRunner;
  /** True when the engine takes an account id LIST (a multi-account scope is answered whole). */
  acceptsScopeList: boolean;
}

/** Every composite result stays under this many characters of JSON (plan Task 6). */
export const COMPOSITE_MAX_JSON_CHARS = 6000;

export const NO_ACCOUNT_IN_SCOPE = { error: "No account is in this chat's scope." } as const;

/** The `account_name` schema field every composite tool declares, so the scope clamp applies. */
export const ACCOUNT_NAME_FIELD = {
  type: "string",
  description:
    "Optional. An exact account name, or a scope word: 'vanguard' (the Vanguard accounts EXCLUDING the Roth), 'roth', 'ibkr', or 'all'. Omit for every account.",
} as const;

export interface ScopeBlock {
  all_accounts: boolean;
  account_names: string[];
}

/** The scope a result describes, naming only accounts inside it. */
export function scopeBlock(db: Database.Database, accountIds: number[] | undefined): ScopeBlock {
  if (accountIds === undefined) {
    const rows = db.prepare("SELECT name FROM accounts ORDER BY id").all() as { name: string }[];
    return { all_accounts: true, account_names: rows.map((r) => r.name) };
  }
  return { all_accounts: false, account_names: accountNamesFor(db, accountIds) };
}

/** Names of exactly these account ids, in id order. */
export function accountNamesFor(db: Database.Database, accountIds: number[]): string[] {
  if (accountIds.length === 0) return [];
  const rows = db
    .prepare(`SELECT name FROM accounts WHERE id IN (${accountIds.map(() => "?").join(",")}) ORDER BY id`)
    .all(...accountIds) as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * The refusal a one-account-or-all engine gives a scope of several accounts.
 * It names only the accounts in that scope.
 */
export function oneAccountOnlyError(
  db: Database.Database,
  accountIds: number[],
  what: string,
): { error: string } {
  const names = accountNamesFor(db, accountIds).map((n) => `"${n}"`).join(", ");
  return {
    error: `${what} reads one account at a time, or every account. This scope holds ${accountIds.length} accounts (${names}). Call the tool once per account with account_name set to one exact name.`,
  };
}

/** True for a YYYY-MM-DD string naming a real calendar day (2026-13-45 is not one). */
export function isRealIsoDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const [y, m, d] = raw.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * An optional date parameter. Absent (undefined, null or "") is no value;
 * anything else must be a real YYYY-MM-DD day, or it is an error naming the
 * parameter, so the model can correct the call.
 */
export function readDateParam(raw: unknown, name: string): { value?: string; error?: string } {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw === "string" && isRealIsoDate(raw)) return { value: raw };
  return { error: `${name} must be a real calendar date written YYYY-MM-DD (for example 2026-09-30).` };
}

/** A model-supplied count: an integer from 1 up, else the default; above `max` is `max`. */
export function readCount(raw: unknown, def: number, max: number): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return def;
  return Math.min(raw, max);
}

export interface CompositeListInfo {
  returned: number;
  limit: number;
  truncated: boolean;
  note?: string;
}

/** Contract G: cut a list to `limit` and say whether more rows existed. */
export function takeList<T>(rows: T[], limit: number, max: number): { rows: T[]; info: CompositeListInfo } {
  const truncated = rows.length > limit;
  const kept = truncated ? rows.slice(0, limit) : rows;
  return {
    rows: kept,
    info: truncated
      ? {
          returned: kept.length,
          limit,
          truncated: true,
          note: `More rows match (${rows.length} in all). Narrow the filter or raise limit (max ${max}).`,
        }
      : { returned: kept.length, limit, truncated: false },
  };
}
