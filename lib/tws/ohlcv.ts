import type Database from "better-sqlite3";
import { BarSizeSetting, SecType } from "@stoqey/ib";
import { getIbApi } from "./client";
import { RateLimiter } from "./rate-limiter";
import { mapSecurityType } from "./security-type-map";
import { getLatestOhlcvDate } from "@/lib/queries/ohlcv";
import { upsertOhlcvBars } from "@/lib/mutations/ohlcv";
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
}

export interface FetchOhlcvOptions {
  securityId: number;
  barSize?: BarSizeSetting;
  durationStr?: string; // e.g. "1 Y", "6 M", "30 D"
  incremental?: boolean; // only fetch gap since last stored bar
  onProgress?: (msg: string) => void;
}

export interface FetchOhlcvResult {
  bars: OhlcvBar[];
  barsInserted: number;
  fromCache: boolean;
  symbol: string;
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
      "SELECT id, symbol, security_type, ib_con_id FROM securities WHERE id = ?",
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
  const contract = {
    conId: sec.ib_con_id,
    secType,
    exchange: "SMART",
    currency: "USD",
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
  const bars: Array<OhlcvBar & { wap?: number | null; tradeCount?: number | null }> = [];
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

  // Store in database
  const inserted = upsertOhlcvBars(db, sec.id, barSizeStr, bars);
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
