import type Database from "better-sqlite3";
import type { GroupedTrade } from "@/lib/compute/trade-roundtrips";

interface TradeMarketContext {
  symbol: string;
  exitDate: string;
  stockContext: StockPriceContext | null;
  benchmarkReturn: number | null; // SPY return over same period, as decimal
  positionPctOfPortfolio: number | null; // at entry, as decimal
  remainingPosition: RemainingPositionContext | null;
  concurrentActivity: ConcurrentActivity | null;
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

interface RemainingPositionContext {
  remainingShares: number;
  soldShares: number;
  retainedPct: number; // percentage of original position retained (0-1)
  isTrim: boolean; // true if shares remain after the sale
}

interface ConcurrentActivity {
  buys: Array<{
    symbol: string;
    quantity: number;
    totalCost: number;
    date: string;
  }>;
  totalBuyAmount: number;
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
    remainingPosition: getRemainingPosition(
      db,
      trade.securityId,
      accountId,
      trade.totalQuantity
    ),
    concurrentActivity: getConcurrentActivity(
      db,
      accountId,
      trade.exitDate
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
    } else if (ctx.stockContext) {
      // Explicitly note missing benchmark to prevent hallucination
      lines.push(`- SPY benchmark: insufficient price data for this period`);
    }

    if (ctx.positionPctOfPortfolio !== null) {
      lines.push(
        `- Position size at entry: ~${(ctx.positionPctOfPortfolio * 100).toFixed(1)}% of portfolio`
      );
    }

    if (ctx.remainingPosition) {
      const rp = ctx.remainingPosition;
      if (rp.isTrim) {
        lines.push(
          `- Position action: TRIM — sold ${formatQty(rp.soldShares)} shares, retained ${formatQty(rp.remainingShares)} shares (${(rp.retainedPct * 100).toFixed(0)}% of position kept)`
        );
      } else {
        lines.push(`- Position action: FULL EXIT — no remaining shares`);
      }
    }

    if (ctx.concurrentActivity && ctx.concurrentActivity.buys.length > 0) {
      const ca = ctx.concurrentActivity;
      const buyList = ca.buys
        .map(
          (b) =>
            `${formatQty(b.quantity)} ${b.symbol} ($${b.totalCost.toLocaleString("en-US", { maximumFractionDigits: 0 })}) on ${b.date}`
        )
        .join(", ");
      lines.push(`- Concurrent buys (±7d): ${buyList}`);
      lines.push(
        `- Total deployed nearby: $${ca.totalBuyAmount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
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
  // Build a unified per-date {high, low} map from BOTH `ohlcv_bars` and
  // `prices`. The two tables are written by independent pipelines and drift
  // apart — e.g. TWS daily-bar sync may stall mid-month while daily-snapshot
  // prices keep being written. Preferring whichever covers a given date
  // closes the gap.
  //
  // We also fold in the trade's actual entry and exit prices: those are real
  // market-traded prices for this security on those dates, so they belong in
  // the period range. (Without this, `periodHigh` could be lower than the
  // exit price, which the AI then narrates as a "gap-through.")
  const byDate = new Map<string, { high: number; low: number }>();

  const ohlcv = db
    .prepare(
      `SELECT bar_date, high, low
       FROM ohlcv_bars
       WHERE security_id = ? AND bar_date >= ? AND bar_date <= ? AND bar_size = '1 day'
       ORDER BY bar_date`
    )
    .all(securityId, startDate, endDate) as Array<{
    bar_date: string;
    high: number;
    low: number;
  }>;

  for (const bar of ohlcv) {
    byDate.set(bar.bar_date, { high: bar.high, low: bar.low });
  }

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

  for (const p of prices) {
    // Don't overwrite existing OHLC bars (richer data) — only fill gaps.
    if (!byDate.has(p.date)) {
      byDate.set(p.date, { high: p.close_price, low: p.close_price });
    }
  }

  // Always fold the trade's own entry + exit prices into the range. These
  // are guaranteed-real prices for the security on those dates.
  const foldPrice = (date: string, price: number) => {
    if (!Number.isFinite(price) || price <= 0) return;
    const existing = byDate.get(date);
    if (existing) {
      byDate.set(date, {
        high: Math.max(existing.high, price),
        low: Math.min(existing.low, price),
      });
    } else {
      byDate.set(date, { high: price, low: price });
    }
  };
  foldPrice(startDate, entryPrice);
  foldPrice(endDate, exitPrice);

  // Data quality gate: need >= 5 data points AND >= 25% coverage of holding period
  const holdingDays = Math.max(
    1,
    (new Date(endDate).getTime() - new Date(startDate).getTime()) /
      (24 * 3600 * 1000)
  );
  const minDataPoints = 5;
  const minCoverage = 0.25;
  const approxTradingDays = holdingDays * (5 / 7);

  if (
    byDate.size < minDataPoints ||
    byDate.size / approxTradingDays < minCoverage
  ) {
    return null;
  }

  let periodHigh = -Infinity;
  let periodHighDate = "";
  let periodLow = Infinity;
  let periodLowDate = "";

  for (const [date, hl] of byDate) {
    if (hl.high > periodHigh) {
      periodHigh = hl.high;
      periodHighDate = date;
    }
    if (hl.low < periodLow) {
      periodLow = hl.low;
      periodLowDate = date;
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

function getBenchmarkReturn(
  db: Database.Database,
  startDate: string,
  endDate: string
): number | null {
  // Try benchmark_prices first
  const benchStart = db
    .prepare(
      `SELECT date, close_price FROM benchmark_prices
       WHERE symbol = 'SPY' AND date >= ?
       ORDER BY date ASC LIMIT 1`
    )
    .get(startDate) as { date: string; close_price: number } | undefined;

  const benchEnd = db
    .prepare(
      `SELECT date, close_price FROM benchmark_prices
       WHERE symbol = 'SPY' AND date <= ?
       ORDER BY date DESC LIMIT 1`
    )
    .get(endDate) as { date: string; close_price: number } | undefined;

  if (benchStart && benchEnd) {
    // Quality gate: same-date match means only 1 data point — unreliable
    if (benchStart.date === benchEnd.date) return null;
    return (benchEnd.close_price - benchStart.close_price) / benchStart.close_price;
  }

  // Fallback: SPY in ohlcv_bars (if tracked as a security)
  const spySecurity = db
    .prepare(`SELECT id FROM securities WHERE UPPER(symbol) = 'SPY' LIMIT 1`)
    .get() as { id: number } | undefined;

  if (spySecurity) {
    const ohlcvStart = db
      .prepare(
        `SELECT bar_date, close FROM ohlcv_bars
         WHERE security_id = ? AND bar_date >= ? AND bar_size = '1 day'
         ORDER BY bar_date ASC LIMIT 1`
      )
      .get(spySecurity.id, startDate) as
      | { bar_date: string; close: number }
      | undefined;

    const ohlcvEnd = db
      .prepare(
        `SELECT bar_date, close FROM ohlcv_bars
         WHERE security_id = ? AND bar_date <= ? AND bar_size = '1 day'
         ORDER BY bar_date DESC LIMIT 1`
      )
      .get(spySecurity.id, endDate) as
      | { bar_date: string; close: number }
      | undefined;

    if (ohlcvStart && ohlcvEnd) {
      if (ohlcvStart.bar_date === ohlcvEnd.bar_date) return null;
      return (ohlcvEnd.close - ohlcvStart.close) / ohlcvStart.close;
    }
  }

  // Fallback: SPY in prices table
  if (spySecurity) {
    const priceStart = db
      .prepare(
        `SELECT date, close_price FROM prices
         WHERE security_id = ? AND date >= ?
         ORDER BY date ASC LIMIT 1`
      )
      .get(spySecurity.id, startDate) as
      | { date: string; close_price: number }
      | undefined;

    const priceEnd = db
      .prepare(
        `SELECT date, close_price FROM prices
         WHERE security_id = ? AND date <= ?
         ORDER BY date DESC LIMIT 1`
      )
      .get(spySecurity.id, endDate) as
      | { date: string; close_price: number }
      | undefined;

    if (priceStart && priceEnd) {
      if (priceStart.date === priceEnd.date) return null;
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

  // Fallback: monthly snapshots (covers historical trades before daily valuations exist)
  const snapshot = db
    .prepare(
      `SELECT total_value FROM monthly_snapshots
       WHERE account_id = ? AND month_end_date <= ?
       ORDER BY month_end_date DESC LIMIT 1`
    )
    .get(accountId, entryDate) as { total_value: number } | undefined;

  if (snapshot && snapshot.total_value > 0) {
    return positionCost / snapshot.total_value;
  }

  return null;
}

function getRemainingPosition(
  db: Database.Database,
  securityId: number,
  accountId: number,
  soldQuantity: number
): RemainingPositionContext | null {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(quantity_remaining), 0) as remaining
       FROM tax_lots
       WHERE security_id = ? AND account_id = ? AND quantity_remaining > 0`
    )
    .get(securityId, accountId) as { remaining: number } | undefined;

  if (!row) return null;

  const remaining = row.remaining;
  const originalPosition = remaining + soldQuantity;

  return {
    remainingShares: remaining,
    soldShares: soldQuantity,
    retainedPct:
      originalPosition > 0 ? remaining / originalPosition : 0,
    isTrim: remaining > 0,
  };
}

function getConcurrentActivity(
  db: Database.Database,
  accountId: number,
  saleDate: string,
  windowDays: number = 7
): ConcurrentActivity | null {
  const buys = db
    .prepare(
      `SELECT s.symbol, t.quantity, ABS(t.amount) as total_cost, t.trade_date
       FROM transactions t
       JOIN securities s ON t.security_id = s.id
       WHERE t.account_id = ?
         AND t.type IN ('BUY', 'BUY_TO_OPEN')
         AND t.trade_date >= date(?, '-' || ? || ' days')
         AND t.trade_date <= date(?, '+' || ? || ' days')
       ORDER BY t.trade_date`
    )
    .all(accountId, saleDate, windowDays, saleDate, windowDays) as Array<{
    symbol: string;
    quantity: number;
    total_cost: number;
    trade_date: string;
  }>;

  if (buys.length === 0) return null;

  return {
    buys: buys.map((b) => ({
      symbol: b.symbol,
      quantity: b.quantity,
      totalCost: b.total_cost,
      date: b.trade_date,
    })),
    totalBuyAmount: buys.reduce((sum, b) => sum + b.total_cost, 0),
  };
}

function formatQty(qty: number): string {
  return qty >= 1 ? String(Math.round(qty)) : qty.toPrecision(3);
}

export type {
  TradeMarketContext,
  StockPriceContext,
  RemainingPositionContext,
  ConcurrentActivity,
};
