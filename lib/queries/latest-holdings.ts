/**
 * Single source of truth for the "latest holdings" SQL predicate. Two shapes
 * coexist:
 *
 *   - keyBy: "account"          — picks the latest as_of_date per account
 *                                 across ALL securities. Used by allocation
 *                                 queries (analysis.ts) where stale
 *                                 per-security rows wash out via outer SUM.
 *
 *   - keyBy: "account_security" — picks the latest as_of_date per (account,
 *                                 security) pair. Required by per-position
 *                                 compute (Greeks, expirations, exposure
 *                                 delta) so that an IBKR intra-day TWS row
 *                                 doesn't silently mask Vanguard statement
 *                                 holdings whose as_of_date is older.
 *
 * Caller wraps the predicate inside a CTE OR drops it directly into a WHERE.
 *
 * @example inline WHERE (compute/options-greeks)
 *   const sql = `SELECT ... FROM holdings h WHERE ${latestHoldingsPredicate({ accountFilter, cutoff: true })}`;
 *
 * @example CTE wrap (compute/exposure-delta)
 *   const sql = `
 *     WITH latest_holdings AS (
 *       SELECT h.* FROM holdings h
 *       WHERE ${latestHoldingsPredicate({ accountFilter })}
 *     )
 *     SELECT ...
 *   `;
 *
 * The cutoff:true flag adds an extra `AND h2.as_of_date <= ?` to the inner
 * subquery — the caller binds the date as the FIRST positional param of the
 * outer query (followed by accountFilter params, then any others).
 */

export interface LatestHoldingsOptions {
  /** Which composite key to use for the "latest" row. Default account_security. */
  keyBy?: "account" | "account_security";
  /** If true, filter quantity != 0 (shorts surface). If false, quantity > 0. Default true. */
  includeShorts?: boolean;
  /** If true, adds `AND h2.as_of_date <= ?` to the inner subquery. Default false. */
  cutoff?: boolean;
  /** Pre-built SQL fragment like `AND h.account_id IN (?,?,?)` or empty. */
  accountFilter?: string;
}

export function latestHoldingsPredicate(opts: LatestHoldingsOptions = {}): string {
  const keyBy = opts.keyBy ?? "account_security";
  const includeShorts = opts.includeShorts ?? true;
  const cutoff = opts.cutoff ?? false;
  const accountFilter = opts.accountFilter ?? "";

  const innerKey =
    keyBy === "account_security"
      ? "WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id"
      : "WHERE h2.account_id = h.account_id";
  const cutoffClause = cutoff ? "AND h2.as_of_date <= ?" : "";
  const qtyClause = includeShorts ? "h.quantity != 0" : "h.quantity > 0";

  return `h.as_of_date = (
        SELECT MAX(h2.as_of_date) FROM holdings h2
        ${innerKey}
        ${cutoffClause}
      ) AND ${qtyClause} ${accountFilter}`;
}
