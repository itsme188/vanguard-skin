import type Database from "better-sqlite3";
import type { GroupedTrade } from "@/lib/compute/trade-roundtrips";

interface TradeMarketContext {
  symbol: string;
  exitDate: string;
  stockContext: StockPriceContext | null;
  benchmarkReturn: number | null; // SPY return over same period, as decimal
  positionPctOfPortfolio: number | null; // at entry, as decimal
}

interface StockPriceContext {
  periodHigh: number;
  periodHighDate: string;
  periodLow: number;
  periodLowDate: string;
  entryPrice: number;
  exitPrice: number;
  stockReturn: number; // as decimal
}

/**
 * Fetch market context for each grouped trade: stock price history,
 * SPY benchmark comparison, and position sizing.
 * Falls back gracefully when data is unavailable.
 */
export function getMarketContext(
  db: Database.Database,
  groupedTrades: GroupedTrade[],
  accountId: number
): TradeMarketContext[] {
  return groupedTrades.map((trade) => ({
    symbol: trade.symbol,
    exitDate: trade.exitDate,
    stockContext: getStockPriceContext(
      db,
      trade.securityId,
      trade.earliestEntryDate,
      trade.exitDate,
      trade.avgEntryPrice,
      trade.exitPrice
    ),
    benchmarkReturn: getBenchmarkReturn(
      db,
      trade.earliestEntryDate,
      trade.exitDate
    ),
    positionPctOfPortfolio: getPositionSize(
      db,
      accountId,
      trade.earliestEntryDate,
      trade.totalCost
    ),
  }));
}

/**
 * Format market context as markdown for the prompt.
 */
export function formatMarketContext(
  contexts: TradeMarketContext[],
  groupedTrades: GroupedTrade[]
): string {
  const sections: string[] = [];

  for (let i = 0; i < contexts.length; i++) {
    const ctx = contexts[i];
    const trade = groupedTrades[i];
    const lines: string[] = [];

    lines.push(
      `### Trade ${i + 1}: ${ctx.symbol} Market Context (${trade.earliestEntryDate} → ${trade.exitDate})`
    );

    if (ctx.stockContext) {
      const sc = ctx.stockContext;
      const stockReturnPct = (sc.stockReturn * 100).toFixed(1);
      const peakAboveEntry =
        sc.entryPrice > 0
          ? (((sc.periodHigh - sc.entryPrice) / sc.entryPrice) * 100).toFixed(1)
          : "N/A";
      const troughBelowEntry =
        sc.entryPrice > 0
          ? (((sc.periodLow - sc.entryPrice) / sc.entryPrice) * 100).toFixed(1)
          : "N/A";

      lines.push(
        `- Price range: $${sc.periodLow.toFixed(2)} low (${sc.periodLowDate}) → $${sc.periodHigh.toFixed(2)} high (${sc.periodHighDate})`
      );
      lines.push(
        `- Entry $${sc.entryPrice.toFixed(2)} → Exit $${sc.exitPrice.toFixed(2)} (${stockReturnPct}%)`
      );
      lines.push(
        `- Peak above entry: +${peakAboveEntry}% | Max drawdown from entry: ${troughBelowEntry}%`
      );
    } else {
      lines.push(`- Price history unavailable for this security and period`);
    }

    if (ctx.benchmarkReturn !== null) {
      const benchPct = (ctx.benchmarkReturn * 100).toFixed(1);
      const tradeReturn = trade.returnPct;
      const diff = (tradeReturn - ctx.benchmarkReturn * 100).toFixed(1);
      const label = Number(diff) >= 0 ? "outperformed" : "underperformed";
      lines.push(
        `- SPY same period: ${benchPct}% (${label} by ${Math.abs(Number(diff)).toFixed(1)}%)`
      );
    }

    if (ctx.positionPctOfPortfolio !== null) {
      lines.push(
        `- Position size at entry: ~${(ctx.positionPctOfPortfolio * 100).toFixed(1)}% of portfolio`
      );
    }

    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

// ─── Internal helpers ────────────────────────────────────────────

function getStockPriceContext(
  db: Database.Database,
  securityId: number,
  startDate: string,
  endDate: string,
  entryPrice: number,
  exitPrice: number
): StockPriceContext | null {
  // Try ohlcv_bars first (has high/low data)
  const ohlcv = db
    .prepare(
      `SELECT bar_date, high, low, close
       FROM ohlcv_bars
       WHERE security_id = ? AND bar_date >= ? AND bar_date <= ? AND bar_size = '1 day'
       ORDER BY bar_date`
    )
    .all(securityId, startDate, endDate) as Array<{
    bar_date: string;
    high: number;
    low: number;
    close: number;
  }>;

  if (ohlcv.length > 0) {
    let periodHigh = -Infinity,
      periodHighDate = "";
    let periodLow = Infinity,
      periodLowDate = "";

    for (const bar of ohlcv) {
      if (bar.high > periodHigh) {
        periodHigh = bar.high;
        periodHighDate = bar.bar_date;
      }
      if (bar.low < periodLow) {
        periodLow = bar.low;
        periodLowDate = bar.bar_date;
      }
    }

    return {
      periodHigh,
      periodHighDate,
      periodLow,
      periodLowDate,
      entryPrice,
      exitPrice,
      stockReturn: entryPrice > 0 ? (exitPrice - entryPrice) / entryPrice : 0,
    };
  }

  // Fallback: prices table (close only — use close as proxy for high/low)
  const prices = db
    .prepare(
      `SELECT date, close_price
       FROM prices
       WHERE security_id = ? AND date >= ? AND date <= ?
       ORDER BY date`
    )
    .all(securityId, startDate, endDate) as Array<{
    date: string;
    close_price: number;
  }>;

  if (prices.length > 0) {
    let periodHigh = -Infinity,
      periodHighDate = "";
    let periodLow = Infinity,
      periodLowDate = "";

    for (const p of prices) {
      if (p.close_price > periodHigh) {
        periodHigh = p.close_price;
        periodHighDate = p.date;
      }
      if (p.close_price < periodLow) {
        periodLow = p.close_price;
        periodLowDate = p.date;
      }
    }

    return {
      periodHigh,
      periodHighDate,
      periodLow,
      periodLowDate,
      entryPrice,
      exitPrice,
      stockReturn: entryPrice > 0 ? (exitPrice - entryPrice) / entryPrice : 0,
    };
  }

  return null;
}

function getBenchmarkReturn(
  db: Database.Database,
  startDate: string,
  endDate: string
): number | null {
  // Try benchmark_prices first
  const benchStart = db
    .prepare(
      `SELECT close_price FROM benchmark_prices
       WHERE symbol = 'SPY' AND date >= ?
       ORDER BY date ASC LIMIT 1`
    )
    .get(startDate) as { close_price: number } | undefined;

  const benchEnd = db
    .prepare(
      `SELECT close_price FROM benchmark_prices
       WHERE symbol = 'SPY' AND date <= ?
       ORDER BY date DESC LIMIT 1`
    )
    .get(endDate) as { close_price: number } | undefined;

  if (benchStart && benchEnd) {
    return (benchEnd.close_price - benchStart.close_price) / benchStart.close_price;
  }

  // Fallback: SPY in ohlcv_bars (if tracked as a security)
  const spySecurity = db
    .prepare(`SELECT id FROM securities WHERE UPPER(symbol) = 'SPY' LIMIT 1`)
    .get() as { id: number } | undefined;

  if (spySecurity) {
    const ohlcvStart = db
      .prepare(
        `SELECT close FROM ohlcv_bars
         WHERE security_id = ? AND bar_date >= ? AND bar_size = '1 day'
         ORDER BY bar_date ASC LIMIT 1`
      )
      .get(spySecurity.id, startDate) as { close: number } | undefined;

    const ohlcvEnd = db
      .prepare(
        `SELECT close FROM ohlcv_bars
         WHERE security_id = ? AND bar_date <= ? AND bar_size = '1 day'
         ORDER BY bar_date DESC LIMIT 1`
      )
      .get(spySecurity.id, endDate) as { close: number } | undefined;

    if (ohlcvStart && ohlcvEnd) {
      return (ohlcvEnd.close - ohlcvStart.close) / ohlcvStart.close;
    }
  }

  // Fallback: SPY in prices table
  if (spySecurity) {
    const priceStart = db
      .prepare(
        `SELECT close_price FROM prices
         WHERE security_id = ? AND date >= ?
         ORDER BY date ASC LIMIT 1`
      )
      .get(spySecurity.id, startDate) as { close_price: number } | undefined;

    const priceEnd = db
      .prepare(
        `SELECT close_price FROM prices
         WHERE security_id = ? AND date <= ?
         ORDER BY date DESC LIMIT 1`
      )
      .get(spySecurity.id, endDate) as { close_price: number } | undefined;

    if (priceStart && priceEnd) {
      return (priceEnd.close_price - priceStart.close_price) / priceStart.close_price;
    }
  }

  return null;
}

function getPositionSize(
  db: Database.Database,
  accountId: number,
  entryDate: string,
  positionCost: number
): number | null {
  // Find portfolio total value nearest to entry date
  const valuation = db
    .prepare(
      `SELECT total_value FROM daily_valuations
       WHERE account_id = ? AND valuation_date <= ?
       ORDER BY valuation_date DESC LIMIT 1`
    )
    .get(accountId, entryDate) as { total_value: number } | undefined;

  if (valuation && valuation.total_value > 0) {
    return positionCost / valuation.total_value;
  }

  return null;
}

export type { TradeMarketContext, StockPriceContext };
