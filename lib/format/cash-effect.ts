// Mirrors lib/import/parsers/canonical-csv.ts's BUY_FAMILY_TYPES /
// SELL_FAMILY_TYPES (kept as a separate literal copy — that file's sets are
// module-private and scoped to the import-time signed-cash-effect
// normalization, a different concern from this display-time fix).
const BUY_FAMILY_TYPES = new Set(["BUY", "BUY_TO_OPEN", "BUY_TO_CLOSE", "BUY_TO_COVER"]);
const SELL_FAMILY_TYPES = new Set(["SELL", "SELL_TO_CLOSE", "SELL_TO_OPEN"]);

/**
 * Display-only cash-effect sign normalization (QA:
 * security-detail-transactions--buy-amount-sign-convention-differs-by-source-regression-1).
 * Vanguard canonical imports historically stored principal UNSIGNED while
 * IBKR imports store a signed cash flow, so adjacent BUY rows in this same
 * column rendered with opposite signs for the identical action. Never
 * rewrites stored data (transactions.amount stays exactly as imported) —
 * this only fixes what the table PRINTS: a BUY is always a cash outflow
 * (negative) and a SELL is always a cash inflow (positive), regardless of
 * which source or era the row came from.
 */
export function displayCashEffect(type: string, amount: number | null): number | null {
  if (amount == null || !Number.isFinite(amount)) return amount;
  // `|| 0` normalizes the zero-amount case: -Math.abs(0) is -0, which would
  // otherwise silently disagree with a plain `0` under Object.is/toBe.
  if (BUY_FAMILY_TYPES.has(type)) return -Math.abs(amount) || 0;
  if (SELL_FAMILY_TYPES.has(type)) return Math.abs(amount);
  return amount;
}
