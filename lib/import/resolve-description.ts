/**
 * Resolve a Vanguard security description to a symbol when the symbol
 * column is blank. Primarily handles option descriptions like:
 *   "AAPL CALL 2026-03-20 $150"
 *   "INTC PUT 03/20/26 $45"
 *   "MSFT COVERED CALL 2026-06-20 $420"
 *
 * For company-name descriptions (e.g., "INTEL CORP PUT 03/20/26 $45"),
 * an optional DB parameter enables name→ticker lookup.
 */

import type Database from "better-sqlite3";
import { buildOCCSymbol } from "./occ-symbol";

export interface ResolvedSymbol {
  symbol: string;
  securityType: string;
  underlyingSymbol?: string;
  strikePrice?: number;
  expirationDate?: string; // YYYY-MM-DD
  optionType?: "CALL" | "PUT";
  multiplier?: number;
}

// ── Date parsing helpers ──────────────────────────────────────────

/** Parse MM/DD/YY or MM/DD/YYYY to YYYY-MM-DD */
function parseSlashDate(dateStr: string): string | null {
  const m = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
  if (!m) return null;
  const [, month, day, rawYear] = m;
  const year =
    rawYear.length === 2
      ? (parseInt(rawYear) >= 80 ? "19" : "20") + rawYear
      : rawYear;
  return `${year}-${month}-${day}`;
}

/** Parse YYYY-MM-DD (passthrough validation) */
function parseIsoDate(dateStr: string): string | null {
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? dateStr : null;
}

/** Try both date formats */
function parseDate(dateStr: string): string | null {
  return parseIsoDate(dateStr) || parseSlashDate(dateStr);
}

// ── Option description patterns ───────────────────────────────────

/**
 * Match option descriptions with date and strike.
 * Captures: [1]=name/ticker, [2]=CALL|PUT, [3]=date, [4]=strike
 *
 * Handles:
 *   "AAPL CALL 2026-03-20 $150"
 *   "INTC PUT 03/20/26 $45"
 *   "MSFT COVERED CALL 2026-06-20 $420"
 *   "META CALL 02/15/24 $600.00"
 */
const OPTION_PATTERN =
  /^(.+?)\s+(?:COVERED\s+)?(CALL|PUT)\s+(\d{2}\/\d{2}\/\d{2,4}|\d{4}-\d{2}-\d{2})\s+\$?([\d.]+)$/i;

/** Check if a string looks like a stock ticker (1-5 uppercase letters) */
function isTicker(s: string): boolean {
  return /^[A-Z]{1,5}$/.test(s);
}

// ── Main resolver ─────────────────────────────────────────────────

/**
 * Attempt to resolve a symbol from a Vanguard description string.
 * Returns null if resolution fails (caller should emit a warning).
 *
 * @param description - The security_name/description from the CSV
 * @param db - Optional DB for company-name→ticker lookup
 */
export function resolveDescriptionToSymbol(
  description: string,
  db?: Database.Database
): ResolvedSymbol | null {
  if (!description) return null;

  const match = description.match(OPTION_PATTERN);
  if (!match) return null;

  const [, rawName, rawType, rawDate, rawStrike] = match;
  const optionType = rawType.toUpperCase() as "CALL" | "PUT";
  const expirationDate = parseDate(rawDate);
  const strikePrice = parseFloat(rawStrike);

  if (!expirationDate || isNaN(strikePrice)) return null;

  // Resolve the underlying ticker
  const namePart = rawName.trim();
  let ticker: string | null = null;

  // Case 1: Name is already a ticker (e.g., "AAPL", "INTC", "META")
  if (isTicker(namePart.toUpperCase())) {
    ticker = namePart.toUpperCase();
  }

  // Case 2: DB lookup for company names (e.g., "INTEL CORP" → "INTC")
  if (!ticker && db) {
    ticker = lookupTickerByName(db, namePart);
  }

  if (!ticker) return null;

  const symbol = buildOCCSymbol(ticker, expirationDate, optionType, strikePrice);

  return {
    symbol,
    securityType: "Option",
    underlyingSymbol: ticker,
    strikePrice,
    expirationDate,
    optionType,
    multiplier: 100,
  };
}

/**
 * Look up a stock ticker by company name in the securities table.
 * Tries exact match first, then prefix match.
 */
function lookupTickerByName(
  db: Database.Database,
  companyName: string
): string | null {
  // Exact name match (case-insensitive)
  const exact = db
    .prepare(
      `SELECT symbol FROM securities
       WHERE LOWER(name) = LOWER(?)
         AND LOWER(security_type) NOT IN ('option', 'mutual fund')
       LIMIT 1`
    )
    .get(companyName) as { symbol: string } | undefined;

  if (exact) return exact.symbol;

  // Try matching with common suffixes stripped
  const stripped = companyName
    .replace(/\s+(CORP|INC|CO|LTD|LLC|PLC|NV|SA|AG|GROUP|HOLDINGS?)\.?$/i, "")
    .trim();

  if (stripped !== companyName) {
    const partial = db
      .prepare(
        `SELECT symbol FROM securities
         WHERE LOWER(name) LIKE LOWER(? || '%')
           AND LOWER(security_type) NOT IN ('option', 'mutual fund')
         LIMIT 1`
      )
      .get(stripped) as { symbol: string } | undefined;

    if (partial) return partial.symbol;
  }

  return null;
}
