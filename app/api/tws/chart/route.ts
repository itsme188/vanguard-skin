import { NextRequest, NextResponse } from "next/server";
import { BarSizeSetting, SecType } from "@stoqey/ib";
import { db } from "@/lib/db";
import { getOhlcvBars, getLatestOhlcvDate } from "@/lib/queries/ohlcv";
import { fetchOhlcvBars } from "@/lib/tws/ohlcv";
import { getIbApi } from "@/lib/tws/client";
import type { OhlcvBar } from "@/lib/tws/types";

const INTRADAY_BAR_SIZES = ["1 min", "5 mins"] as const;
const INTRADAY_TIMEOUT_MS = 15_000;

interface TransactionMarker {
  date: string;
  type: string;
  quantity: number | null;
  price: number | null;
}

function getTransactionsForSecurity(securityId: number): TransactionMarker[] {
  return db
    .prepare(
      `SELECT trade_date as date, type, quantity, price_per_share as price
       FROM transactions
       WHERE security_id = ? AND type IN ('BUY', 'SELL', 'BUY_TO_OPEN', 'SELL_TO_CLOSE', 'BUY_TO_CLOSE', 'SELL_TO_OPEN')
       ORDER BY trade_date`,
    )
    .all(securityId) as TransactionMarker[];
}

/**
 * POST /api/tws/chart — Get OHLCV bars for a single security.
 *
 * Returns cached data when fresh, fetches from TWS when stale or empty.
 * Falls back to cached data (with stale flag) when TWS is disconnected.
 * Includes transaction markers (BUY/SELL) for the security.
 *
 * Body: { securityId: number, barSize?: string, duration?: string, refresh?: boolean }
 */
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { securityId, barSize = "1 day", duration, refresh = false } = body;

  if (!securityId || typeof securityId !== "number") {
    return NextResponse.json(
      { error: "securityId (number) is required" },
      { status: 400 },
    );
  }

  const VALID_BAR_SIZES = ["1 day", "1 min", "5 mins"];
  if (!VALID_BAR_SIZES.includes(barSize)) {
    return NextResponse.json(
      { error: `Invalid barSize. Must be one of: ${VALID_BAR_SIZES.join(", ")}` },
      { status: 400 },
    );
  }

  // Look up the security for metadata
  const sec = db
    .prepare("SELECT id, symbol, ib_con_id, security_type FROM securities WHERE id = ?")
    .get(securityId) as { id: number; symbol: string; ib_con_id: number | null; security_type: string | null } | undefined;

  if (!sec) {
    return NextResponse.json(
      { error: `Security not found: id=${securityId}` },
      { status: 404 },
    );
  }

  // Fetch transactions for markers (lightweight, always from DB)
  const transactions = getTransactionsForSecurity(securityId);

  // --- Intraday path: always live from TWS, no caching ---
  if (INTRADAY_BAR_SIZES.includes(barSize as typeof INTRADAY_BAR_SIZES[number])) {
    if (!sec.ib_con_id) {
      return NextResponse.json({
        bars: [], symbol: sec.symbol, securityId: sec.id, barSize,
        cached: false, stale: false, lastBarDate: null, transactions,
        warning: "No IB contract ID. Run Enrich Securities first.",
      });
    }

    const api = getIbApi();
    if (!api) {
      return NextResponse.json({
        bars: [], symbol: sec.symbol, securityId: sec.id, barSize,
        cached: false, stale: false, lastBarDate: null, transactions,
        warning: "TWS not connected. Intraday requires a live connection.",
      });
    }

    try {
      const ibBarSize = barSize === "1 min" ? BarSizeSetting.MINUTES_ONE : BarSizeSetting.MINUTES_FIVE;
      const intradayDuration = barSize === "1 min" ? "1 D" : "2 D";
      const secType = sec.security_type === "bond" ? SecType.BOND
        : sec.security_type === "option" ? SecType.OPT
        : sec.security_type === "mutual_fund" ? SecType.FUND
        : SecType.STK;

      const rawBars = await Promise.race([
        api.getHistoricalData(
          { conId: sec.ib_con_id, secType, exchange: "SMART", currency: "USD" },
          "", // current time
          intradayDuration,
          ibBarSize,
          "TRADES",
          0, // useRTH=0 → include extended hours
          2, // formatDate=2 → epoch seconds for intraday
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Intraday timeout (${INTRADAY_TIMEOUT_MS / 1000}s)`)), INTRADAY_TIMEOUT_MS),
        ),
      ]);

      const bars: OhlcvBar[] = [];
      for (const bar of rawBars) {
        if (!bar.time || bar.close == null) continue;
        // formatDate=2 returns epoch seconds as string
        const epoch = parseInt(bar.time, 10);
        const d = new Date(epoch * 1000);
        const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
        bars.push({
          date: dateStr,
          open: bar.open ?? bar.close,
          high: bar.high ?? bar.close,
          low: bar.low ?? bar.close,
          close: bar.close,
          volume: bar.volume ?? null,
        });
      }

      return NextResponse.json({
        bars,
        symbol: sec.symbol,
        securityId: sec.id,
        barSize,
        cached: false,
        stale: false,
        lastBarDate: bars.length > 0 ? bars[bars.length - 1].date : null,
        transactions,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 500 });
    }
  }

  // --- Daily path: cached + incremental fetch ---

  // Check cached data
  const latestDate = getLatestOhlcvDate(db, securityId, barSize);
  const cachedBars = latestDate ? getOhlcvBars(db, securityId, barSize) : [];

  // Determine if cache is fresh enough (within 1 calendar day for daily bars)
  const isFresh = (() => {
    if (!latestDate || refresh) return false;
    const latest = new Date(latestDate + "T00:00:00");
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const gapDays = Math.ceil(
      (today.getTime() - latest.getTime()) / 86_400_000,
    );
    // Fresh if latest bar is from today or the most recent trading day
    // (weekends: Friday's bar is fine on Saturday/Sunday)
    const dayOfWeek = today.getDay(); // 0=Sun, 6=Sat
    const maxGap = dayOfWeek === 0 ? 2 : dayOfWeek === 6 ? 1 : 0;
    return gapDays <= maxGap;
  })();

  if (isFresh && !refresh) {
    return NextResponse.json({
      bars: cachedBars,
      symbol: sec.symbol,
      securityId: sec.id,
      barSize,
      cached: true,
      stale: false,
      lastBarDate: latestDate,
      transactions,
    });
  }

  // Need fresh data — check if TWS is available
  if (!sec.ib_con_id) {
    // No contract ID — can only serve cached data
    return NextResponse.json({
      bars: cachedBars,
      symbol: sec.symbol,
      securityId: sec.id,
      barSize,
      cached: true,
      stale: cachedBars.length > 0,
      lastBarDate: latestDate,
      warning: "No IB contract ID. Run Enrich Securities first.",
      transactions,
    });
  }

  const api = getIbApi();
  if (!api) {
    // TWS disconnected — serve stale cache
    return NextResponse.json({
      bars: cachedBars,
      symbol: sec.symbol,
      securityId: sec.id,
      barSize,
      cached: true,
      stale: cachedBars.length > 0,
      lastBarDate: latestDate,
      warning: "TWS not connected. Showing cached data.",
      transactions,
    });
  }

  // Fetch fresh OHLCV from TWS
  try {
    const result = await fetchOhlcvBars(db, {
      securityId,
      durationStr: duration,
      incremental: !refresh, // full refetch if refresh=true
    });

    return NextResponse.json({
      bars: result.bars,
      symbol: result.symbol,
      securityId: sec.id,
      barSize,
      cached: result.fromCache,
      stale: false,
      lastBarDate:
        result.bars.length > 0
          ? result.bars[result.bars.length - 1].date
          : null,
      barsInserted: result.barsInserted,
      transactions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    // On TWS error, fall back to cached data if available
    if (cachedBars.length > 0) {
      return NextResponse.json({
        bars: cachedBars,
        symbol: sec.symbol,
        securityId: sec.id,
        barSize,
        cached: true,
        stale: true,
        lastBarDate: latestDate,
        warning: `TWS error: ${message}. Showing cached data.`,
        transactions,
      });
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
