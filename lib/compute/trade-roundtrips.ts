import type Database from "better-sqlite3";

/**
 * A round-trip trade: one buy→sell cycle extracted from tax_lot_sales.
 * Multiple tax_lot_sales rows from the same SELL transaction (partial lot fills)
 * are kept separate here for accurate per-lot tracking, but grouped in the prompt.
 */
export interface RoundTrip {
  accountId: number;
  securityId: number;
  symbol: string;
  securityName: string | null;
  entryDate: string;
  entryPrice: number;
  entryQuantity: number;
  entryCost: number;
  exitDate: string;
  exitPrice: number;
  exitQuantity: number;
  exitProceeds: number;
  holdingDays: number;
  realizedPnl: number;
  returnPct: number;
  saleTransactionId: number;
}

export interface RoundTripSummary {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalRealizedPnl: number;
  avgHoldingDays: number;
  bestTradePnl: number;
  bestTradeSymbol: string;
  worstTradePnl: number;
  worstTradeSymbol: string;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
}

export interface ReviewPeriod {
  periodStart: string;
  periodEnd: string;
  tradeCount: number;
}

/**
 * Extract round-trip trades from tax_lot_sales for a given account and date range.
 * Each row is one FIFO-matched lot→sale pair.
 */
export function getRoundTrips(
  db: Database.Database,
  accountId: number,
  periodStart: string,
  periodEnd: string
): RoundTrip[] {
  const rows = db
    .prepare(
      `SELECT
        tl.account_id,
        tl.security_id,
        s.symbol,
        s.name AS security_name,
        tl.acquisition_date AS entry_date,
        tl.acquisition_price AS entry_price,
        tls.quantity_sold AS entry_quantity,
        tls.cost_basis_allocated AS entry_cost,
        tls.sale_date AS exit_date,
        tls.sale_price AS exit_price,
        tls.quantity_sold AS exit_quantity,
        tls.proceeds AS exit_proceeds,
        tls.holding_period_days AS holding_days,
        tls.realized_gain_loss AS realized_pnl,
        tls.sale_transaction_id
      FROM tax_lot_sales tls
      JOIN tax_lots tl ON tl.id = tls.tax_lot_id
      JOIN securities s ON s.id = tl.security_id
      WHERE tl.account_id = ?
        AND tls.sale_date >= ?
        AND tls.sale_date <= ?
      ORDER BY tls.sale_date, s.symbol`
    )
    .all(accountId, periodStart, periodEnd) as Array<{
    account_id: number;
    security_id: number;
    symbol: string;
    security_name: string | null;
    entry_date: string;
    entry_price: number;
    entry_quantity: number;
    entry_cost: number;
    exit_date: string;
    exit_price: number;
    exit_quantity: number;
    exit_proceeds: number;
    holding_days: number;
    realized_pnl: number;
    sale_transaction_id: number;
  }>;

  return rows.map((r) => ({
    accountId: r.account_id,
    securityId: r.security_id,
    symbol: r.symbol,
    securityName: r.security_name,
    entryDate: r.entry_date,
    entryPrice: r.entry_price,
    entryQuantity: r.entry_quantity,
    entryCost: r.entry_cost,
    exitDate: r.exit_date,
    exitPrice: r.exit_price,
    exitQuantity: r.exit_quantity,
    exitProceeds: r.exit_proceeds,
    holdingDays: r.holding_days,
    realizedPnl: r.realized_pnl,
    returnPct: r.entry_cost !== 0 ? (r.realized_pnl / r.entry_cost) * 100 : 0,
    saleTransactionId: r.sale_transaction_id,
  }));
}

/**
 * Compute summary metrics from an array of round-trips.
 * Pure function — no DB access.
 */
export function computeRoundTripSummary(
  roundTrips: RoundTrip[]
): RoundTripSummary {
  if (roundTrips.length === 0) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalRealizedPnl: 0,
      avgHoldingDays: 0,
      bestTradePnl: 0,
      bestTradeSymbol: "",
      worstTradePnl: 0,
      worstTradeSymbol: "",
      avgWin: 0,
      avgLoss: 0,
      profitFactor: 0,
    };
  }

  const winners = roundTrips.filter((rt) => rt.realizedPnl > 0);
  const losers = roundTrips.filter((rt) => rt.realizedPnl < 0);

  const totalPnl = roundTrips.reduce((sum, rt) => sum + rt.realizedPnl, 0);
  const totalHoldingDays = roundTrips.reduce(
    (sum, rt) => sum + rt.holdingDays,
    0
  );

  const grossWins = winners.reduce((sum, rt) => sum + rt.realizedPnl, 0);
  const grossLosses = Math.abs(
    losers.reduce((sum, rt) => sum + rt.realizedPnl, 0)
  );

  const best = roundTrips.reduce((max, rt) =>
    rt.realizedPnl > max.realizedPnl ? rt : max
  );
  const worst = roundTrips.reduce((min, rt) =>
    rt.realizedPnl < min.realizedPnl ? rt : min
  );

  return {
    totalTrades: roundTrips.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    winRate: roundTrips.length > 0 ? winners.length / roundTrips.length : 0,
    totalRealizedPnl: totalPnl,
    avgHoldingDays:
      roundTrips.length > 0 ? totalHoldingDays / roundTrips.length : 0,
    bestTradePnl: best.realizedPnl,
    bestTradeSymbol: best.symbol,
    worstTradePnl: worst.realizedPnl,
    worstTradeSymbol: worst.symbol,
    avgWin: winners.length > 0 ? grossWins / winners.length : 0,
    avgLoss: losers.length > 0 ? -(grossLosses / losers.length) : 0,
    profitFactor:
      grossLosses > 0 ? Math.min(grossWins / grossLosses, 99.9) : 99.9,
  };
}

/**
 * Find months that have closed trades but no existing trade review.
 * Used by the import hook to prompt the user to generate reviews.
 */
export function detectNewTradeReviewPeriods(
  db: Database.Database
): ReviewPeriod[] {
  const rows = db
    .prepare(
      `SELECT
        strftime('%Y-%m-01', tls.sale_date) AS period_start,
        date(strftime('%Y-%m-01', tls.sale_date), '+1 month', '-1 day') AS period_end,
        COUNT(*) AS trade_count
      FROM tax_lot_sales tls
      JOIN tax_lots tl ON tl.id = tls.tax_lot_id
      WHERE NOT EXISTS (
        SELECT 1 FROM trade_reviews tr
        WHERE tr.account_id = tl.account_id
          AND tr.period_start = strftime('%Y-%m-01', tls.sale_date)
      )
      GROUP BY period_start
      ORDER BY period_start DESC`
    )
    .all() as Array<{
    period_start: string;
    period_end: string;
    trade_count: number;
  }>;

  return rows.map((r) => ({
    periodStart: r.period_start,
    periodEnd: r.period_end,
    tradeCount: r.trade_count,
  }));
}

/**
 * Get all months that have closed trades for a given account,
 * whether or not they have an existing review.
 */
export function getAvailableReviewPeriods(
  db: Database.Database,
  accountId: number
): ReviewPeriod[] {
  const rows = db
    .prepare(
      `SELECT
        strftime('%Y-%m-01', tls.sale_date) AS period_start,
        date(strftime('%Y-%m-01', tls.sale_date), '+1 month', '-1 day') AS period_end,
        COUNT(*) AS trade_count
      FROM tax_lot_sales tls
      JOIN tax_lots tl ON tl.id = tls.tax_lot_id
      WHERE tl.account_id = ?
      GROUP BY period_start
      ORDER BY period_start DESC`
    )
    .all(accountId) as Array<{
    period_start: string;
    period_end: string;
    trade_count: number;
  }>;

  return rows.map((r) => ({
    periodStart: r.period_start,
    periodEnd: r.period_end,
    tradeCount: r.trade_count,
  }));
}
