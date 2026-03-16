import type Database from "better-sqlite3";
import { BarSizeSetting, SecType } from "@stoqey/ib";
import { getIbApi } from "./client";
import { RateLimiter } from "./rate-limiter";
import type { PriceFetchResult, PriceFetchProgress } from "./types";

function mapSecurityType(dbType: string | null): SecType {
  switch (dbType) {
    case "stock":
    case "etf":
      return SecType.STK;
    case "bond":
      return SecType.BOND;
    case "mutual_fund":
      return SecType.FUND;
    case "option":
      return SecType.OPT;
    default:
      return SecType.STK;
  }
}

const rateLimiter = new RateLimiter();

/** Milliseconds to wait between consecutive TWS requests to avoid IB pacing violations. */
const PACING_DELAY_MS = 500;

/** Per-request timeout — prevents a hung TWS call from blocking the entire batch. */
const REQUEST_TIMEOUT_MS = 30_000;

interface SecurityRow {
  id: number;
  symbol: string;
  security_type: string | null;
  ib_con_id: number | null;
}

/** Convert "20250131" → "2025-01-31" */
function formatBarDate(raw: string): string {
  if (raw.length === 8 && !raw.includes("-")) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  // May already be in YYYY-MM-DD format or contain time
  return raw.slice(0, 10);
}

/**
 * Fetch historical daily prices from TWS for securities in the database.
 *
 * Uses INSERT OR REPLACE so TWS prices (authoritative daily close)
 * overwrite any statement-sourced prices for the same date.
 *
 * Default query requires ib_con_id (set via Enrich Securities) and
 * excludes mutual funds and options. Pass securityIds to override.
 */
export async function fetchHistoricalPrices(
  db: Database.Database,
  options?: {
    securityIds?: number[];
    durationStr?: string; // e.g. "1 Y", "6 M", "30 D"
    endDate?: string; // YYYYMMDD format, default = now
    onProgress?: (progress: PriceFetchProgress) => void;
  },
): Promise<PriceFetchResult[]> {
  const api = getIbApi();
  if (!api) {
    throw new Error("TWS not connected");
  }

  // Get securities to fetch prices for
  let securities: SecurityRow[];
  if (options?.securityIds?.length) {
    const placeholders = options.securityIds.map(() => "?").join(",");
    securities = db
      .prepare(
        `SELECT id, symbol, security_type, ib_con_id FROM securities WHERE id IN (${placeholders})`,
      )
      .all(...options.securityIds) as SecurityRow[];
  } else {
    // Require ib_con_id — enrichment is the prerequisite for price fetching.
    // Excludes mutual funds (no TWS trade data) and options (need special handling).
    securities = db
      .prepare(
        `SELECT id, symbol, security_type, ib_con_id FROM securities
         WHERE ib_con_id IS NOT NULL
           AND (security_type IS NULL OR security_type NOT IN ('mutual_fund', 'option'))`,
      )
      .all() as SecurityRow[];
  }

  const results: PriceFetchResult[] = [];
  const durationStr = options?.durationStr ?? "1 Y";
  const onProgress = options?.onProgress;

  const upsertPrice = db.prepare(`
    INSERT OR REPLACE INTO prices (security_id, date, close_price, source)
    VALUES (?, ?, ?, 'tws')
  `);

  for (let i = 0; i < securities.length; i++) {
    const sec = securities[i];

    try {
      // Report rate-limit wait if we'd block
      const waitEstimate = rateLimiter.estimatedWaitSeconds;
      if (waitEstimate > 0) {
        onProgress?.({
          current: i + 1,
          total: securities.length,
          symbol: sec.symbol,
          status: "rate_limited",
          waitingSeconds: waitEstimate,
        });
      }

      await rateLimiter.waitForSlot();

      // Report active fetch
      onProgress?.({
        current: i + 1,
        total: securities.length,
        symbol: sec.symbol,
        status: "fetching",
      });

      // IB API requires secType even when conId is provided
      const secType = mapSecurityType(sec.security_type);
      const contract = sec.ib_con_id
        ? { conId: sec.ib_con_id, secType, exchange: "SMART", currency: "USD" }
        : { symbol: sec.symbol, secType, exchange: "SMART", currency: "USD" };

      // Race against timeout to prevent indefinite hangs
      const bars = await Promise.race([
        api.getHistoricalData(
          contract,
          options?.endDate ?? "", // empty = current time
          durationStr,
          BarSizeSetting.DAYS_ONE,
          "TRADES", // WhatToShow
          1, // useRTH = regular trading hours only
          1, // formatDate = YYYYMMDD strings
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Timeout after ${REQUEST_TIMEOUT_MS / 1000}s`)),
            REQUEST_TIMEOUT_MS,
          ),
        ),
      ]);

      let inserted = 0;
      let skipped = 0;

      db.transaction(() => {
        for (const bar of bars) {
          if (!bar.time || bar.close == null) {
            skipped++;
            continue;
          }
          const date = formatBarDate(bar.time);
          const result = upsertPrice.run(sec.id, date, bar.close);
          if (result.changes > 0) inserted++;
          else skipped++;
        }
      })();

      const fetchResult: PriceFetchResult = {
        symbol: sec.symbol,
        securityId: sec.id,
        barsInserted: inserted,
        barsSkipped: skipped,
        dateRange:
          bars.length > 0 && bars[0].time && bars[bars.length - 1].time
            ? {
                from: formatBarDate(bars[0].time),
                to: formatBarDate(bars[bars.length - 1].time!),
              }
            : null,
      };
      results.push(fetchResult);

      onProgress?.({
        current: i + 1,
        total: securities.length,
        symbol: sec.symbol,
        status: "done",
        result: fetchResult,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Unknown error";
      const fetchResult: PriceFetchResult = {
        symbol: sec.symbol,
        securityId: sec.id,
        barsInserted: 0,
        barsSkipped: 0,
        dateRange: null,
        error: errMsg,
      };
      results.push(fetchResult);

      onProgress?.({
        current: i + 1,
        total: securities.length,
        symbol: sec.symbol,
        status: "error",
        result: fetchResult,
      });
    }

    // Pacing delay between requests to avoid IB error 162 (pacing violation)
    if (i < securities.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, PACING_DELAY_MS));
    }
  }

  return results;
}

/** Expose rate limiter for status reporting. */
export function getRateLimiterStatus(): {
  activeRequests: number;
  maxRequests: number;
} {
  return {
    activeRequests: rateLimiter.activeCount,
    maxRequests: 55,
  };
}
