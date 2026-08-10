import { SecType, WhatToShow } from "@stoqey/ib";

/**
 * Map DB security_type values to IBKR SecType enum.
 *
 * The DB stores capitalized types ("Stock", "Bond", "ETF", "Option", "Mutual Fund")
 * but legacy data or imports may use other casings ("stock", "mutual_fund", etc.).
 * This function handles all variants via case-insensitive matching.
 *
 * IMPORTANT: This is the single canonical copy. Do NOT duplicate in other TWS modules.
 */
export function mapSecurityType(dbType: string | null): SecType {
  switch (dbType?.toLowerCase()) {
    case "stock":
    case "etf":
      return SecType.STK;
    case "bond":
      return SecType.BOND;
    case "mutual_fund":
    case "mutual fund":
      return SecType.FUND;
    case "option":
      return SecType.OPT;
    default:
      return SecType.STK;
  }
}

/**
 * DB security_type values that should be excluded from historical price fetching.
 * Used in SQL queries — must match DB-stored values case-insensitively via LOWER().
 *
 * - Options: need special handling (Greeks-based pricing, not historical bars)
 *
 * Note: Mutual funds and bonds ARE fetched, using MIDPOINT and BID_ASK respectively.
 */
export const PRICE_FETCH_EXCLUDED_TYPES = ["option"] as const;

/**
 * Determine the TWS `whatToShow` parameter based on security type.
 *
 * - Stocks/ETFs: TRADES (actual executed trades)
 * - Bonds: BID_ASK (dealer quotes — bonds have no trade data in TWS)
 * - Mutual Funds: MIDPOINT (NAV data, updates once daily at close)
 * - Default: TRADES
 */
export function getWhatToShow(
  dbType: string | null,
): WhatToShow {
  switch (dbType?.toLowerCase()) {
    case "bond":
      return WhatToShow.BID_ASK;
    case "mutual_fund":
    case "mutual fund":
      return WhatToShow.MIDPOINT;
    default:
      return WhatToShow.TRADES;
  }
}

/** Fallback whatToShow values to try if the primary one returns no bars. */
export function getWhatToShowFallback(
  dbType: string | null,
): WhatToShow | null {
  switch (dbType?.toLowerCase()) {
    case "bond":
      return WhatToShow.YIELD_BID_ASK; // some bonds only have yield data
    case "mutual_fund":
    case "mutual fund":
      return WhatToShow.TRADES; // some fund-like ETFs respond to TRADES
    default:
      return null; // no fallback for stocks
  }
}

/**
 * IBKR's `ContractDetails.stockType` (confirmed field name/type in
 * @stoqey/ib's contractDetails.d.ts: `stockType?: string` — a free-form
 * string, not a typed enum in the package). IBKR's own documented
 * classification vocabulary (the `stockTypeFilter` scanner enum:
 * CORP/ADR/ETF/REIT/CEF) plus the ETN value real-world contract details
 * report for exchange-traded notes are treated as "trades like a fund, not
 * a single-name equity" for this project's purposes. CEF (closed-end fund)
 * is deliberately excluded — it is legally NOT an ETF (see PSUS carve-out
 * in scripts/repair-etf-types.ts) even though it also trades on an
 * exchange.
 */
const ETF_FAMILY_STOCK_TYPES = new Set(["etf", "etn"]);

/** True when an IBKR `stockType` value indicates an ETF-family instrument
 *  (ETF or ETN) rather than a common stock (COMMON), ADR, REIT, or CEF. */
export function isEtfFamilyStockType(
  stockType: string | null | undefined,
): boolean {
  if (!stockType) return false;
  return ETF_FAMILY_STOCK_TYPES.has(stockType.trim().toLowerCase());
}

/**
 * True when a security's stored `security_type` should be corrected to
 * 'ETF' given IBKR's contract-details `stockType` classification.
 *
 * IBKR reports ETFs as plain stocks (SecType.STK) both in TWS positions
 * and IBKR activity-statement imports — nothing upstream distinguishes an
 * ETF from a single-name equity. This is the one-way correction: it never
 * downgrades a row already typed 'ETF' / 'Mutual Fund' / 'Bond' / 'Option'
 * (those are left alone regardless of what TWS reports), and it never
 * overwrites a statement-sourced non-Stock type — both are guaranteed by
 * requiring the CURRENT type to be NULL or 'Stock' (case-insensitive per
 * project convention).
 */
export function shouldRetypeAsEtf(
  currentType: string | null | undefined,
  stockType: string | null | undefined,
): boolean {
  if (!isEtfFamilyStockType(stockType)) return false;
  if (currentType == null || currentType.trim() === "") return true;
  return currentType.trim().toLowerCase() === "stock";
}
