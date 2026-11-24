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

/** Result of an {@link upsertOhlcvBars} call. */
export interface UpsertOhlcvBarsResult {
  /** Number of bars written (INSERT OR REPLACE). */
  inserted: number;
  /** Number of bars skipped because they failed the corrupt-bar guard. */
  rejected: number;
}

/**
 * A bar is trustworthy only when every OHLC field is a finite, positive
 * number and high >= low. `volume` is intentionally NOT checked — a zero
 * volume is a legitimate print for a thin name, not a defect.
 *
 * This mirrors the read-side guard in `lib/queries/ohlcv.ts::get52WeekRange`
 * (`CASE WHEN low > 0 AND high > 0 ...`) but stops the corrupt row from ever
 * reaching the table, instead of filtering it out on every read. TWS has
 * been observed to return bars with real open/high but low = 0 AND close = 0
 * (six such rows exist in the live DB for one security as of 2026-09-06).
 */
function isSaneBar(bar: {
  open: number;
  high: number;
  low: number;
  close: number;
}): boolean {
  const { open, high, low, close } = bar;
  return (
    Number.isFinite(open) &&
    open > 0 &&
    Number.isFinite(high) &&
    high > 0 &&
    Number.isFinite(low) &&
    low > 0 &&
    Number.isFinite(close) &&
    close > 0 &&
    high >= low
  );
}

/**
 * Insert or replace OHLCV bars for a security.
 * Uses the UNIQUE(security_id, bar_date, bar_size) constraint
 * so refetches overwrite stale data cleanly.
 *
 * Bars that fail {@link isSaneBar} are skipped (never written) and counted
 * in the returned `rejected` field — one corrupt bar must not abort an
 * otherwise-good multi-bar backfill. A single `console.warn` per call
 * reports the rejection (never one warning per row).
 */
export function upsertOhlcvBars(
  db: Database.Database,
  securityId: number,
  barSize: string,
  bars: Array<
    OhlcvBar & { wap?: number | null; tradeCount?: number | null }
  >,
): UpsertOhlcvBarsResult {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ohlcv_bars
      (security_id, bar_date, bar_size, open, high, low, close, volume, wap, trade_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  const rejectedBars: typeof bars = [];

  db.transaction(() => {
    for (const bar of bars) {
      if (!isSaneBar(bar)) {
        rejectedBars.push(bar);
        continue;
      }
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

  if (rejectedBars.length > 0) {
    const sec = db
      .prepare("SELECT symbol, ib_con_id FROM securities WHERE id = ?")
      .get(securityId) as
      | { symbol: string; ib_con_id: number | null }
      | undefined;
    console.warn(
      `upsertOhlcvBars: rejected ${rejectedBars.length} corrupt bar(s) for ` +
        `${sec?.symbol ?? `security #${securityId}`} (conId ${sec?.ib_con_id ?? "unknown"}); ` +
        `first rejected bar date=${rejectedBars[0].date}`,
    );
  }

  return { inserted, rejected: rejectedBars.length };
}

/** Result of a {@link replaceDailyBarsInWindow} call. */
export interface ReplaceDailyBarsResult extends UpsertOhlcvBarsResult {
  /** Daily rows dated BEFORE the window that were deleted (only with `deleteOlderDailyBars`). */
  olderDeleted: number;
}

/**
 * Replace a security's daily bars from `startDate` on, in one transaction
 * (Gains at risk daily-bar capture, ruling C2: a change of adjustment basis,
 * such as a split TWS has applied to its history since the bars were stored).
 *
 * Deletes the security's `'1 day'` rows dated on or after `startDate`, then
 * writes `bars` through the same bad-bar guard as {@link upsertOhlcvBars}.
 * Rows of other bar sizes are never touched. Rows dated before `startDate`
 * are kept, unless `opts.deleteOlderDailyBars` is set: after a detected basis
 * change those older daily rows are on the old basis (cached market data,
 * refetchable from the broker), and keeping them would put a cliff in the
 * Charts series, so the capture deletes them in the same transaction
 * (controller ruling, 2026-11-24, reversible).
 *
 * When no bar passes the guard nothing is deleted: an empty or wholly
 * corrupt answer from the broker must never wipe the stored window.
 */
export function replaceDailyBarsInWindow(
  db: Database.Database,
  securityId: number,
  startDate: string,
  bars: Array<OhlcvBar & { wap?: number | null; tradeCount?: number | null }>,
  opts: { deleteOlderDailyBars?: boolean } = {},
): ReplaceDailyBarsResult {
  const sane = bars.filter((b) => isSaneBar(b));
  if (sane.length === 0) return { inserted: 0, rejected: bars.length, olderDeleted: 0 };
  let result: ReplaceDailyBarsResult = { inserted: 0, rejected: 0, olderDeleted: 0 };
  db.transaction(() => {
    db.prepare(
      "DELETE FROM ohlcv_bars WHERE security_id = ? AND bar_size = '1 day' AND bar_date >= ?",
    ).run(securityId, startDate);
    let olderDeleted = 0;
    if (opts.deleteOlderDailyBars) {
      olderDeleted = db
        .prepare("DELETE FROM ohlcv_bars WHERE security_id = ? AND bar_size = '1 day' AND bar_date < ?")
        .run(securityId, startDate).changes;
    }
    result = { ...upsertOhlcvBars(db, securityId, "1 day", bars), olderDeleted };
  })();
  return result;
}
