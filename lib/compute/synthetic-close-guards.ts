/**
 * Guards shared by the two readers of "is this flat pair closable?":
 *
 *  - computeTaxLots' broker-close pass (lib/compute/tax-lots.ts), which mints
 *    a synthetic RECONCILE_CLOSE from statement-grade zero evidence, and
 *  - getPendingStatementPairs (lib/queries/pending-statement.ts), which
 *    reports the pairs flat only in LIVE data as "pending statement"
 *    (spec docs/superpowers/specs/2026-10-02-statement-only-synthetic-closes-design.md §2.2).
 *
 * Both must agree on the same universe, so the guards live here once.
 * Pure module: no database handle, no imports from either consumer.
 */

/**
 * Transaction types that change a position. An imported one dated AFTER a
 * zero-holdings row means the snapshot is staler than the ledger, so the
 * zero row is not evidence of a close. Lower-case; compare with
 * `LOWER(t.type)`. Constant strings (no quotes/wildcards), safe to inline.
 */
export const POSITION_CHANGING_TXN_TYPES = [
  "buy",
  "reinvestment",
  "buy_to_open",
  "sell_to_open",
  "sell",
  "sell_to_close",
  "redemption",
  "buy_to_cover",
  "expired",
  "exercised",
  "assigned",
  "buy_to_close",
] as const;

/** SQL `IN (...)` list body for POSITION_CHANGING_TXN_TYPES. */
export function positionChangingTxnTypesSql(): string {
  return POSITION_CHANGING_TXN_TYPES.map((t) => `'${t}'`).join(", ");
}

/**
 * The `corporate_actions.action_type` values that are share splits, as a SQL
 * `IN (...)` list body. Compare with `UPPER(action_type)`. The engine's split
 * replay and the pending-statement split guard both read import-sourced rows
 * through this list, so a future non-split action type (MERGER, SPINOFF) is
 * neither replayed as a split nor allowed to trip the split guard.
 */
export const IMPORT_SPLIT_ACTION_TYPES_SQL = "'SPLIT', 'REVERSE_SPLIT'";

/** The minimal shape of an import-sourced split row the split guard reads. */
export interface ImportSplitDate {
  security_id: number;
  effective_date: string;
}

/**
 * Split guard: an import-sourced split (corporate_actions.source = 'import')
 * on the security effective AFTER the zero date means the open lots are in
 * POST-split units while the zero row's date sits on the pre-split basis.
 * The engine skips the synthetic close (never mix bases); the pending read
 * model skips the pair too, so both report the same set. Returns the first
 * such split, or undefined.
 */
export function findLaterImportSplit<T extends ImportSplitDate>(
  splits: readonly T[],
  securityId: number,
  zeroDate: string
): T | undefined {
  return splits.find((ev) => ev.security_id === securityId && ev.effective_date > zeroDate);
}
