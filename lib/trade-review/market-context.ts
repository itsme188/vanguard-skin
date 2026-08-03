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
  optionOrigin: OptionOriginEvent[] | null;
}

/**
 * Option-exercise / assignment / expiration events on the trade's underlying
 * within a window around the trade. Surfaces option-driven share movement
 * that would otherwise be invisible to the AI (which only sees stock buys
 * and stock sells in the trade table).
 *
 * Example: user buys 5 long calls 3/30, calls expire ITM 4/10 → 500 shares
 * assigned at strike → user sells those shares 4/13. The trade table shows
 * "BUY 500 RSP @$190 on 4/10, SELL 400 RSP @$196 on 4/13" with no hint
 * that the buy was forced by the option exercise.
 */
interface OptionOriginEvent {
  eventType: "EXERCISED" | "ASSIGNED" | "EXPIRED";
  eventDate: string;
  optionType: "CALL" | "PUT";
  contracts: number;
  strikePrice: number;
  expirationDate: string;
  // Premium paid/received when the option was opened (per contract, not per share)
  openPremiumPerContract: number | null;
  openDate: string | null;
  openType: string | null; // BUY_TO_OPEN | SELL_TO_OPEN
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
    // GroupedTrade prices are USD-converted; the bar series (ohlcv_bars/prices)
    // is native-currency, so un-convert before folding entry/exit into the
    // period range (ratios inside are scale-invariant — native throughout).
    stockContext: getStockPriceContext(
      db,
      trade.securityId,
      trade.earliestEntryDate,
      trade.exitDate,
      trade.avgEntryPrice / (trade.usdPerUnit || 1),
      trade.exitPrice / (trade.usdPerUnit || 1)
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
    optionOrigin: getOptionOriginEvents(
      db,
      accountId,
      trade.symbol,
      trade.earliestEntryDate,
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

    if (ctx.optionOrigin && ctx.optionOrigin.length > 0) {
      // Surface option-driven share movement so the AI doesn't narrate the
      // trade as a plain stock buy/sell when shares actually came from an
      // exercise or were called away via assignment.
      lines.push(`- ⚠️ OPTION-DRIVEN ACTIVITY on ${ctx.symbol}:`);
      for (const ev of ctx.optionOrigin) {
        const sharesPerContract = 100; // standard equity option
        const sharesAffected = ev.contracts * sharesPerContract;
        const isLong = ev.eventType === "EXERCISED";
        const directionWord =
          ev.eventType === "EXERCISED"
            ? ev.optionType === "CALL"
              ? `EXERCISED long calls → bought ${sharesAffected} shares at $${ev.strikePrice.toFixed(2)} strike`
              : `EXERCISED long puts → sold ${sharesAffected} shares at $${ev.strikePrice.toFixed(2)} strike`
            : ev.eventType === "ASSIGNED"
              ? ev.optionType === "CALL"
                ? `ASSIGNED on short calls → ${sharesAffected} shares called away at $${ev.strikePrice.toFixed(2)} strike`
                : `ASSIGNED on short puts → bought ${sharesAffected} shares at $${ev.strikePrice.toFixed(2)} strike (forced)`
              : `EXPIRED ${isLong ? "long" : "short"} ${ev.optionType.toLowerCase()} options worthless (no share movement)`;
        const premiumStr =
          ev.openPremiumPerContract != null && ev.openDate
            ? ` (originally opened ${ev.openDate} via ${ev.openType}, premium $${ev.openPremiumPerContract.toFixed(2)}/contract = $${(ev.openPremiumPerContract * ev.contracts * sharesPerContract).toLocaleString("en-US", { maximumFractionDigits: 0 })} total)`
            : "";
        lines.push(
          `  • ${ev.eventDate}: ${ev.contracts} contract(s) of ${ev.optionType} $${ev.strikePrice.toFixed(2)} (exp ${ev.expirationDate}) — ${directionWord}${premiumStr}`
        );
      }
      lines.push(
        `  ⇒ When narrating this trade, frame it as the option-driven sequence (option opened → exercise/assignment → share movement), NOT as an isolated stock buy/sell. The user's mental model is the option play; FIFO tax-lot accounting may match shares against earlier same-symbol lots, but the economic substance is the option flow.`
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

/**
 * Find option-exercise / assignment / expiration events on a stock's
 * underlying within a window around a given grouped trade. Lets the
 * trade-review prompt surface option-driven share movement that would
 * otherwise be invisible in the stock-only trade table.
 *
 * Window: 30 days before earliest entry → 7 days after exit. Wider than
 * strictly needed because LEAP options can sit open for months — a long
 * call expiring ITM with shares assigned weeks before the user-visible
 * "trade" still informs the trade's narrative.
 */
function getOptionOriginEvents(
  db: Database.Database,
  accountId: number,
  underlyingSymbol: string,
  earliestEntryDate: string,
  exitDate: string
): OptionOriginEvent[] | null {
  const rows = db
    .prepare(
      `SELECT
         t.trade_date AS event_date,
         UPPER(t.type) AS event_type,
         ABS(t.quantity) AS contracts,
         UPPER(s.option_type) AS option_type,
         s.strike_price,
         s.expiration_date,
         t.security_id AS option_security_id
       FROM transactions t
       JOIN securities s ON s.id = t.security_id
       WHERE t.account_id = ?
         AND s.underlying_symbol = ?
         AND LOWER(t.type) IN ('exercised', 'assigned', 'expired')
         AND LOWER(s.security_type) = 'option'
         AND s.option_type IS NOT NULL
         AND s.strike_price IS NOT NULL
         AND s.expiration_date IS NOT NULL
         AND t.trade_date >= date(?, '-30 days')
         AND t.trade_date <= date(?, '+7 days')
       ORDER BY t.trade_date`
    )
    .all(accountId, underlyingSymbol, earliestEntryDate, exitDate) as Array<{
    event_date: string;
    event_type: "EXERCISED" | "ASSIGNED" | "EXPIRED";
    contracts: number;
    option_type: "CALL" | "PUT";
    strike_price: number;
    expiration_date: string;
    option_security_id: number;
  }>;

  if (rows.length === 0) return null;

  // For each event, find the original BUY_TO_OPEN / SELL_TO_OPEN to surface
  // the premium paid/received and the open date. This lets the AI narrate
  // the full option play (e.g. "user paid $1,755 for 5 long calls, exercised
  // ITM 11 days later, sold the 500 assigned shares at +$3,000 net of premium").
  const openStmt = db.prepare(
    `SELECT trade_date, UPPER(type) AS open_type, price_per_share
     FROM transactions
     WHERE account_id = ?
       AND security_id = ?
       AND LOWER(type) IN ('buy_to_open', 'sell_to_open')
     ORDER BY trade_date ASC
     LIMIT 1`
  );

  return rows.map((r) => {
    const opener = openStmt.get(accountId, r.option_security_id) as
      | { trade_date: string; open_type: string; price_per_share: number | null }
      | undefined;
    return {
      eventType: r.event_type,
      eventDate: r.event_date,
      optionType: r.option_type,
      contracts: r.contracts,
      strikePrice: r.strike_price,
      expirationDate: r.expiration_date,
      openPremiumPerContract:
        opener?.price_per_share != null ? opener.price_per_share : null,
      openDate: opener?.trade_date ?? null,
      openType: opener?.open_type ?? null,
    };
  });
}

export type {
  TradeMarketContext,
  StockPriceContext,
  RemainingPositionContext,
  ConcurrentActivity,
  OptionOriginEvent,
};
