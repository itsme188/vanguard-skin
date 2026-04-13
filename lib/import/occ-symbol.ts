/**
 * OCC (Options Clearing Corporation) symbol utilities.
 *
 * OCC format: AAPL  250321C00150000
 *   - Underlying padded to 6 chars (right-padded with spaces)
 *   - YYMMDD expiration date
 *   - C (call) or P (put)
 *   - Strike × 1000, zero-padded to 8 digits
 *
 * Total: 21 characters. This format is the universal identifier for
 * US-listed equity options and prevents symbol collisions between
 * stocks and their options in the securities table.
 */

/**
 * Build an OCC-format option symbol from component parts.
 */
export function buildOCCSymbol(
  underlying: string,
  expirationDate: string, // YYYY-MM-DD
  optionType: "CALL" | "PUT",
  strike: number
): string {
  const paddedUnderlying = underlying.slice(0, 6).padEnd(6, " ");
  const [year, month, day] = expirationDate.split("-");
  const occDate = `${year.slice(2)}${month}${day}`;
  const cpFlag = optionType === "CALL" ? "C" : "P";
  const occStrike = Math.round(strike * 1000).toString().padStart(8, "0");
  return `${paddedUnderlying}${occDate}${cpFlag}${occStrike}`;
}

/**
 * Check whether a symbol is already in OCC format.
 */
export function isOCCFormat(symbol: string): boolean {
  return /^.{6}\d{6}[CP]\d{8}$/.test(symbol);
}

/**
 * If an option has a bare ticker as symbol but full metadata available,
 * convert it to OCC format. Returns the corrected symbol.
 */
export function ensureOCCSymbol(
  symbol: string,
  underlyingSymbol: string | undefined,
  expirationDate: string | undefined,
  optionType: "CALL" | "PUT" | undefined,
  strikePrice: number | undefined
): string {
  if (isOCCFormat(symbol)) return symbol;

  if (underlyingSymbol && expirationDate && optionType && strikePrice != null) {
    return buildOCCSymbol(
      underlyingSymbol,
      expirationDate,
      optionType,
      strikePrice
    );
  }

  return symbol;
}
