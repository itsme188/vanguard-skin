/**
 * Read the latest cached market-data quote for a security (IBKR snapshot
 * enrichment). Returns null when no quote has been captured yet.
 */

import type Database from "better-sqlite3";

export interface SecurityQuote {
  security_id: number;
  as_of_date: string;
  iv_underlying: number | null;
  hv_30d: number | null;
  week52_high: number | null;
  week52_low: number | null;
  dividend_yield: number | null;
  updated_at: string;
}

export function getSecurityQuote(
  db: Database.Database,
  securityId: number,
): SecurityQuote | null {
  return (
    (db
      .prepare("SELECT * FROM security_quotes WHERE security_id = ?")
      .get(securityId) as SecurityQuote | undefined) ?? null
  );
}

export interface QuoteCandidate {
  securityId: number;
  conid: number;
  /**
   * Price-only tier (held options + bonds, R1b 2026-07-07): the snapshot's
   * last price is written to `prices` but NO `security_quotes` row is cached —
   * that table is deliberately an equities-only IV/HV/52wk cache (an option's
   * IV lives on its UNDERLYING; bonds have neither). Probe-verified: field 31
   * returns per-share option premiums and par-based bond prices, both matching
   * the prices-table conventions.
   */
  priceOnly: boolean;
}

/**
 * Securities eligible for an IBKR market-data snapshot, in two tiers:
 *  - Full quote (priceOnly=false): equity-like securities (stocks / ETFs /
 *    funds) with a resolved IBKR conid, currently held (non-zero qty in their
 *    account's latest snapshot) or on the active watchlist.
 *  - Price only (priceOnly=true): currently-HELD options + bonds with a conid —
 *    keeps their prices moving while TWS is down (the Web API positions path
 *    only covers the IBKR account; Vanguard-held options/bonds have no other
 *    TWS-independent price source). Watchlist stays equities-only.
 * Cash is never a candidate.
 */
export function getQuoteCandidateConids(db: Database.Database): QuoteCandidate[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.id AS securityId, s.ib_con_id AS conid,
              CASE WHEN LOWER(COALESCE(s.security_type, '')) IN ('option', 'bond') THEN 1 ELSE 0 END AS priceOnly
         FROM securities s
        WHERE s.ib_con_id IS NOT NULL
          AND LOWER(COALESCE(s.security_type, '')) != 'cash'
          AND (
            s.id IN (
              SELECT h.security_id
                FROM holdings h
                JOIN (
                  SELECT account_id, security_id, MAX(as_of_date) AS d
                    FROM holdings GROUP BY account_id, security_id
                ) latest
                  ON latest.account_id = h.account_id
                 AND latest.security_id = h.security_id
                 AND latest.d = h.as_of_date
               WHERE h.quantity != 0
            )
            OR (
              LOWER(COALESCE(s.security_type, '')) NOT IN ('option', 'bond')
              AND s.id IN (SELECT security_id FROM watchlist WHERE is_active = 1)
            )
          )`,
    )
    .all() as Array<{ securityId: number; conid: number; priceOnly: number }>;
  return rows.map((r) => ({ ...r, priceOnly: r.priceOnly === 1 }));
}
