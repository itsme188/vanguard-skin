import type Database from "better-sqlite3";
import { BarSizeSetting, SecType } from "@stoqey/ib";
import { getIbApi } from "./client";
import { RateLimiter } from "./rate-limiter";

// ─── Types ──────────────────────────────────────────────────────

export interface BenchmarkFetchProgress {
  symbol: string;
  status: "fetching" | "done" | "error" | "rate_limited";
  barsInserted?: number;
  error?: string;
  waitingSeconds?: number;
}

export interface BenchmarkFetchResult {
  symbol: string;
  barsInserted: number;
  dateRange: { from: string; to: string } | null;
  error?: string;
}

// ─── Known benchmarks ───────────────────────────────────────────

export const BENCHMARK_SYMBOLS = ["SPY", "QQQ", "DIA", "VTI"] as const;
export type BenchmarkSymbol = (typeof BENCHMARK_SYMBOLS)[number];

export const BENCHMARK_LABELS: Record<string, string> = {
  SPY: "S&P 500",
  QQQ: "Nasdaq 100",
  DIA: "Dow Jones",
  VTI: "Total Market",
};

// ─── Internals ──────────────────────────────────────────────────

const rateLimiter = new RateLimiter();
/** 60s timeout for first-ever 2Y fetch (500+ bars); incremental is fast. */
const REQUEST_TIMEOUT_MS = 60_000;

/** Convert "20250131" → "2025-01-31" */
function formatBarDate(raw: string): string {
  if (raw.length === 8 && !raw.includes("-")) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return raw.slice(0, 10);
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Fetch historical daily prices for benchmark ETFs from TWS.
 * Uses symbol-based contract resolution (no ib_con_id needed).
 * Stores results in `benchmark_prices` table.
 */
export async function fetchBenchmarkPrices(
  db: Database.Database,
  options?: {
    symbols?: string[];
    durationStr?: string; // e.g. "2 Y", default "2 Y"
    incremental?: boolean;
    onProgress?: (progress: BenchmarkFetchProgress) => void;
  }
): Promise<BenchmarkFetchResult[]> {
  const api = getIbApi();
  if (!api) throw new Error("TWS not connected");

  const symbols = options?.symbols ?? [...BENCHMARK_SYMBOLS];
  const defaultDuration = options?.durationStr ?? "2 Y";
  const incremental = options?.incremental ?? true;
  const onProgress = options?.onProgress;

  // Resolve conId for any benchmark symbols not yet in the securities table.
  // conId-based contracts are far more reliable than symbol-only for historical data.
  for (const sym of symbols) {
    const row = db.prepare(
      "SELECT ib_con_id FROM securities WHERE symbol = ? AND ib_con_id IS NOT NULL"
    ).get(sym) as { ib_con_id: number } | undefined;

    if (!row) {
      try {
        // Ensure the security row exists
        db.prepare(
          "INSERT OR IGNORE INTO securities (symbol, security_type) VALUES (?, 'etf')"
        ).run(sym);
        // Resolve conId via TWS
        const details = await api.getContractDetails({
          symbol: sym,
          secType: SecType.STK,
          exchange: "SMART",
          currency: "USD",
        });
        if (details.length > 0 && details[0].contract?.conId) {
          db.prepare("UPDATE securities SET ib_con_id = ? WHERE symbol = ?")
            .run(details[0].contract.conId, sym);
        }
      } catch {
        // Will fall back to symbol-based contract below
      }
    }
  }

  // Ensure table exists (migration should handle this, but be safe)
  db.exec(`
    CREATE TABLE IF NOT EXISTS benchmark_prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'tws',
      UNIQUE(symbol, date)
    )
  `);

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO benchmark_prices (symbol, date, close_price, source)
    VALUES (?, ?, ?, 'tws')
  `);

  const latestStmt = db.prepare(
    "SELECT MAX(date) AS latest FROM benchmark_prices WHERE symbol = ?"
  );

  const results: BenchmarkFetchResult[] = [];

  for (const symbol of symbols) {
    try {
      // Incremental: compute gap
      let durationStr = defaultDuration;
      if (incremental) {
        const row = latestStmt.get(symbol) as { latest: string | null } | undefined;
        if (row?.latest) {
          const latestDate = new Date(row.latest + "T00:00:00");
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const gapDays = Math.ceil((today.getTime() - latestDate.getTime()) / 86_400_000);
          if (gapDays <= 1) {
            onProgress?.({ symbol, status: "done", barsInserted: 0 });
            results.push({ symbol, barsInserted: 0, dateRange: null });
            continue;
          }
          // Add buffer days, cap at 2Y
          const fetchDays = Math.min(gapDays + 5, 730);
          durationStr = fetchDays >= 365 ? "2 Y" : `${fetchDays} D`;
        }
      }

      // Rate limit
      const wait = rateLimiter.estimatedWaitSeconds;
      if (wait > 0) {
        onProgress?.({ symbol, status: "rate_limited", waitingSeconds: wait });
      }
      await rateLimiter.waitForSlot();

      onProgress?.({ symbol, status: "fetching" });

      // Try to use conId from securities table (much more reliable than symbol-only)
      const knownSec = db
        .prepare("SELECT ib_con_id FROM securities WHERE symbol = ? AND ib_con_id IS NOT NULL")
        .get(symbol) as { ib_con_id: number } | undefined;

      const contract = knownSec
        ? { conId: knownSec.ib_con_id, secType: SecType.STK, exchange: "SMART", currency: "USD" }
        : { symbol, secType: SecType.STK, exchange: "SMART", currency: "USD" };

      const rawBars = await Promise.race([
        api.getHistoricalData(
          contract,
          "", // endDate = now
          durationStr,
          BarSizeSetting.DAYS_ONE,
          "TRADES",
          1, // useRTH = regular trading hours only
          1, // formatDate = YYYYMMDD strings
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Timeout fetching ${symbol}`)),
            REQUEST_TIMEOUT_MS
          )
        ),
      ]);

      const bars = (rawBars as Array<{ time?: string; date?: string; close?: number }>).map(b => ({
        time: b.time ?? b.date ?? "",
        close: b.close ?? 0,
      }));

      // Insert bars
      let inserted = 0;
      let firstDate = "";
      let lastDate = "";
      const tx = db.transaction(() => {
        for (const bar of bars) {
          if (!bar.time || bar.close <= 0) continue;
          const date = formatBarDate(bar.time);
          upsert.run(symbol, date, bar.close);
          if (!firstDate) firstDate = date;
          lastDate = date;
          inserted++;
        }
      });
      tx();

      onProgress?.({ symbol, status: "done", barsInserted: inserted });
      results.push({
        symbol,
        barsInserted: inserted,
        dateRange: inserted > 0 ? { from: firstDate, to: lastDate } : null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Fallback: populate from ohlcv_bars or prices table if the security has cached data
      const secRow = db.prepare(
        "SELECT id FROM securities WHERE symbol = ?"
      ).get(symbol) as { id: number } | undefined;

      let fallbackInserted = 0;
      if (secRow) {
        // Try ohlcv_bars first (chart cache), then prices table (valuation prices)
        let fallbackBars = db.prepare(
          `SELECT bar_date AS date, close AS close_price FROM ohlcv_bars
           WHERE security_id = ? AND bar_size = '1 day' AND close > 0
           ORDER BY bar_date`
        ).all(secRow.id) as { date: string; close_price: number }[];

        if (fallbackBars.length === 0) {
          fallbackBars = db.prepare(
            `SELECT date, close_price FROM prices
             WHERE security_id = ? AND close_price > 0
             ORDER BY date`
          ).all(secRow.id) as { date: string; close_price: number }[];
        }

        if (fallbackBars.length > 0) {
          const tx = db.transaction(() => {
            for (const bar of fallbackBars) {
              upsert.run(symbol, bar.date, bar.close_price);
              fallbackInserted++;
            }
          });
          tx();
        }
      }

      if (fallbackInserted > 0) {
        onProgress?.({ symbol, status: "done", barsInserted: fallbackInserted });
        results.push({
          symbol,
          barsInserted: fallbackInserted,
          dateRange: null,
          error: `TWS timeout — used ${fallbackInserted} cached bars`,
        });
      } else {
        onProgress?.({ symbol, status: "error", error: msg });
        results.push({ symbol, barsInserted: 0, dateRange: null, error: msg });
      }
    }
  }

  return results;
}
