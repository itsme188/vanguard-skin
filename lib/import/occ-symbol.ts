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

export interface ParsedOptionSymbol {
  underlying: string;
  expirationDate: string; // YYYY-MM-DD
  optionType: "CALL" | "PUT";
  strike: number;
}

/**
 * Parse an OCC-format symbol into its components (inverse of buildOCCSymbol).
 * Returns null if the string isn't OCC format.
 */
export function parseOCCSymbol(symbol: string): ParsedOptionSymbol | null {
  if (!isOCCFormat(symbol)) return null;
  const underlying = symbol.slice(0, 6).trim();
  const yy = symbol.slice(6, 8);
  const mm = symbol.slice(8, 10);
  const dd = symbol.slice(10, 12);
  const cp = symbol.slice(12, 13);
  const strikeRaw = symbol.slice(13, 21);
  return {
    underlying,
    expirationDate: `20${yy}-${mm}-${dd}`,
    optionType: cp === "C" ? "CALL" : "PUT",
    strike: parseInt(strikeRaw, 10) / 1000,
  };
}

/**
 * Human-readable "Vanguard-compact" option symbol: root ticker, then a
 * space, then YYMMDD (no separators), then a space, C or P, then a space,
 * then the decimal strike. Example: "NVDA 260618 C 175.00" — the exact
 * same contract as OCC "NVDA  260618C00175000". This spelling comes out of
 * the Vanguard-PDF Claude extraction path (lib/import/parsers/vanguard-pdf.ts)
 * when the model emits a symbol directly instead of (or in addition to) the
 * structured underlying/strike/expiration/type fields ensureOCCSymbol()
 * relies on — so a bare regex parse of the symbol text itself is the only
 * way to recognize it (qa:security-detail-transactions--same-option-trade-
 * duplicated-across-two-symbol-spellings, 2026-08-12).
 */
const VANGUARD_COMPACT_OPTION_RE =
  /^([A-Z][A-Z0-9.]{0,5})\s+(\d{2})(\d{2})(\d{2})\s+([CP])\s+([\d.]+)\s*$/;

/**
 * Parse an option symbol string that may be spelled either in canonical OCC
 * form or the "Vanguard-compact" human-readable form above. Returns null for
 * anything that matches neither shape — bare tickers, bonds, CUSIPs, mutual
 * fund symbols all safely fall through to null, never throw.
 */
export function parseOptionSymbol(symbol: string): ParsedOptionSymbol | null {
  const occ = parseOCCSymbol(symbol);
  if (occ) return occ;

  const match = symbol.match(VANGUARD_COMPACT_OPTION_RE);
  if (!match) return null;
  const [, underlying, yy, mm, dd, cp, strikeStr] = match;
  const strike = parseFloat(strikeStr);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return {
    underlying,
    expirationDate: `20${yy}-${mm}-${dd}`,
    optionType: cp === "C" ? "CALL" : "PUT",
    strike,
  };
}

/**
 * Format a parsed option identity into canonical OCC form. Thin wrapper
 * over buildOCCSymbol kept as a distinct name so call sites read as
 * "reformat what I already parsed" rather than "build from raw parts".
 */
export function formatOccSymbol(parsed: ParsedOptionSymbol): string {
  return buildOCCSymbol(
    parsed.underlying,
    parsed.expirationDate,
    parsed.optionType,
    parsed.strike
  );
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
