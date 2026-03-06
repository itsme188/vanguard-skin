import type Database from "better-sqlite3";
import { SecType, BarSizeSetting } from "@stoqey/ib";
import { getIbApi } from "./client";
import { RateLimiter } from "./rate-limiter";
import type { PriceFetchResult } from "./types";

const rateLimiter = new RateLimiter();

interface SecurityRow {
  id: number;
  symbol: string;
  security_type: string | null;
  ib_con_id: number | null;
}

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
 */
export async function fetchHistoricalPrices(
  db: Database.Database,
  options?: {
    securityIds?: number[];
    durationStr?: string; // e.g. "1 Y", "6 M", "30 D"
    endDate?: string; // YYYYMMDD format, default = now
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
    securities = db
      .prepare(
        `SELECT id, symbol, security_type, ib_con_id FROM securities
         WHERE security_type IN ('stock', 'etf', 'bond', 'mutual_fund') OR security_type IS NULL`,
      )
      .all() as SecurityRow[];
  }

  const results: PriceFetchResult[] = [];
  const durationStr = options?.durationStr ?? "1 Y";

  const upsertPrice = db.prepare(`
    INSERT OR REPLACE INTO prices (security_id, date, close_price, source)
    VALUES (?, ?, ?, 'tws')
  `);

  for (const sec of securities) {
    try {
      await rateLimiter.waitForSlot();

      const contract = sec.ib_con_id
        ? { conId: sec.ib_con_id }
        : {
            symbol: sec.symbol,
            secType: mapSecurityType(sec.security_type),
            exchange: "SMART",
            currency: "USD",
          };

      const bars = await api.getHistoricalData(
        contract,
        options?.endDate ?? "", // empty = current time
        durationStr,
        BarSizeSetting.DAYS_ONE,
        "TRADES", // WhatToShow
        1, // useRTH = regular trading hours only
        1, // formatDate = YYYYMMDD strings
      );

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

      results.push({
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
      });
    } catch (err) {
      results.push({
        symbol: sec.symbol,
        securityId: sec.id,
        barsInserted: 0,
        barsSkipped: 0,
        dateRange: null,
        error: err instanceof Error ? err.message : "Unknown error",
      });
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
