import type Database from "better-sqlite3";
import { BarSizeSetting, SecType, type WhatToShow } from "@stoqey/ib";
import {
  mapSecurityType,
  PRICE_FETCH_EXCLUDED_TYPES,
  getWhatToShow,
  getWhatToShowFallback,
} from "./security-type-map";
import { getIbApi } from "./client";
import { RateLimiter } from "./rate-limiter";
import { bumpIfPricesAffectSyntheticCloses } from "../compute/tax-convention";
import type { PriceFetchResult, PriceFetchProgress } from "./types";

const rateLimiter = new RateLimiter();

/** Milliseconds to wait between consecutive TWS request batches to avoid IB pacing violations. */
const PACING_DELAY_MS = 600;

/**
 * Max concurrent historical data requests per batch.
 * IB enforces ~6 concurrent historical data requests; we stay conservative at 3.
 * Combined with PACING_DELAY_MS between batches, this is ~3x faster than serial.
 */
const HISTORICAL_BATCH_SIZE = 3;

/** Per-request timeout — prevents a hung TWS call from blocking the entire batch. */
const REQUEST_TIMEOUT_MS = 30_000;

interface SecurityRow {
  id: number;
  symbol: string;
  security_type: string | null;
  ib_con_id: number | null;
  currency: string | null;
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
    incremental?: boolean; // only fetch dates newer than what's already in DB
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
        `SELECT id, symbol, security_type, ib_con_id, currency FROM securities WHERE id IN (${placeholders})`,
      )
      .all(...options.securityIds) as SecurityRow[];
  } else {
    // Require ib_con_id — enrichment is the prerequisite for price fetching.
    // Excludes mutual funds (no TWS trade data) and options (need special handling).
    securities = db
      .prepare(
        `SELECT id, symbol, security_type, ib_con_id, currency FROM securities
         WHERE ib_con_id IS NOT NULL
           AND (security_type IS NULL OR LOWER(security_type) NOT IN (${PRICE_FETCH_EXCLUDED_TYPES.map(() => "?").join(", ")}))`,
      )
      .all(...PRICE_FETCH_EXCLUDED_TYPES) as SecurityRow[];
  }

  const results: PriceFetchResult[] = [];
  const defaultDuration = options?.durationStr ?? "1 Y";
  const incremental = options?.incremental ?? false;
  const onProgress = options?.onProgress;

  const upsertPrice = db.prepare(`
    INSERT OR REPLACE INTO prices (security_id, date, close_price, source)
    VALUES (?, ?, ?, 'tws')
  `);

  const latestPriceStmt = db.prepare(
    `SELECT MAX(date) as latest FROM prices WHERE security_id = ? AND source = 'tws'`,
  );

  // ── Helper: fetch one security ────────────────────────────────
  async function fetchOne(sec: SecurityRow, globalIdx: number): Promise<PriceFetchResult> {
    // Incremental: compute gap duration per security
    let durationStr = defaultDuration;
    if (incremental && !options?.durationStr) {
      const row = latestPriceStmt.get(sec.id) as { latest: string | null } | undefined;
      if (row?.latest) {
        const latestDate = new Date(row.latest + "T00:00:00");
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const gapDays = Math.ceil((today.getTime() - latestDate.getTime()) / 86_400_000);
        if (gapDays <= 0) {
          onProgress?.({
            current: globalIdx + 1,
            total: securities.length,
            symbol: sec.symbol,
            status: "skipped",
          });
          return { symbol: sec.symbol, securityId: sec.id, barsInserted: 0, barsSkipped: 0, dateRange: null };
        }
        durationStr = gapDays >= 365 ? "1 Y" : `${gapDays} D`;
      }
    }

    await rateLimiter.waitForSlot();

    onProgress?.({
      current: globalIdx + 1,
      total: securities.length,
      symbol: sec.symbol,
      status: "fetching",
    });

    const secType = mapSecurityType(sec.security_type);
    // Options stay USD (listed equity/index options are USD-denominated
    // regardless of the underlying's currency); other types use the
    // security's own stored currency (Task 6/7b: foreign-currency valuation)
    // so a KRW-denominated held security isn't queried as USD.
    const currency = secType === SecType.OPT ? "USD" : sec.currency || "USD";
    const contract = sec.ib_con_id
      ? { conId: sec.ib_con_id, secType, exchange: "SMART", currency }
      : { symbol: sec.symbol, secType, exchange: "SMART", currency };

    // Choose whatToShow based on security type (bonds: BID_ASK, funds: MIDPOINT, stocks: TRADES)
    const whatToShow = getWhatToShow(sec.security_type);
    const fallbackWhatToShow = getWhatToShowFallback(sec.security_type);

    async function fetchBars(wts: WhatToShow) {
      return Promise.race([
        api!.getHistoricalData(
          contract,
          options?.endDate ?? "",
          durationStr,
          BarSizeSetting.DAYS_ONE,
          wts,
          1,
          1,
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Timeout after ${REQUEST_TIMEOUT_MS / 1000}s`)),
            REQUEST_TIMEOUT_MS,
          ),
        ),
      ]);
    }

    let bars = await fetchBars(whatToShow);

    // If primary whatToShow returned no bars, try the fallback
    if (bars.length === 0 && fallbackWhatToShow) {
      await rateLimiter.waitForSlot();
      bars = await fetchBars(fallbackWhatToShow);
    }

    let inserted = 0;
    let skipped = 0;

    db.transaction(() => {
      const pairs: { securityId: number; date: string }[] = [];
      for (const bar of bars) {
        if (!bar.time || bar.close == null) {
          skipped++;
          continue;
        }
        const date = formatBarDate(bar.time);
        const result = upsertPrice.run(sec.id, date, bar.close);
        if (result.changes > 0) {
          inserted++;
          pairs.push({ securityId: sec.id, date });
        } else {
          skipped++;
        }
      }
      // Same transaction as the writes above (spec §4) — this security's
      // bars + its synthetic-close bump roll back together on a throw.
      bumpIfPricesAffectSyntheticCloses(db, pairs);
    })();

    const fetchResult: PriceFetchResult = {
      symbol: sec.symbol,
      securityId: sec.id,
      barsInserted: inserted,
      barsSkipped: skipped,
      dateRange:
        bars.length > 0 && bars[0].time && bars[bars.length - 1].time
          ? { from: formatBarDate(bars[0].time), to: formatBarDate(bars[bars.length - 1].time!) }
          : null,
    };

    onProgress?.({
      current: globalIdx + 1,
      total: securities.length,
      symbol: sec.symbol,
      status: "done",
      result: fetchResult,
    });

    return fetchResult;
  }

  // ── Process in parallel batches (3x faster than serial) ──────
  for (let batchStart = 0; batchStart < securities.length; batchStart += HISTORICAL_BATCH_SIZE) {
    const batch = securities.slice(batchStart, batchStart + HISTORICAL_BATCH_SIZE);

    // Report rate-limit wait before batch
    const waitEstimate = rateLimiter.estimatedWaitSeconds;
    if (waitEstimate > 0) {
      onProgress?.({
        current: batchStart + 1,
        total: securities.length,
        symbol: batch.map((s) => s.symbol).join(", "),
        status: "rate_limited",
        waitingSeconds: waitEstimate,
      });
    }

    const batchPromises = batch.map((sec, batchIdx) =>
      fetchOne(sec, batchStart + batchIdx).catch((err): PriceFetchResult => {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        const fetchResult: PriceFetchResult = {
          symbol: sec.symbol,
          securityId: sec.id,
          barsInserted: 0,
          barsSkipped: 0,
          dateRange: null,
          error: errMsg,
        };
        onProgress?.({
          current: batchStart + batchIdx + 1,
          total: securities.length,
          symbol: sec.symbol,
          status: "error",
          result: fetchResult,
        });
        return fetchResult;
      })
    );

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);

    // Pacing delay between batches
    if (batchStart + HISTORICAL_BATCH_SIZE < securities.length) {
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
