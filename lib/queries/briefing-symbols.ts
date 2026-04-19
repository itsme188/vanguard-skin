import type Database from "better-sqlite3";

/**
 * Returns distinct stock symbols currently held across all accounts (latest
 * holdings date per account, quantity > 0). Excludes ETFs, bonds, options,
 * and mutual funds — only individual equities where an earnings release is
 * a meaningful event.
 *
 * Case-insensitive on security_type (DB stores capitalized values like
 * "Stock", "ETF", "Bond", "Option", "Mutual Fund"; see CLAUDE.md).
 */
export function getHeldStockSymbols(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT s.symbol
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE h.quantity > 0
         AND LOWER(COALESCE(s.security_type, '')) IN ('stock', 'common stock')
         AND s.symbol IS NOT NULL
         AND s.symbol != ''
         AND h.as_of_date = (
           SELECT MAX(h2.as_of_date) FROM holdings h2
           WHERE h2.account_id = h.account_id
         )
       ORDER BY s.symbol`
    )
    .all() as { symbol: string }[];
  return rows.map((r) => r.symbol);
}

/**
 * Resolve a symbol to its current security_id (if we hold it). Used by the
 * Finnhub fetch to attach security_id on calendar_events rows so the chat +
 * briefing layers can cross-reference holdings.
 */
export function getSecurityIdForSymbol(
  db: Database.Database,
  symbol: string
): number | null {
  const row = db
    .prepare(
      `SELECT id FROM securities WHERE symbol = ? AND LOWER(COALESCE(security_type, '')) IN ('stock', 'common stock') LIMIT 1`
    )
    .get(symbol) as { id: number } | undefined;
  return row?.id ?? null;
}
