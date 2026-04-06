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
