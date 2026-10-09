/**
 * Account-scope SQL, one rule for every reader that takes a resolved account
 * list (adopted 2026-10-08):
 *
 *   - `undefined` means EVERY account: no filter at all;
 *   - a DEFINED EMPTY list means NO accounts: the filter matches no row. It
 *     must never widen to the whole book;
 *   - a non-empty list is `<column> IN (?, ?, ...)`.
 *
 * Same rule as `accountIdsFilterSql` (lib/compute/factors.ts) and
 * `accountScopeClause` (lib/queries/options.ts). This copy lives in a module
 * with NO imports so lib/queries/analysis.ts (which lib/compute/factors.ts
 * imports) and every compute module can use it without an import cycle, and
 * it takes the column so it also serves `ms.account_id`, `a.id` and a bare
 * `account_id`.
 *
 * Pure: builds text and bind values, touches no database.
 */

export interface AccountScopeSql {
  /**
   * The bare predicate (no leading AND/WHERE), or `null` when the scope is
   * every account and nothing should be filtered. `"0"` for an empty list.
   */
  condition: string | null;
  /** Bind values for the predicate's placeholders, in order. */
  params: number[];
}

/**
 * The bare predicate for a scope, for callers that assemble their own
 * `WHERE` / `conditions.join(" AND ")`.
 */
export function accountScopeCondition(
  accountIds: readonly number[] | undefined,
  column = "h.account_id",
): AccountScopeSql {
  if (accountIds === undefined) return { condition: null, params: [] };
  if (accountIds.length === 0) return { condition: "0", params: [] };
  return {
    condition: `${column} IN (${accountIds.map(() => "?").join(",")})`,
    params: [...accountIds],
  };
}

/**
 * The `AND <column> IN (...)` fragment for a scope, with its bind values:
 * `""` for every account, `AND 0` for an empty list.
 */
export function accountScopeAndSql(
  accountIds: readonly number[] | undefined,
  column = "h.account_id",
): { sql: string; params: number[] } {
  const { condition, params } = accountScopeCondition(accountIds, column);
  return { sql: condition === null ? "" : `AND ${condition}`, params };
}
