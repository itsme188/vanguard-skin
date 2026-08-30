/**
 * Single source of truth for the "latest holdings" SQL predicate. Two shapes
 * coexist:
 *
 *   - keyBy: "account"          — picks the latest as_of_date per account
 *                                 across ALL securities. LEGACY shape: as of
 *                                 the 2026-08-30 holdings-latest sweep its
 *                                 only deliberate user is the data-confidence
 *                                 freshness READOUT (data-confidence.ts) —
 *                                 never use it to select positions (it drops
 *                                 statement-only rows; see DECISIONS.md).
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
 *   const sql = `SELECT ... FROM holdings h WHERE ${latestHoldingsPredicate({ accountFilter, asOfDate: today })}`;
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
 * The asOfDate option, when set, adds BOTH:
 *   - `AND h2.as_of_date <= '<date>'` to the inner subquery
 *   - `AND h.as_of_date <= '<date>'`  to the outer predicate
 * via SQL string literal substitution (NOT positional `?`). This is safe
 * because callers pass `weekAgo(today)` or known statement dates — never
 * user input. The string is validated against `/^\d{4}-\d{2}-\d{2}$/` and
 * throws on mismatch, preventing injection on this rare path. The literal-
 * substitution design avoids the dual-param footgun of the prior `cutoff:
 * true` boolean (caller had to remember to bind the date as a positional
 * param, doubly so once W-o-W call sites needed it in both the inner AND
 * outer constraint).
 */

const AS_OF_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface LatestHoldingsOptions {
  /** Which composite key to use for the "latest" row. Default account_security. */
  keyBy?: "account" | "account_security";
  /** If true, filter quantity != 0 (shorts surface). If false, quantity > 0. Default true. */
  includeShorts?: boolean;
  /**
   * If set (YYYY-MM-DD), constrains both the inner subquery's MAX(as_of_date)
   * lookup AND the outer predicate to dates on or before this value. Used by
   * "as of N days ago" / W-o-W delta call sites. Validated against
   * `/^\d{4}-\d{2}-\d{2}$/`; throws on malformed strings.
   */
  asOfDate?: string;
  /** Pre-built SQL fragment like `AND h.account_id IN (?,?,?)` or empty. */
  accountFilter?: string;
}

export function latestHoldingsPredicate(opts: LatestHoldingsOptions = {}): string {
  const keyBy = opts.keyBy ?? "account_security";
  const includeShorts = opts.includeShorts ?? true;
  const asOfDate = opts.asOfDate;
  const accountFilter = opts.accountFilter ?? "";

  if (asOfDate !== undefined) {
    if (!AS_OF_DATE_PATTERN.test(asOfDate)) {
      throw new Error(
        `latestHoldingsPredicate: asOfDate must match YYYY-MM-DD, got ${JSON.stringify(asOfDate)}`
      );
    }
  }

  const innerKey =
    keyBy === "account_security"
      ? "WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id"
      : "WHERE h2.account_id = h.account_id";
  const innerAsOfClause = asOfDate ? `AND h2.as_of_date <= '${asOfDate}'` : "";
  const outerAsOfClause = asOfDate ? `AND h.as_of_date <= '${asOfDate}'` : "";
  const qtyClause = includeShorts ? "h.quantity != 0" : "h.quantity > 0";

  return `h.as_of_date = (
        SELECT MAX(h2.as_of_date) FROM holdings h2
        ${innerKey}
        ${innerAsOfClause}
      ) ${outerAsOfClause} AND ${qtyClause} ${accountFilter}`;
}
