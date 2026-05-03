/**
 * Bond maturity date utilities.
 *
 * Extracts maturity dates from bond security names (e.g., Vanguard statement format)
 * and provides maturity-awareness helpers for portfolio queries.
 */

/**
 * Extract maturity date from a bond security name.
 *
 * Handles four patterns observed in production data (Vanguard PDFs + IBKR + canonical CSV):
 *   "T-Bill (due 10/23/25)"                                    → "2025-10-23"   parenthesized
 *   "U S TREASURY BILL DUE 11/28/25 DTD 11/29/24"              → "2025-11-28"   bare DUE
 *   "U S TREASURY BILL CPN 0.00000  MTD 2024-08-20 DTD ..."    → "2024-08-20"   MTD ISO
 *   "U S TREASURY BOND 4.75 05/15/55 05/15/25"                 → "2055-05-15"   first-of-two-dates fallback
 *
 * The fallback only fires when the name contains "TREASURY" and lacks DUE/MTD —
 * it's anchored to avoid false-positives on equity names that happen to contain
 * two date-like substrings.
 *
 * Returns YYYY-MM-DD string or null if no maturity date found.
 */
export function extractMaturityDate(name: string): string | null {
  // 1. Parenthesized DUE: "(due MM/DD/YY)" or "(due MM/DD/YYYY)"
  const paren = name.match(/\(due\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\)/i);
  if (paren) return buildIsoDate(paren[1], paren[2], paren[3]);

  // 2. Bare DUE keyword: "DUE MM/DD/YY ..." (anywhere in name).
  //    Anchored on \b so we don't catch "Overdue" or similar.
  const due = name.match(/\bdue\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/i);
  if (due) return buildIsoDate(due[1], due[2], due[3]);

  // 3. MTD ISO: "MTD YYYY-MM-DD" — IBKR / canonical CSV format.
  const mtd = name.match(/\bmtd\s+(\d{4})-(\d{2})-(\d{2})\b/i);
  if (mtd) {
    const [, y, m, d] = mtd;
    return validateAndFormat(y, m, d);
  }

  // 4. Fallback for treasuries lacking DUE/MTD keyword — first MM/DD/YY token
  //    is maturity, second is dated/issue. Requires "TREASURY" to avoid matching
  //    ad-hoc dates in non-bond names.
  if (/\btreasury\b/i.test(name)) {
    const twoDates = name.match(
      /(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/,
    );
    if (twoDates) return buildIsoDate(twoDates[1], twoDates[2], twoDates[3]);
  }

  return null;
}

function buildIsoDate(monthStr: string, dayStr: string, yearStr: string): string | null {
  let year: string;
  if (yearStr.length === 2) {
    // 2-digit year window: 00-79 → 2000s, 80-99 → 1900s.
    year = parseInt(yearStr, 10) < 80 ? `20${yearStr}` : `19${yearStr}`;
  } else if (yearStr.length === 4) {
    year = yearStr;
  } else {
    return null;
  }
  return validateAndFormat(year, monthStr, dayStr);
}

function validateAndFormat(year: string, monthStr: string, dayStr: string): string | null {
  const m = parseInt(monthStr, 10);
  const d = parseInt(dayStr, 10);
  if (!Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const mm = m.toString().padStart(2, "0");
  const dd = d.toString().padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * Check if a bond has matured as of a given date.
 * Returns false if maturityDate is null (non-dated securities are never "matured").
 */
export function isBondMatured(maturityDate: string | null, asOfDate: string): boolean {
  if (!maturityDate) return false;
  return maturityDate < asOfDate;
}
