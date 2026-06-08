import type Database from "better-sqlite3";
import { BENCHMARK_SYMBOLS } from "./symbols";

export interface BenchmarkClose {
  date: string; // YYYY-MM-DD (ET trading day)
  close: number;
}

export type BenchmarkSeriesFetcher = (
  symbols: string[],
) => Promise<Record<string, BenchmarkClose[]> | null>;

export interface BenchmarkYahooResult {
  symbol: string;
  inserted: number;
}

/** epoch seconds → ET calendar date (YYYY-MM-DD). */
function epochToEtDate(epochSec: number): string {
  // en-CA renders ISO-style YYYY-MM-DD; the timeZone anchors each bar to its
  // trading day so closes land on the right date regardless of where the Mac is.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(epochSec * 1000));
}

/**
 * Default network adapter — Yahoo Finance daily chart bars (free, no auth).
 * Reads the `timestamp[]` + `indicators.quote[0].close[]` arrays so every close
 * is stamped with its ET trading day (sibling of `fetchYahooQuotes` in
 * `lib/queries/market-snapshot.ts`, which reads the `meta` block instead). This
 * is the DI boundary; the upsert logic is unit-tested with an injected stub.
 * Returns null if every symbol fails.
 */
export const fetchYahooBenchmarkSeries: BenchmarkSeriesFetcher = async (symbols) => {
  const out: Record<string, BenchmarkClose[]> = {};
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const url =
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
          `?interval=1d&range=1mo`;
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!res.ok) return;
        const json = (await res.json()) as {
          chart?: {
            result?: {
              timestamp?: number[];
              indicators?: { quote?: { close?: (number | null)[] }[] };
            }[];
          };
        };
        const result = json?.chart?.result?.[0];
        const ts = result?.timestamp;
        const closes = result?.indicators?.quote?.[0]?.close;
        if (!ts || !closes) return;

        const series: BenchmarkClose[] = [];
        for (let i = 0; i < ts.length; i++) {
          const c = closes[i];
          if (typeof c === "number" && c > 0) {
            series.push({ date: epochToEtDate(ts[i]), close: c });
          }
        }
        if (series.length > 0) out[sym.toUpperCase()] = series;
      } catch {
        /* skip this symbol */
      }
    }),
  );
  return Object.keys(out).length > 0 ? out : null;
};

/**
 * Fetch benchmark ETF daily closes from a TWS-free source (Yahoo by default)
 * and upsert them into `benchmark_prices` with `source='yahoo'`.
 *
 * This keeps the Momentum Pulse tile fresh on the QUICK auto-refresh tier. The
 * TWS historical fetch (`lib/tws/benchmark.ts`) only runs on the connect-time
 * FULL refresh and needs TWS connected, so without this the benchmark closes
 * froze for the rest of every session (and all weekend with TWS off). Benchmark
 * ETF closes are public market data — there's no reason to gate them on a
 * brokerage session.
 *
 * `fetchSeries` is injected for testing. Best-effort: per-symbol failures are
 * skipped; a total fetch failure returns [] and writes nothing.
 */
export async function fetchBenchmarkClosesFromYahoo(
  db: Database.Database,
  opts?: { symbols?: string[]; fetchSeries?: BenchmarkSeriesFetcher },
): Promise<BenchmarkYahooResult[]> {
  const symbols = opts?.symbols ?? [...BENCHMARK_SYMBOLS];
  const fetchSeries = opts?.fetchSeries ?? fetchYahooBenchmarkSeries;

  const series = await fetchSeries(symbols);
  if (!series) return [];

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
    VALUES (?, ?, ?, 'yahoo')
  `);

  const results: BenchmarkYahooResult[] = [];
  for (const symbol of symbols) {
    const key = symbol.toUpperCase();
    const bars = series[key];
    if (!bars || bars.length === 0) {
      results.push({ symbol: key, inserted: 0 });
      continue;
    }
    let inserted = 0;
    const tx = db.transaction(() => {
      for (const bar of bars) {
        if (!bar.date || !(bar.close > 0)) continue;
        upsert.run(key, bar.date, bar.close);
        inserted++;
      }
    });
    tx();
    results.push({ symbol: key, inserted });
  }
  return results;
}
