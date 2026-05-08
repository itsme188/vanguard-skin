import type Database from "better-sqlite3";

export function getCachedBeta(
  db: Database.Database,
  securityId: number,
  lookbackDays: number = 60,
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
  lookbackDays: number = 60,
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
