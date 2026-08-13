import type Database from "better-sqlite3";

/**
 * The one lookback window the beta refresh script actually writes.
 * Every reader (default params here, the exposure-delta and drill-down SQL
 * joins) must ask for this same value — a join on any other lookback finds
 * zero rows and silently degrades to the ?? 1.0 fallback.
 */
export const BETA_LOOKBACK_DAYS = 60;

export function getCachedBeta(
  db: Database.Database,
  securityId: number,
  lookbackDays: number = BETA_LOOKBACK_DAYS,
): number | null {
  const row = db
    .prepare(
      "SELECT beta FROM security_betas WHERE security_id = ? AND lookback_days = ?",
    )
    .get(securityId, lookbackDays) as { beta: number } | undefined;
  return row ? row.beta : null;
}

export interface CachedBeta {
  securityId: number;
  symbol: string;
  beta: number;
  lookbackDays: number;
  computedAt: string;
}

export function getCachedBetasForSymbols(
  db: Database.Database,
  symbols: string[],
  lookbackDays: number = BETA_LOOKBACK_DAYS,
): CachedBeta[] {
  if (symbols.length === 0) return [];
  const placeholders = symbols.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT s.id AS securityId, s.symbol, sb.beta, sb.lookback_days AS lookbackDays, sb.computed_at AS computedAt
         FROM security_betas sb
         JOIN securities s ON s.id = sb.security_id
        WHERE s.symbol IN (${placeholders})
          AND sb.lookback_days = ?`,
    )
    .all(...symbols, lookbackDays) as CachedBeta[];
}
