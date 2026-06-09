/**
 * Dividend yield via Finnhub /stock/metric (free tier).
 *
 * Why Finnhub: the IBKR Web API does NOT expose dividend yield on the
 * headless OAuth session — probe-verified 2026-06-09 (snapshot fields
 * 7286-7292 never populate / return 0 for KO + XOM; /iserver/fundamentals/
 * {conid}/summary's ratios block has no yield and 503s intermittently; the
 * ratios/dividends/landing variants 404). Finnhub's `currentDividendYieldTTM`
 * is a PERCENT (3.205 = 3.205%), matching the security_quotes column unit,
 * and was live-verified against KO on 2026-06-09.
 *
 * Yield drifts slowly, so each refresh fetches a small capped batch:
 * candidates missing a yield first, then a random rotation of the rest, so
 * every name converges to ≤ a-few-runs-old without hammering the 60/min
 * free-tier limit.
 */

import type Database from "better-sqlite3";

/** Max Finnhub calls per quote-refresh run (one symbol per call). */
export const YIELD_FETCH_CAP_PER_RUN = 15;

/** Pacing between Finnhub calls — free tier allows 60/min. */
const PACE_MS = 1100;

export interface YieldCandidate {
  securityId: number;
  symbol: string;
}

/** Yield fetcher shape (DI for tests): symbols → symbol→percent (or null). */
export type YieldFetcher = (
  symbols: string[],
) => Promise<Record<string, number | null>>;

/**
 * Pick which candidates get a Finnhub yield call this run: quote candidates
 * with no stored yield first (new positions / first run), then a random
 * rotation of the rest so existing yields refresh over successive runs.
 * Same eligibility filter as getQuoteCandidateConids (equity-like, held or
 * watchlisted) — yield on bonds/options is meaningless here.
 */
export function getYieldRefreshCandidates(
  db: Database.Database,
  cap: number = YIELD_FETCH_CAP_PER_RUN,
): YieldCandidate[] {
  return db
    .prepare(
      `SELECT DISTINCT s.id AS securityId, s.symbol AS symbol,
              (q.dividend_yield IS NULL) AS missing
         FROM securities s
         LEFT JOIN security_quotes q ON q.security_id = s.id
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
          )
        ORDER BY missing DESC, RANDOM()
        LIMIT ?`,
    )
    .all(cap) as YieldCandidate[];
}

/**
 * Default fetcher — Finnhub /stock/metric, one call per symbol, paced for the
 * free tier. Returns {} when FINNHUB_API_KEY is unset (graceful no-op, same
 * convention as the Pushover sender). Per-symbol failures are skipped.
 */
export const fetchFinnhubDividendYields: YieldFetcher = async (symbols) => {
  const apiKey = process.env.FINNHUB_API_KEY;
  const out: Record<string, number | null> = {};
  if (!apiKey || symbols.length === 0) return out;

  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(sym)}&metric=all&token=${apiKey}`,
      );
      if (res.ok) {
        const json = (await res.json()) as { metric?: Record<string, unknown> };
        const y = json.metric?.currentDividendYieldTTM;
        if (typeof y === "number" && Number.isFinite(y) && y >= 0) {
          out[sym.toUpperCase()] = y;
        }
      }
    } catch {
      // skip this symbol — keep-last-known on the write side covers it
    }
    if (i < symbols.length - 1) await new Promise((r) => setTimeout(r, PACE_MS));
  }
  return out;
};
