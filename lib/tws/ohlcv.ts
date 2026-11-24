import type Database from "better-sqlite3";
import { BarSizeSetting, SecType } from "@stoqey/ib";
import { getIbApi } from "./client";
import { RateLimiter } from "./rate-limiter";
import { mapSecurityType } from "./security-type-map";
import { getLatestOhlcvDate } from "@/lib/queries/ohlcv";
import { upsertOhlcvBars } from "@/lib/mutations/ohlcv";
import { isMarketClosed } from "@/lib/calendar/market-holidays";
import type { OhlcvBar } from "./types";

/** Reuse the same rate limiter on globalThis to survive Turbopack HMR reloads. */
const g = globalThis as unknown as { __tws_ohlcv_rateLimiter?: RateLimiter };
if (!g.__tws_ohlcv_rateLimiter) {
  g.__tws_ohlcv_rateLimiter = new RateLimiter();
}
const rateLimiter = g.__tws_ohlcv_rateLimiter;

const PACING_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;

/** Convert "20250131" → "2025-01-31" */
function formatBarDate(raw: string): string {
  if (raw.length === 8 && !raw.includes("-")) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return raw.slice(0, 10);
}

interface SecurityRow {
  id: number;
  symbol: string;
  security_type: string | null;
  ib_con_id: number | null;
  currency: string | null;
}

export interface FetchOhlcvOptions {
  securityId: number;
  barSize?: BarSizeSetting;
  durationStr?: string; // e.g. "1 Y", "6 M", "30 D"
  incremental?: boolean; // only fetch gap since last stored bar
  onProgress?: (msg: string) => void;
  /**
   * Daily-bar capture only (Gains at risk, ruling C1). Bars dated after this
   * `YYYY-MM-DD`, and bars dated on a closed market day, are dropped before
   * anything is stored or returned: a request ending "now" returns today's
   * bar while the session is still open, and that bar is not a close.
   * Absent: every bar is kept, exactly as before (the Charts route).
   */
  maxBarDate?: string;
  /**
   * `false` returns the fetched bars without writing them, so the caller can
   * compare them with what is stored before deciding how to write (the
   * daily-bar capture, ruling C2). Absent or `true`: stored, as before.
   */
  store?: boolean;
}

/** A fetched bar, with the broker's extra fields kept for the writer. */
export type FetchedOhlcvBar = OhlcvBar & { wap?: number | null; tradeCount?: number | null };

export interface FetchOhlcvResult {
  /**
   * With `store: false`, the fetched bars themselves (after `maxBarDate`).
   * Otherwise the full stored set for the security, as before.
   */
  bars: FetchedOhlcvBar[];
  barsInserted: number;
  fromCache: boolean;
  symbol: string;
}

/**
 * The bars of a daily series that may be stored: dated on or before
 * `maxBarDate` and on a day the market was open. Order is kept.
 */
export function storableDailyBars<T extends { date: string }>(bars: T[], maxBarDate: string): T[] {
  return bars.filter((b) => {
    const day = b.date.slice(0, 10);
    return day <= maxBarDate && !isMarketClosed(day);
  });
}

/**
 * Fetch OHLCV bars for a single security from TWS and store in the database.
 *
 * On-demand (not batch) — called when a user opens a chart for a specific security.
 * Supports incremental mode: checks the latest stored bar date and only fetches the gap.
 */
export async function fetchOhlcvBars(
  db: Database.Database,
  options: FetchOhlcvOptions,
): Promise<FetchOhlcvResult> {
  const api = getIbApi();
  if (!api) {
    throw new Error("TWS not connected");
  }

  const sec = db
    .prepare(
      "SELECT id, symbol, security_type, ib_con_id, currency FROM securities WHERE id = ?",
    )
    .get(options.securityId) as SecurityRow | undefined;

  if (!sec) {
    throw new Error(`Security not found: id=${options.securityId}`);
  }
  if (!sec.ib_con_id) {
    throw new Error(
      `Security ${sec.symbol} has no IB contract ID. Run Enrich Securities first.`,
    );
  }

  const barSize = options.barSize ?? BarSizeSetting.DAYS_ONE;
  const barSizeStr =
    barSize === BarSizeSetting.DAYS_ONE ? "1 day" : String(barSize);

  // Incremental: compute gap duration
  let durationStr = options.durationStr ?? "1 Y";
  if (options.incremental !== false) {
    const latestDate = getLatestOhlcvDate(db, sec.id, barSizeStr);
    if (latestDate) {
      const latest = new Date(latestDate + "T00:00:00");
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const gapDays = Math.ceil(
        (today.getTime() - latest.getTime()) / 86_400_000,
      );
      if (gapDays <= 0) {
        // Already up to date — return cached data
        options.onProgress?.(`${sec.symbol}: already up to date`);
        const { getOhlcvBars } = await import("@/lib/queries/ohlcv");
        return {
          bars: getOhlcvBars(db, sec.id, barSizeStr),
          barsInserted: 0,
          fromCache: true,
          symbol: sec.symbol,
        };
      }
      // Only override duration if user didn't specify one explicitly
      if (!options.durationStr) {
        durationStr = gapDays >= 365 ? "1 Y" : `${gapDays + 5} D`;
      }
    }
  }

  options.onProgress?.(`${sec.symbol}: waiting for rate limit slot...`);
  await rateLimiter.waitForSlot();
  await new Promise((resolve) => setTimeout(resolve, PACING_DELAY_MS));

  options.onProgress?.(`${sec.symbol}: fetching ${durationStr} of ${barSizeStr} bars...`);

  const secType = mapSecurityType(sec.security_type);
  // Options stay USD (listed equity/index options are USD-denominated
  // regardless of the underlying's currency); other types use the
  // security's own stored currency (Task 6/7b: foreign-currency valuation)
  // so a KRW-denominated held security isn't queried as USD.
  const contract = {
    conId: sec.ib_con_id,
    secType,
    exchange: "SMART",
    currency: secType === SecType.OPT ? "USD" : sec.currency || "USD",
  };

  const rawBars = await Promise.race([
    api.getHistoricalData(
      contract,
      "", // empty = current time
      durationStr,
      barSize,
      "TRADES",
      1, // useRTH = regular trading hours
      1, // formatDate = YYYYMMDD strings
    ),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timeout after ${REQUEST_TIMEOUT_MS / 1000}s`)),
        REQUEST_TIMEOUT_MS,
      ),
    ),
  ]);

  // Transform IB bars to our format
  let bars: FetchedOhlcvBar[] = [];
  for (const bar of rawBars) {
    if (!bar.time || bar.close == null) continue;
    bars.push({
      date: formatBarDate(bar.time),
      open: bar.open ?? bar.close,
      high: bar.high ?? bar.close,
      low: bar.low ?? bar.close,
      close: bar.close,
      volume: bar.volume ?? null,
      wap: bar.WAP ?? null,
      tradeCount: bar.count ?? null,
    });
  }

  if (options.maxBarDate !== undefined) {
    bars = storableDailyBars(bars, options.maxBarDate);
  }

  if (options.store === false) {
    options.onProgress?.(`${sec.symbol}: fetched ${bars.length} bars (not stored)`);
    return { bars, barsInserted: 0, fromCache: false, symbol: sec.symbol };
  }

  // Store in database
  const { inserted } = upsertOhlcvBars(db, sec.id, barSizeStr, bars);
  options.onProgress?.(`${sec.symbol}: stored ${inserted} bars`);

  // Return full cached set (includes previously stored bars for complete chart)
  const { getOhlcvBars } = await import("@/lib/queries/ohlcv");
  return {
    bars: getOhlcvBars(db, sec.id, barSizeStr),
    barsInserted: inserted,
    fromCache: false,
    symbol: sec.symbol,
  };
}
