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
}

/**
 * Securities eligible for an IBKR market-data snapshot: equity-like securities
 * (stocks / ETFs / funds) with a resolved IBKR conid that are either currently
 * held (non-zero qty in their account's latest snapshot) or on the active
 * watchlist. Excluded: options (the IV we want is the UNDERLYING's, and Greeks
 * solves per-option IV from the option price), and bonds / cash (no IV / 52-week
 * range, and bond pricing has par-adjustment handled by the positions path).
 */
export function getQuoteCandidateConids(db: Database.Database): QuoteCandidate[] {
  return db
    .prepare(
      `SELECT DISTINCT s.id AS securityId, s.ib_con_id AS conid
         FROM securities s
        WHERE s.ib_con_id IS NOT NULL
          AND LOWER(COALESCE(s.security_type, '')) NOT IN ('option', 'bond', 'cash')
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
            OR s.id IN (SELECT security_id FROM watchlist WHERE is_active = 1)
          )`,
    )
    .all() as QuoteCandidate[];
}
