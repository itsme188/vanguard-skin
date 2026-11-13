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
 * - A currency-conversion leg (an IBKR Forex trade, security type Forex,
 *   symbol the pair BASE.QUOTE) is stored in the QUOTE currency, whatever
 *   the security's own currency says (IBKR files these as USD). Its
 *   `quantity` is in BASE units and `price_per_share` is QUOTE per BASE.
 *   So for a USD-base pair the dollar size is the row's own base quantity
 *   (exact, no rate needed; some quote currencies have no fx_rates row),
 *   carrying the amount's sign. A USD-quote pair is already dollars. A pair
 *   with neither side USD has no dollar reading here: the chat says null and
 *   the dashboard keeps the missing-rate convention (factor 1). The readers'
 *   `fx` join is on the security's currency, which is not the quote for a
 *   Forex row, so no Forex branch reads it.
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

/** True when the row's security is a Forex pair `AAA.BBB` (one dot, text on both sides). */
function forexPairSql(s: string): string {
  return `(UPPER(COALESCE(${s}.security_type, '')) = 'FOREX'
            AND INSTR(${s}.symbol, '.') > 1
            AND INSTR(${s}.symbol, '.') < LENGTH(${s}.symbol)
            AND INSTR(SUBSTR(${s}.symbol, INSTR(${s}.symbol, '.') + 1), '.') = 0)`;
}

/** A Forex pair whose BASE is USD (only meaningful when forexPairSql holds). */
function forexUsdBaseSql(s: string): string {
  return `(UPPER(SUBSTR(${s}.symbol, 1, INSTR(${s}.symbol, '.') - 1)) = 'USD')`;
}

/** The stored currency of a row. Aliases: `t` transactions, `s` securities (LEFT JOIN). */
export function transactionAmountCurrencySql(t = "t", s = "s"): string {
  const usdTypes = USD_STORED_TRANSACTION_TYPES.map((x) => `'${x}'`).join(", ");
  return `(CASE WHEN ${s}.id IS NULL OR UPPER(${t}.type) IN (${usdTypes}) THEN 'USD'
            WHEN ${forexPairSql(s)} THEN UPPER(SUBSTR(${s}.symbol, INSTR(${s}.symbol, '.') + 1))
            ELSE UPPER(COALESCE(${s}.currency, 'USD')) END)`;
}

/**
 * The dashboard's factor from a row's stored figures to USD: 1 for a
 * USD-stored row, else the rate, with a missing rate read as 1.0 (the repo's
 * `COALESCE(fx.usd_per_unit, 1)` convention). Expects `fx` joined as
 * `LEFT JOIN fx_rates fx ON fx.currency = s.currency`. A USD-base Forex leg
 * takes |quantity| / |amount| (so amount times the factor is the base
 * quantity with the amount's sign, and the price reads about 1); a Forex
 * pair with neither side USD takes 1 and never reads `fx`.
 */
export function transactionUsdFactorSql(t = "t", s = "s", fx = "fx"): string {
  return `(CASE WHEN ${transactionAmountCurrencySql(t, s)} = 'USD' THEN 1
            WHEN ${forexPairSql(s)} THEN
              (CASE WHEN ${forexUsdBaseSql(s)} THEN
                 (CASE WHEN ${t}.amount IS NOT NULL AND ${t}.amount <> 0 AND ${t}.quantity IS NOT NULL
                         THEN ABS(${t}.quantity) * 1.0 / ABS(${t}.amount)
                       WHEN ${t}.price_per_share IS NOT NULL AND ${t}.price_per_share <> 0
                         THEN 1.0 / ABS(${t}.price_per_share)
                       ELSE 1 END)
               ELSE 1 END)
            ELSE COALESCE(${fx}.usd_per_unit, 1) END)`;
}

/**
 * The chat's `amount` in USD: the amount itself for USD, null when no rate is
 * on file (never the native number read as dollars). Same `fx` join. A
 * USD-base Forex leg is its base quantity with the amount's sign; any other
 * non-USD Forex leg is null.
 */
export function transactionAmountUsdSql(t = "t", s = "s", fx = "fx"): string {
  const cur = transactionAmountCurrencySql(t, s);
  return `(CASE WHEN ${t}.amount IS NULL THEN NULL
            WHEN ${cur} = 'USD' THEN ${t}.amount
            WHEN ${forexPairSql(s)} THEN
              (CASE WHEN ${forexUsdBaseSql(s)} AND ${t}.quantity IS NOT NULL THEN
                 (CASE WHEN ${t}.amount > 0 THEN ABS(${t}.quantity)
                       WHEN ${t}.amount < 0 THEN -ABS(${t}.quantity)
                       ELSE 0 END)
               ELSE NULL END)
            WHEN ${fx}.usd_per_unit IS NOT NULL THEN ${t}.amount * ${fx}.usd_per_unit
            ELSE NULL END)`;
}
