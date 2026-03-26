import type Database from "better-sqlite3";
import type { OhlcvBar } from "@/lib/tws/types";

interface OhlcvBarRow {
  security_id: number;
  bar_date: string;
  bar_size: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  wap: number | null;
  trade_count: number | null;
}

/**
 * Insert or replace OHLCV bars for a security.
 * Uses the UNIQUE(security_id, bar_date, bar_size) constraint
 * so refetches overwrite stale data cleanly.
 */
export function upsertOhlcvBars(
  db: Database.Database,
  securityId: number,
  barSize: string,
  bars: Array<
    OhlcvBar & { wap?: number | null; tradeCount?: number | null }
  >,
): number {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ohlcv_bars
      (security_id, bar_date, bar_size, open, high, low, close, volume, wap, trade_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  db.transaction(() => {
    for (const bar of bars) {
      stmt.run(
        securityId,
        bar.date,
        barSize,
        bar.open,
        bar.high,
        bar.low,
        bar.close,
        bar.volume,
        bar.wap ?? null,
        bar.tradeCount ?? null,
      );
      inserted++;
    }
  })();

  return inserted;
}
