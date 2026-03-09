/**
 * Bond maturity date utilities.
 *
 * Extracts maturity dates from bond security names (e.g., Vanguard statement format)
 * and provides maturity-awareness helpers for portfolio queries.
 */

/**
 * Extract maturity date from a bond security name.
 *
 * Handles common patterns from Vanguard statements:
 *   "T-Bill (due 10/23/25)"                          → "2025-10-23"
 *   "T-Note 4.375% (due 05/15/34)"                   → "2034-05-15"
 *   "T-Bond 3.000% (due 02/15/48)"                   → "2048-02-15"
 *   "UNITED STATES TREAS NTS 4.375% (due 05/15/2034)" → "2034-05-15"
 *
 * Returns YYYY-MM-DD string or null if no maturity date found.
 */
export function extractMaturityDate(name: string): string | null {
  // Match "(due MM/DD/YY)" or "(due MM/DD/YYYY)"
  const match = name.match(/\(due\s+(\d{2})\/(\d{2})\/(\d{2,4})\)/i);
  if (!match) return null;

  const [, month, day, yearRaw] = match;

  // Convert 2-digit year to 4-digit (00-79 → 2000s, 80-99 → 1900s)
  let year: string;
  if (yearRaw.length === 2) {
    const twoDigit = parseInt(yearRaw, 10);
    year = twoDigit < 80 ? `20${yearRaw}` : `19${yearRaw}`;
  } else {
    year = yearRaw;
  }

  // Validate date components
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  return `${year}-${month}-${day}`;
}

/**
 * Check if a bond has matured as of a given date.
 * Returns false if maturityDate is null (non-dated securities are never "matured").
 */
export function isBondMatured(maturityDate: string | null, asOfDate: string): boolean {
  if (!maturityDate) return false;
  return maturityDate < asOfDate;
}
