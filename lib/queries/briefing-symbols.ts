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

export type SymbolStatus = "held" | "watchlist" | "neither";

/**
 * Classify a batch of symbols as held / watchlist / neither in one round
 * trip. Used by the EarningsHub block on `/dashboard/today` to render a
 * status chip per row, and by Phase-3's email-sweep to filter candidate
 * events to only held + watchlist names (no inbox flooding from S&P-500
 * earnings the user doesn't own or care about).
 *
 * Held wins over watchlist when both apply. Empty input returns `{}`.
 *
 * Symbols are matched case-insensitively on the input + DB sides so the
 * caller doesn't need to upper-case before passing.
 */
export function getSymbolStatus(
  db: Database.Database,
  symbols: string[],
): Record<string, SymbolStatus> {
  if (symbols.length === 0) return {};
  const upperInput = symbols.map((s) => s.toUpperCase());
  // Dedup the input — caller may pass dupes; SQL placeholders should still match.
  const distinctInput = Array.from(new Set(upperInput));
  const placeholders = distinctInput.map(() => "?").join(",");

  const heldRows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.symbol) AS symbol
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
        WHERE UPPER(s.symbol) IN (${placeholders})
          AND h.quantity > 0
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id
               AND h2.security_id = h.security_id
          )`,
    )
    .all(...distinctInput) as { symbol: string }[];
  const held = new Set(heldRows.map((r) => r.symbol));

  const watchlistRows = db
    .prepare(
      `SELECT DISTINCT UPPER(s.symbol) AS symbol
         FROM watchlist w
         JOIN securities s ON s.id = w.security_id
        WHERE w.is_active = 1
          AND UPPER(s.symbol) IN (${placeholders})`,
    )
    .all(...distinctInput) as { symbol: string }[];
  const watchlist = new Set(watchlistRows.map((r) => r.symbol));

  const out: Record<string, SymbolStatus> = {};
  for (const sym of upperInput) {
    if (held.has(sym)) out[sym] = "held";
    else if (watchlist.has(sym)) out[sym] = "watchlist";
    else out[sym] = "neither";
  }
  return out;
}
