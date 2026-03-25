import type Database from "better-sqlite3";
import { MarketDataType, SecType, IBApiTickType } from "@stoqey/ib";
import { getIbApi } from "./client";
import type { PriceFetchProgress, SnapshotPriceResult } from "./types";

/**
 * Price extraction priority. During market hours LAST is the current trade
 * price; after hours CLOSE is the session close. DELAYED_* variants fire
 * when the user lacks real-time subscriptions for that exchange.
 */
const TICK_PRIORITY: Array<{ tick: number; label: string }> = [
  { tick: IBApiTickType.LAST, label: "LAST" },
  { tick: IBApiTickType.CLOSE, label: "CLOSE" },
  { tick: IBApiTickType.DELAYED_LAST, label: "DELAYED_LAST" },
  { tick: IBApiTickType.DELAYED_CLOSE, label: "DELAYED_CLOSE" },
];

/** Max concurrent snapshot requests — well under IB's ~100 market data line limit. */
const BATCH_SIZE = 10;

/** Per-snapshot timeout (11s collection + 4s margin). */
const SNAPSHOT_TIMEOUT_MS = 15_000;

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

interface SecurityRow {
  id: number;
  symbol: string;
  security_type: string | null;
  ib_con_id: number | null;
}

/**
 * Fetch current prices via market data snapshots (NOT subject to historical
 * rate limits). Processes securities in parallel batches for ~2 min total.
 */
export async function fetchSnapshotPrices(
  db: Database.Database,
  options?: {
    securityIds?: number[];
    onProgress?: (progress: PriceFetchProgress) => void;
  },
): Promise<SnapshotPriceResult[]> {
  const api = getIbApi();
  if (!api) {
    throw new Error("TWS not connected");
  }

  // Enable delayed/frozen data so after-hours snapshots still return prices
  api.setMarketDataType(MarketDataType.DELAYED_FROZEN);

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
         WHERE ib_con_id IS NOT NULL
           AND (security_type IS NULL OR security_type NOT IN ('mutual_fund', 'option'))`,
      )
      .all() as SecurityRow[];
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const upsertPrice = db.prepare(`
    INSERT OR REPLACE INTO prices (security_id, date, close_price, source)
    VALUES (?, ?, ?, 'tws')
  `);

  const results: SnapshotPriceResult[] = [];
  const onProgress = options?.onProgress;
  let doneCount = 0;

  // Process in parallel batches
  for (let batchStart = 0; batchStart < securities.length; batchStart += BATCH_SIZE) {
    const batch = securities.slice(batchStart, batchStart + BATCH_SIZE);

    const promises = batch.map(async (sec, batchIdx) => {
      const globalIdx = batchStart + batchIdx;

      onProgress?.({
        current: globalIdx + 1,
        total: securities.length,
        symbol: sec.symbol,
        status: "fetching",
      });

      const secType = mapSecurityType(sec.security_type);
      const contract = sec.ib_con_id
        ? { conId: sec.ib_con_id, secType, exchange: "SMART", currency: "USD" }
        : { symbol: sec.symbol, secType, exchange: "SMART", currency: "USD" };

      try {
        const snapshot = await Promise.race([
          api.getMarketDataSnapshot(contract, "", false),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Snapshot timeout after ${SNAPSHOT_TIMEOUT_MS / 1000}s`)),
              SNAPSHOT_TIMEOUT_MS,
            ),
          ),
        ]);

        // Extract price using priority chain
        let price: number | null = null;
        let tickLabel = "";

        for (const { tick, label } of TICK_PRIORITY) {
          const entry = snapshot.get(tick);
          if (entry?.value != null && entry.value > 0) {
            price = entry.value;
            tickLabel = label;
            break;
          }
        }

        const result: SnapshotPriceResult = {
          symbol: sec.symbol,
          securityId: sec.id,
          price,
          tickType: tickLabel || "NONE",
        };

        if (price !== null) {
          upsertPrice.run(sec.id, today, price);
        }

        doneCount++;
        onProgress?.({
          current: globalIdx + 1,
          total: securities.length,
          symbol: sec.symbol,
          status: price !== null ? "done" : "no_price",
          result: {
            symbol: sec.symbol,
            securityId: sec.id,
            barsInserted: price !== null ? 1 : 0,
            barsSkipped: 0,
            dateRange: price !== null ? { from: today, to: today } : null,
          },
        });

        return result;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        doneCount++;

        onProgress?.({
          current: globalIdx + 1,
          total: securities.length,
          symbol: sec.symbol,
          status: "error",
          result: {
            symbol: sec.symbol,
            securityId: sec.id,
            barsInserted: 0,
            barsSkipped: 0,
            dateRange: null,
            error: errMsg,
          },
        });

        return {
          symbol: sec.symbol,
          securityId: sec.id,
          price: null,
          tickType: "ERROR",
          error: errMsg,
        } satisfies SnapshotPriceResult;
      }
    });

    const batchResults = await Promise.allSettled(promises);
    for (const settled of batchResults) {
      if (settled.status === "fulfilled") {
        results.push(settled.value);
      }
    }
  }

  // Reset to real-time for subsequent requests
  try {
    api.setMarketDataType(MarketDataType.REALTIME);
  } catch {
    // Ignore — non-critical
  }

  return results;
}
