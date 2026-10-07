/**
 * Bond maturity date and coupon utilities.
 *
 * Extracts maturity dates and coupons from bond security names (e.g., Vanguard
 * statement format) and provides maturity-awareness helpers for portfolio queries.
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

/** A coupon above this is treated as bad data, not a real bond. Annual percent. */
export const MAX_PLAUSIBLE_COUPON_PCT = 25;

/**
 * An explicit coupon token: "CPN 4.125%", "CPN 0.00000". The figure must end
 * the token (whitespace or end of name after the optional percent sign), so
 * "CPN 4.1.25" and "CPN 100" do not match.
 */
const CPN_TOKEN = /\bCPN\s+(\d{1,2}(?:\.\d{1,5})?)(?:\s*%)?(?=\s|$)/gi;

/**
 * A percent figure: "4.375%", "3.000%". At most two whole digits, and it may
 * not continue a longer number, a date, a dollar amount, a signed figure or a
 * spread ("100%", "$4.5%", "-4%", "SOFR+0.25%" do not match).
 */
const PERCENT_TOKEN = /(?<![\d.,/$+-])(\d{1,2}(?:\.\d{1,5})?)\s*%/g;

/** Every number that is followed by a percent sign, whatever precedes it. */
const ANY_PERCENT_FIGURE = /(\d+(?:\.\d+)?)\s*%/g;

/**
 * Words that mean a percent figure in the name is NOT a fixed coupon: a
 * yield, a floating or variable rate, a step-up, a reference rate (the figure
 * is then a spread), a pay-in-kind toggle. Whole words, any case.
 */
const NOT_A_FIXED_COUPON =
  /\b(?:YLD|YIELD|FLTG|FLOAT|FLOATER|FLOATING|FRN|VAR|VARIABLE|STEP|SOFR|LIBOR|PIK|TOGGLE)\b/i;

/**
 * Read a bond's annual coupon, in PERCENT of face (4.375 means 4.375%), from
 * its stored name. The backstop for a bond with no stored coupon (owner
 * ruling 2026-10-07).
 *
 * Strict on purpose: every wrong answer here is a silently wrong duration. A
 * coupon is returned ONLY when the name carries a percent sign or an explicit
 * CPN token, in the shapes this file's maturity parser already sees:
 *   "T-Note 4.375% (due 05/15/34)"                          → 4.375   percent sign
 *   "U S TREASURY NOTE CPN 4.125% DUE 11/15/32 DTD ..."     → 4.125   CPN + percent
 *   "U S TREASURY BILL CPN 0.00000  MTD 2024-08-20 DTD ..." → 0       CPN, no percent
 *
 * Returns null when:
 *   - the name carries a word from NOT_A_FIXED_COUPON ("YLD 5.1%", "FLTG
 *     RATE NT VAR 5.310%", "SOFR + 0.25%", "6.5%/7.5% PIK TOGGLE");
 *   - ANY percent figure in the name differs from the coupon found, counted
 *     before any lookbehind ("6.5%/7.5%", "CPN 4.125 ... PRICE 98.5%",
 *     "4.375% ... CALLABLE 100%", "4 3/8%"). With two different percent
 *     figures nothing in the name says which one is the coupon, so neither
 *     is taken, even when one of them is a call price;
 *   - the only number is bare: the two-date shape "U S TREASURY NOTE 4.625
 *     02/15/35 02/15/25" has nothing that says the number is a coupon;
 *   - the figure is outside 0 to MAX_PLAUSIBLE_COUPON_PCT.
 * Zero is a valid coupon.
 */
export function extractCouponRate(name: string | null | undefined): number | null {
  if (!name) return null;
  if (NOT_A_FIXED_COUPON.test(name)) return null;

  const found: number[] = [];
  for (const pattern of [CPN_TOKEN, PERCENT_TOKEN]) {
    for (const match of name.matchAll(pattern)) found.push(Number(match[1]));
  }
  if (found.length === 0) return null;
  const coupon = found[0];
  if (found.some((value) => value !== coupon)) return null;
  // Every percent figure anywhere in the name must be that same coupon.
  for (const match of name.matchAll(ANY_PERCENT_FIGURE)) {
    if (Number(match[1]) !== coupon) return null;
  }
  if (!Number.isFinite(coupon) || coupon < 0 || coupon > MAX_PLAUSIBLE_COUPON_PCT) return null;
  return coupon;
}
