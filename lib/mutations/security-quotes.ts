/**
 * Write a per-security market-data quote (IBKR Web API snapshot enrichment).
 *
 * Single row per security (latest snapshot wins), keyed on the PK security_id.
 * Vols are annualized fractions (0.24 = 24%); dividend_yield (when set) is a
 * percent. See migration 058 + lib/ibkr/refresh.ts (capture site).
 */

import type Database from "better-sqlite3";

export interface SecurityQuoteInput {
  securityId: number;
  asOfDate: string; // YYYY-MM-DD (ET)
  ivUnderlying: number | null;
  hv30d: number | null;
  week52High: number | null;
  week52Low: number | null;
  dividendYield: number | null;
}

export function upsertSecurityQuote(
  db: Database.Database,
  q: SecurityQuoteInput,
): void {
  db.prepare(
    `INSERT INTO security_quotes
       (security_id, as_of_date, iv_underlying, hv_30d, week52_high, week52_low, dividend_yield, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(security_id) DO UPDATE SET
       as_of_date     = excluded.as_of_date,
       iv_underlying  = excluded.iv_underlying,
       hv_30d         = excluded.hv_30d,
       week52_high    = excluded.week52_high,
       week52_low     = excluded.week52_low,
       -- Keep-last-known: the IBKR snapshot never carries yield, so quote
       -- refreshes pass null — that must not clobber the Finnhub-sourced
       -- value. An explicit non-null value still overwrites.
       dividend_yield = COALESCE(excluded.dividend_yield, dividend_yield),
       updated_at     = datetime('now')`,
  ).run(
    q.securityId,
    q.asOfDate,
    q.ivUnderlying,
    q.hv30d,
    q.week52High,
    q.week52Low,
    q.dividendYield,
  );
}
