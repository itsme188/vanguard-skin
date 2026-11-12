/**
 * What currency a transaction row's `amount` (and `price_per_share`, `fees`)
 * is stored in: the ONE rule, read by the chat (lib/queries/chat-tools.ts,
 * lib/queries/portfolio-summary.ts) and the dashboard transaction readers
 * (lib/queries/transactions.ts, lib/queries/security-detail.ts).
 *
 * - A trade leg (the IBKR Trades section's Proceeds, a transfer's market
 *   value) is stored in the security's NATIVE currency. The lot engine reads
 *   it native and converts at read time (lib/compute/tax-lots.ts).
 * - The IBKR cash sections (Dividends, Interest, Fees, Deposits &
 *   Withdrawals) are converted to USD at import through IBKR's own
 *   "Total in USD" line, keeping the native figure in the note
 *   (`emitCurrencyBlocks`, lib/import/parsers/ibkr-activity.ts); the income
 *   readers sum them as dollars (lib/queries/income-sql.ts). Withholding is
 *   Vanguard-only (USD). Converting one of these again by the security's
 *   rate showed a 40-dollar dividend on a yen stock as 26 cents.
 * - A row with no security is USD.
 *
 * History (checked 2026-11-12): before 2026-10-05 the Dividends and Fees
 * loops stored a non-USD row at its printed native magnitude, with no note.
 * The live ledger held no dividend, interest, fee, deposit, withdrawal or
 * withholding row on a non-USD security at that check, so no stored row is
 * mislabelled. A converted row carries "converted at IBKR's Total-in-USD
 * rate" in its note if one is ever needed to tell them apart.
 *
 * Import-free on purpose (plain SQL text).
 */

export const USD_STORED_TRANSACTION_TYPES = ["DIVIDEND", "INTEREST", "FEE", "DEPOSIT", "WITHDRAWAL", "TAX_WITHHELD"] as const;

/** The stored currency of a row. Aliases: `t` transactions, `s` securities (LEFT JOIN). */
export function transactionAmountCurrencySql(t = "t", s = "s"): string {
  const usdTypes = USD_STORED_TRANSACTION_TYPES.map((x) => `'${x}'`).join(", ");
  return `(CASE WHEN ${s}.id IS NULL OR UPPER(${t}.type) IN (${usdTypes}) THEN 'USD'
            ELSE UPPER(COALESCE(${s}.currency, 'USD')) END)`;
}

/**
 * The dashboard's factor from a row's stored figures to USD: 1 for a
 * USD-stored row, else the rate, with a missing rate read as 1.0 (the repo's
 * `COALESCE(fx.usd_per_unit, 1)` convention). Expects `fx` joined as
 * `LEFT JOIN fx_rates fx ON fx.currency = s.currency`.
 */
export function transactionUsdFactorSql(t = "t", s = "s", fx = "fx"): string {
  return `(CASE WHEN ${transactionAmountCurrencySql(t, s)} = 'USD' THEN 1 ELSE COALESCE(${fx}.usd_per_unit, 1) END)`;
}

/**
 * The chat's `amount` in USD: the amount itself for USD, null when no rate is
 * on file (never the native number read as dollars). Same `fx` join.
 */
export function transactionAmountUsdSql(t = "t", s = "s", fx = "fx"): string {
  const cur = transactionAmountCurrencySql(t, s);
  return `(CASE WHEN ${t}.amount IS NULL THEN NULL
            WHEN ${cur} = 'USD' THEN ${t}.amount
            WHEN ${fx}.usd_per_unit IS NOT NULL THEN ${t}.amount * ${fx}.usd_per_unit
            ELSE NULL END)`;
}
