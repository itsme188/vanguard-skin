import type Database from "better-sqlite3";
import type { GroupedTrade } from "@/lib/compute/trade-roundtrips";
import { PRICED_BAR_SQL } from "@/lib/queries/ohlcv";
import { readIbkrTradeDirection } from "@/lib/import/ibkr-trade-direction";
import { IMPORT_SPLIT_ACTION_TYPES_SQL } from "@/lib/compute/synthetic-close-guards";

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
  /**
   * Premium paid/received per CONTRACT when the option was opened: the
   * opening fill's per-share price times the contract multiplier. (Before
   * 2026-11-15 this held the per-share price under the per-contract name.)
   */
  openPremiumPerContract: number | null;
  openDate: string | null;
  openType: string | null; // BUY_TO_OPEN | SELL_TO_OPEN
  /** Opening fill's premium per share (the stored `price_per_share`). */
  openPremiumPerShare?: number | null;
  /** Shares per contract: the stored `COALESCE(multiplier, 1)`. */
  multiplier?: number;
  /**
   * Which side the position was on. EXERCISED is always long and ASSIGNED
   * always short; an EXPIRED event reads it from the lot the expiry closed
   * (`tax_lots.is_short`), then from the opening fill's type. null = unknown.
   */
  isShort?: boolean | null;
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
      trade.totalQuantity,
      {
        exitDate: trade.exitDate,
        saleTransactionId: trade.saleTransactionId,
        isShort: Boolean(trade.isShort),
      }
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
 * How many cached daily price points exist for a security in a window —
 * `prices` rows plus daily `ohlcv_bars` rows. The trade-review backfill
 * (`lib/trade-review/generate.ts::backfillPriceData`) compares this against
 * its minimum to decide whether to ask TWS for history.
 *
 * Bars are counted through `PRICED_BAR_SQL` so this agrees with the reader
 * it gates: `getStockPriceContext` above drops a legacy zero bar, so counting
 * one here as coverage would skip the TWS fetch and then fail that reader's
 * own quality gate on the very rows that were counted. A zero bar is not a
 * data point.
 *
 * Deliberately a plain row count (`UNION ALL`): a date present in both
 * tables counts twice, as it always has. That is the pre-existing gate
 * shape, kept unchanged.
 */
export function countCachedPricePoints(
  db: Database.Database,
  securityId: number,
  startDate: string,
  endDate: string
): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM (
         SELECT date as d FROM prices WHERE security_id = ? AND date >= ? AND date <= ?
         UNION ALL
         SELECT bar_date as d FROM ohlcv_bars
           WHERE security_id = ? AND bar_date >= ? AND bar_date <= ? AND bar_size = '1 day'
             AND ${PRICED_BAR_SQL}
       )`
    )
    .get(securityId, startDate, endDate, securityId, startDate, endDate) as {
    cnt: number;
  };
  return row.cnt;
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
      // Only the largest buys are listed (the same ±7-day list repeats for
      // every sale in a busy week and once made up most of the prompt); the
      // rest fold into one "+N more" entry with their exact sum, and the
      // total below always covers every buy.
      const ranked = ca.buys
        .map((b, idx) => ({ b, idx }))
        .sort((x, y) => y.b.totalCost - x.b.totalCost || x.idx - y.idx);
      const shown = ranked
        .slice(0, CONCURRENT_BUYS_LISTED)
        .sort((x, y) => x.idx - y.idx)
        .map(({ b }) => b);
      const hidden = ranked.slice(CONCURRENT_BUYS_LISTED).map(({ b }) => b);
      const entries = shown.map(
        (b) =>
          `${formatQty(b.quantity)} ${b.symbol} ($${formatWholeDollars(b.totalCost)}) on ${b.date}`
      );
      if (hidden.length > 0) {
        const hiddenTotal = hidden.reduce((sum, b) => sum + b.totalCost, 0);
        entries.push(`+${hidden.length} more ($${formatWholeDollars(hiddenTotal)})`);
      }
      const buyList = entries.join(", ");
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
        // The stored contract multiplier (COALESCE(multiplier, 1) in the
        // reader), never an assumed 100.
        const sharesPerContract = ev.multiplier ?? 100;
        const sharesAffected = ev.contracts * sharesPerContract;
        const optionWord = ev.optionType.toLowerCase();
        const expiredWords =
          ev.isShort === true
            ? `EXPIRED short ${optionWord} options worthless — premium received was kept (no share movement)`
            : ev.isShort === false
              ? `EXPIRED long ${optionWord} options worthless — premium paid was lost (no share movement)`
              : `EXPIRED ${optionWord} options worthless (side unknown; no share movement)`;
        const directionWord =
          ev.eventType === "EXERCISED"
            ? ev.optionType === "CALL"
              ? `EXERCISED long calls → bought ${sharesAffected} shares at $${ev.strikePrice.toFixed(2)} strike`
              : `EXERCISED long puts → sold ${sharesAffected} shares at $${ev.strikePrice.toFixed(2)} strike`
            : ev.eventType === "ASSIGNED"
              ? ev.optionType === "CALL"
                ? `ASSIGNED on short calls → ${sharesAffected} shares called away at $${ev.strikePrice.toFixed(2)} strike`
                : `ASSIGNED on short puts → bought ${sharesAffected} shares at $${ev.strikePrice.toFixed(2)} strike (forced)`
              : expiredWords;
        const perShare =
          ev.openPremiumPerShare !== undefined
            ? ev.openPremiumPerShare
            : ev.openPremiumPerContract != null
              ? ev.openPremiumPerContract / sharesPerContract
              : null;
        const premiumStr =
          perShare != null && ev.openDate
            ? ` (originally opened ${ev.openDate} via ${ev.openType}, premium $${perShare.toFixed(2)}/share ($${formatWholeDollars(perShare * sharesPerContract)}/contract) = $${formatWholeDollars(perShare * ev.contracts * sharesPerContract)} total)`
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

  // PRICED_BAR_SQL (2026-09-11, PR #72 review): a legacy zero-priced bar
  // (real open/high, low = 0 AND close = 0 — see the constant's doc) would
  // set this date's low to 0 and make `periodLow` 0 for the whole window,
  // which then goes into the AI's prompt as a real market low and gets
  // narrated as a crash the security never had. A corrupt bar is dropped
  // here rather than clamped, so the `prices` fill-in below covers that
  // date from the other pipeline when it can — the same "prefer whichever
  // table actually covers the date" logic, applied to a bar that carries no
  // usable price.
  const ohlcv = db
    .prepare(
      `SELECT bar_date, high, low
       FROM ohlcv_bars
       WHERE security_id = ? AND bar_date >= ? AND bar_date <= ? AND bar_size = '1 day'
         AND ${PRICED_BAR_SQL}
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

  // Fallback: SPY in ohlcv_bars (if tracked as a security).
  //
  // PRICED_BAR_SQL on BOTH endpoint reads (2026-10-05): this picks the first
  // and last bar of the window and divides one close by the other, so a
  // legacy zero bar landing on either endpoint was read as the benchmark's
  // real close — a zero start divides by zero, a zero end reports a -100%
  // period for the index. A dropped bar is simply absent: the endpoint moves
  // to the nearest priced bar inside the window, exactly as it would if the
  // row had never been stored. That is the same thing this function already
  // does for a weekend or holiday (`>= startDate` / `<= endDate`), and it is
  // honest here because the result is a PERIOD return between two real
  // closes, not a one-day change that depends on calendar adjacency. If only
  // one priced date is left, the single-point gate below still returns null.
  const spySecurity = db
    .prepare(`SELECT id FROM securities WHERE UPPER(symbol) = 'SPY' LIMIT 1`)
    .get() as { id: number } | undefined;

  if (spySecurity) {
    const ohlcvStart = db
      .prepare(
        `SELECT bar_date, close FROM ohlcv_bars
         WHERE security_id = ? AND bar_date >= ? AND bar_size = '1 day'
           AND ${PRICED_BAR_SQL}
         ORDER BY bar_date ASC LIMIT 1`
      )
      .get(spySecurity.id, startDate) as
      | { bar_date: string; close: number }
      | undefined;

    const ohlcvEnd = db
      .prepare(
        `SELECT bar_date, close FROM ohlcv_bars
         WHERE security_id = ? AND bar_date <= ? AND bar_size = '1 day'
           AND ${PRICED_BAR_SQL}
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

/**
 * The position left in this account, on this side (long or short), JUST AFTER
 * this sale, in the share basis of the sale itself.
 *
 * Today's open lots are not that figure: shares bought again after the sale
 * would read as "retained", and every trim of one position would be measured
 * against the same count. So the remainder is rebuilt backwards from the
 * engine's own records, per lot of the same side acquired on or before the
 * sale date:
 *
 *   remaining after this sale = the lot's quantity_remaining today
 *                             + every later disposition of that lot
 *                               (tax_lot_sales after this sale, and
 *                               lot-assigned gifts after it)
 *
 * "Later" follows the engine's replay order: a later date, or the same date
 * with a higher sale transaction id (the engine replays same-day sells by
 * id, and a same-day gift after every sell), so three trims on one day see
 * shrinking remainders.
 *
 * Split basis: the engine's split replay multiplies an OPEN lot's quantities
 * by the ratio and leaves already-booked sales as booked, and a sale dated on
 * a split's effective date is replayed before the split (end-of-day rule).
 * So each quantity is brought back to the sale's own basis by dividing out
 * the import-split ratios effective on or after the sale date and before the
 * date that quantity was booked (for today's quantity_remaining: every later
 * split, which all applied because the lot was still open). `soldShares` is
 * this sale's own `quantity_sold`, already in that basis.
 */
function getRemainingPosition(
  db: Database.Database,
  securityId: number,
  accountId: number,
  soldQuantity: number,
  asOf?: { exitDate: string; saleTransactionId: number; isShort: boolean }
): RemainingPositionContext | null {
  if (!asOf) {
    // No sale identity known: today's open lots (the pre-2026-11-15 reading).
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(quantity_remaining), 0) as remaining
         FROM tax_lots
         WHERE security_id = ? AND account_id = ? AND quantity_remaining > 0`
      )
      .get(securityId, accountId) as { remaining: number } | undefined;
    if (!row) return null;
    return buildRemaining(row.remaining, soldQuantity);
  }

  const { exitDate, saleTransactionId, isShort } = asOf;
  const splits = db
    .prepare(
      `SELECT effective_date,
              CAST(ratio_numerator AS REAL) / ratio_denominator AS ratio
       FROM corporate_actions
       WHERE source = 'import'
         AND security_id = ?
         AND UPPER(action_type) IN (${IMPORT_SPLIT_ACTION_TYPES_SQL})
         AND effective_date >= ?
         AND ratio_numerator > 0 AND ratio_denominator > 0`
    )
    .all(securityId, exitDate) as Array<{ effective_date: string; ratio: number }>;
  // Product of the split ratios replayed after this sale and before a
  // quantity booked on `bookedOn` (a split on that same date replays after
  // it); null = today, every later split.
  const splitFactor = (bookedOn: string | null): number =>
    splits.reduce(
      (f, sp) => (bookedOn === null || sp.effective_date < bookedOn ? f * sp.ratio : f),
      1
    );
  const todayFactor = splitFactor(null);

  const lots = db
    .prepare(
      `SELECT id, quantity_remaining, acquisition_transaction_id
       FROM tax_lots
       WHERE account_id = ? AND security_id = ? AND is_short = ?
         AND acquisition_date <= ?`
    )
    .all(accountId, securityId, isShort ? 1 : 0, exitDate) as Array<{
    id: number;
    quantity_remaining: number;
    acquisition_transaction_id: number | null;
  }>;
  if (lots.length === 0) return buildRemaining(0, soldQuantity);

  const laterSales = db.prepare(
    `SELECT sale_date, quantity_sold FROM tax_lot_sales
     WHERE tax_lot_id = ?
       AND (sale_date > ? OR (sale_date = ? AND sale_transaction_id > ?))`
  );
  // Lot-assigned gifts consume lots outside tax_lot_sales (the engine's
  // donation replay, keyed by the lot's acquisition transaction); one dated
  // on or after the sale date was replayed after it.
  const laterGifts = db.prepare(
    `SELECT t.trade_date AS gift_date, ol.quantity AS quantity
     FROM donation_leg_links dl
     JOIN transactions t ON t.id = dl.transaction_id
     JOIN donation_lots ol ON ol.donation_id = dl.donation_id
     JOIN donations d ON d.id = dl.donation_id
     WHERE dl.role = 'out' AND d.reversed_date IS NULL
       AND t.account_id = ? AND t.security_id = ?
       AND ol.acquisition_transaction_id = ?
       AND t.trade_date >= ?`
  );

  let remaining = 0;
  for (const lot of lots) {
    let q = lot.quantity_remaining / todayFactor;
    const sales = laterSales.all(lot.id, exitDate, exitDate, saleTransactionId) as Array<{
      sale_date: string;
      quantity_sold: number;
    }>;
    for (const s of sales) q += s.quantity_sold / splitFactor(s.sale_date);
    if (lot.acquisition_transaction_id != null) {
      const gifts = laterGifts.all(
        accountId,
        securityId,
        lot.acquisition_transaction_id,
        exitDate
      ) as Array<{ gift_date: string; quantity: number }>;
      for (const g of gifts) q += g.quantity / splitFactor(g.gift_date);
    }
    remaining += q;
  }
  return buildRemaining(remaining, soldQuantity);
}

/** Below this, a remainder is float residue from split ratios, not shares. */
const REMAINING_EPSILON = 1e-6;

function buildRemaining(remainingRaw: number, soldQuantity: number): RemainingPositionContext {
  const remaining = remainingRaw > REMAINING_EPSILON ? remainingRaw : 0;
  const originalPosition = remaining + soldQuantity;
  return {
    remainingShares: remaining,
    soldShares: soldQuantity,
    retainedPct: originalPosition > 0 ? remaining / originalPosition : 0,
    isTrim: remaining > 0,
  };
}

function getConcurrentActivity(
  db: Database.Database,
  accountId: number,
  saleDate: string,
  windowDays: number = 7
): ConcurrentActivity | null {
  const rows = db
    .prepare(
      `SELECT s.symbol, t.quantity, ABS(t.amount) as total_cost, t.trade_date, t.notes
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
    notes: string | null;
  }>;
  // A buy the broker marks as closing only (a short cover, an option bought
  // to close) puts no new capital to work, so it is not "deployed". A mixed
  // open-and-close fill stays (its open part is new capital and the amount
  // cannot be split); a row with no broker evidence stays, as before.
  const buys = rows.filter((b) => {
    const direction = readIbkrTradeDirection(b.notes);
    return !(direction && direction.close && !direction.open);
  });

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

/** How many concurrent buys the prompt lists by name for each trade. */
const CONCURRENT_BUYS_LISTED = 10;

function formatWholeDollars(value: number): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
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
         COALESCE(s.multiplier, 1) AS multiplier,
         t.id AS event_transaction_id,
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
    multiplier: number;
    event_transaction_id: number;
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

  // An expired position's side is the side of the lot the expiry closed
  // (the engine books EXPIRED against an open lot of either side).
  const closedLotSideStmt = db.prepare(
    `SELECT MAX(tl.is_short) AS max_short, MIN(tl.is_short) AS min_short
     FROM tax_lot_sales x
     JOIN tax_lots tl ON tl.id = x.tax_lot_id
     WHERE x.sale_transaction_id = ?`
  );

  return rows.map((r) => {
    const opener = openStmt.get(accountId, r.option_security_id) as
      | { trade_date: string; open_type: string; price_per_share: number | null }
      | undefined;
    let isShort: boolean | null;
    if (r.event_type === "EXERCISED") isShort = false;
    else if (r.event_type === "ASSIGNED") isShort = true;
    else {
      const side = closedLotSideStmt.get(r.event_transaction_id) as
        | { max_short: number | null; min_short: number | null }
        | undefined;
      if (side && side.max_short != null && side.max_short === side.min_short) {
        isShort = side.max_short === 1;
      } else if (opener?.open_type === "SELL_TO_OPEN") isShort = true;
      else if (opener?.open_type === "BUY_TO_OPEN") isShort = false;
      else isShort = null;
    }
    const perShare = opener?.price_per_share != null ? opener.price_per_share : null;
    return {
      eventType: r.event_type,
      eventDate: r.event_date,
      optionType: r.option_type,
      contracts: r.contracts,
      strikePrice: r.strike_price,
      expirationDate: r.expiration_date,
      openPremiumPerContract: perShare != null ? perShare * r.multiplier : null,
      openDate: opener?.trade_date ?? null,
      openType: opener?.open_type ?? null,
      openPremiumPerShare: perShare,
      multiplier: r.multiplier,
      isShort,
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
