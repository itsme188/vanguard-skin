import type Database from "better-sqlite3";
import { getTaxConventionState } from "@/lib/compute/tax-convention";

/**
 * Whether the current tax-lot convention state is pending a recompute
 * (number-trust durable fixes, WS1 pending-state contract). Guarded against
 * minimal test DBs that never created a `settings` table — those don't model
 * this dimension, so they default to "not pending" rather than throwing.
 */
function isConventionPending(db: Database.Database): boolean {
  try {
    return !getTaxConventionState(db).recomputeCurrent;
  } catch {
    return false;
  }
}

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
  securityType?: string | null;
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
  sellTransactionQty: number | null; // actual quantity from the SELL transaction
  /**
   * USD per unit of the security's native currency (1 for USD securities or
   * when no broker-sourced fx_rates row exists — never fabricated). All dollar
   * fields above are already converted to USD; divide by this to recover the
   * native-currency figure (market context folds entry/exit into native bars).
   */
  usdPerUnit?: number;
  /**
   * True when the underlying tax-lot dollar convention is pending a
   * recompute (WS1 pending-state contract) — computed once per query via
   * `getTaxConventionState`, not per-row. Surfaces should show a small
   * caveat note rather than hide the numbers. Optional (like usdPerUnit)
   * so hand-built fixtures in tests/pure-function callers don't need to
   * supply it; defaults to false wherever it's read.
   */
  conventionPending?: boolean;
  /**
   * True when the sale transaction is the engine-owned synthetic
   * RECONCILE_CLOSE row (never real broker activity — see
   * lib/compute/tax-lots.ts). Realized P&L on this row is an estimate;
   * surfaces should label it (finding 1, number-trust durable fixes).
   * Optional like usdPerUnit/conventionPending — defaults to false wherever
   * hand-built fixtures don't supply it.
   */
  isSyntheticClose?: boolean;
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
  /** Total closed-trade count for the period (every distinct SELL transaction). */
  tradeCount: number;
  /**
   * Subset of `tradeCount` whose FIFO lot coverage is ≥`MIN_LOT_COVERAGE`
   * (the threshold `generateTradeReview` applies before the AI sees anything).
   * Trades below the threshold represent positions that span the import-history
   * boundary and have incomplete cost basis. When `reviewableCount < tradeCount`,
   * the dropdown should surface the gap so users know what to expect.
   */
  reviewableCount: number;
}

/**
 * A grouped trade: one sale transaction that may have consumed multiple FIFO lots.
 * This is the user-facing "trade" abstraction — what they think of as one decision.
 */
export interface GroupedTrade {
  saleTransactionId: number;
  securityId: number;
  symbol: string;
  securityName: string | null;
  lots: RoundTrip[];
  totalQuantity: number;
  sellTransactionQty: number | null; // actual quantity from the SELL transaction
  lotCoverage: number; // ratio of matched lots to actual sell qty (0-1)
  avgEntryPrice: number; // weighted by cost
  exitPrice: number;
  exitDate: string;
  earliestEntryDate: string;
  latestEntryDate: string;
  avgHoldingDays: number; // quantity-weighted average (negatives clamped to 0)
  maxHoldingDays: number;
  minHoldingDays: number;
  totalCost: number;
  totalProceeds: number;
  realizedPnl: number;
  returnPct: number;
  /** USD per native-currency unit (1 for USD names) — see RoundTrip.usdPerUnit */
  usdPerUnit: number;
  /** See RoundTrip.conventionPending — carried through from the group's lots. */
  conventionPending: boolean;
  /**
   * See RoundTrip.isSyntheticClose — carried through from the group's lots.
   * Every lot in a group shares one sale_transaction_id, so this is
   * consistent across the whole group (never a per-lot mix).
   */
  isSyntheticClose: boolean;
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
        s.security_type,
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
        tls.sale_transaction_id,
        ABS(sell_tx.quantity) AS sell_transaction_qty,
        COALESCE(fx.usd_per_unit, 1) AS usd_per_unit,
        (sell_tx.type = 'RECONCILE_CLOSE') AS is_synthetic_close
      FROM tax_lot_sales tls
      JOIN tax_lots tl ON tl.id = tls.tax_lot_id
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN transactions sell_tx ON sell_tx.id = tls.sale_transaction_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
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
    security_type: string | null;
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
    sell_transaction_qty: number | null;
    usd_per_unit: number;
    is_synthetic_close: number | null;
  }>;

  // tax_lot_sales dollar columns are stored in the security's NATIVE currency
  // (foreign-currency convention: conversion happens at read time only) —
  // convert here, before any cross-security aggregation sums mixed currencies.
  // conventionPending is computed once per call, not per row.
  const conventionPending = isConventionPending(db);
  return rows.map((r) => {
    const fx = r.usd_per_unit > 0 ? r.usd_per_unit : 1;
    return {
      accountId: r.account_id,
      securityId: r.security_id,
      symbol: r.symbol,
      securityName: r.security_name,
      securityType: r.security_type,
      entryDate: r.entry_date,
      entryPrice: r.entry_price * fx,
      entryQuantity: r.entry_quantity,
      entryCost: r.entry_cost * fx,
      exitDate: r.exit_date,
      exitPrice: r.exit_price * fx,
      exitQuantity: r.exit_quantity,
      exitProceeds: r.exit_proceeds * fx,
      holdingDays: r.holding_days,
      realizedPnl: r.realized_pnl * fx,
      returnPct: r.entry_cost !== 0 ? (r.realized_pnl / r.entry_cost) * 100 : 0,
      saleTransactionId: r.sale_transaction_id,
      sellTransactionQty: r.sell_transaction_qty,
      usdPerUnit: fx,
      conventionPending,
      isSyntheticClose: Boolean(r.is_synthetic_close),
    };
  });
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
      `WITH per_sale_coverage AS (
        SELECT
          tls.sale_transaction_id,
          tl.account_id,
          strftime('%Y-%m-01', tls.sale_date) AS period_start,
          SUM(tls.quantity_sold) AS matched_qty,
          MAX(ABS(t.quantity)) AS actual_qty
        FROM tax_lot_sales tls
        JOIN tax_lots tl ON tl.id = tls.tax_lot_id
        JOIN transactions t ON t.id = tls.sale_transaction_id
        WHERE NOT EXISTS (
          SELECT 1 FROM trade_reviews tr
          WHERE tr.account_id = tl.account_id
            AND tr.period_start = strftime('%Y-%m-01', tls.sale_date)
        )
        GROUP BY tls.sale_transaction_id, tl.account_id, period_start
      )
      SELECT
        period_start,
        date(period_start, '+1 month', '-1 day') AS period_end,
        COUNT(*) AS trade_count,
        SUM(
          CASE
            WHEN actual_qty IS NULL OR actual_qty = 0 THEN 1
            WHEN matched_qty * 1.0 / actual_qty >= ? THEN 1
            ELSE 0
          END
        ) AS reviewable_count
      FROM per_sale_coverage
      GROUP BY period_start
      ORDER BY period_start DESC`
    )
    .all(MIN_LOT_COVERAGE) as Array<{
    period_start: string;
    period_end: string;
    trade_count: number;
    reviewable_count: number;
  }>;

  return rows.map((r) => ({
    periodStart: r.period_start,
    periodEnd: r.period_end,
    tradeCount: r.trade_count,
    reviewableCount: r.reviewable_count,
  }));
}

/**
 * Get all months that have closed trades for a given account,
 * whether or not they have an existing review.
 *
 * Returns both `tradeCount` (raw count of distinct SELL transactions) and
 * `reviewableCount` (subset whose FIFO lot coverage is ≥`MIN_LOT_COVERAGE`).
 * Coverage is computed in SQL via a per-sale CTE that compares matched lot
 * quantity to the actual SELL transaction quantity — mirroring the runtime
 * filter `filterFullyCoveredTrades` applies before the AI sees a review.
 *
 * When `reviewableCount < tradeCount`, the dropdown should surface the gap
 * ("9 of 12 reviewable") so the user knows trades will be silently filtered
 * out at generation time (positions that span import-history boundaries).
 */
export function getAvailableReviewPeriods(
  db: Database.Database,
  accountId: number
): ReviewPeriod[] {
  const rows = db
    .prepare(
      `WITH per_sale_coverage AS (
        SELECT
          tls.sale_transaction_id,
          strftime('%Y-%m-01', tls.sale_date) AS period_start,
          SUM(tls.quantity_sold) AS matched_qty,
          MAX(ABS(t.quantity)) AS actual_qty
        FROM tax_lot_sales tls
        JOIN tax_lots tl ON tl.id = tls.tax_lot_id
        JOIN transactions t ON t.id = tls.sale_transaction_id
        WHERE tl.account_id = ?
        GROUP BY tls.sale_transaction_id, period_start
      )
      SELECT
        period_start,
        date(period_start, '+1 month', '-1 day') AS period_end,
        COUNT(*) AS trade_count,
        SUM(
          CASE
            WHEN actual_qty IS NULL OR actual_qty = 0 THEN 1
            WHEN matched_qty * 1.0 / actual_qty >= ? THEN 1
            ELSE 0
          END
        ) AS reviewable_count
      FROM per_sale_coverage
      GROUP BY period_start
      ORDER BY period_start DESC`
    )
    .all(accountId, MIN_LOT_COVERAGE) as Array<{
    period_start: string;
    period_end: string;
    trade_count: number;
    reviewable_count: number;
  }>;

  return rows.map((r) => ({
    periodStart: r.period_start,
    periodEnd: r.period_end,
    tradeCount: r.trade_count,
    reviewableCount: r.reviewable_count,
  }));
}

/**
 * Group round-trips by sale transaction into user-facing "trades."
 * Multiple FIFO lots from the same SELL become one grouped trade.
 * Pure function — no DB access.
 */
export function computeGroupedTrades(roundTrips: RoundTrip[]): GroupedTrade[] {
  const groups = new Map<number, RoundTrip[]>();

  for (const rt of roundTrips) {
    const group = groups.get(rt.saleTransactionId) || [];
    group.push(rt);
    groups.set(rt.saleTransactionId, group);
  }

  return Array.from(groups.entries()).map(([saleTransactionId, lots]) => {
    const totalQty = lots.reduce((s, rt) => s + rt.exitQuantity, 0);
    const totalCost = lots.reduce((s, rt) => s + rt.entryCost, 0);
    const totalProceeds = lots.reduce((s, rt) => s + rt.exitProceeds, 0);
    const totalPnl = lots.reduce((s, rt) => s + rt.realizedPnl, 0);
    const holdingDays = lots.map((rt) => rt.holdingDays);
    const entryDates = lots.map((rt) => rt.entryDate).sort();
    // Quantity-weighted average holding days, clamping negatives to 0
    // (negative days come from short sales where acquisition is after sale)
    const weightedHoldingDays =
      totalQty > 0
        ? lots.reduce(
            (s, rt) => s + Math.max(0, rt.holdingDays) * rt.exitQuantity,
            0
          ) / totalQty
        : 0;

    const sellTxQty = lots[0].sellTransactionQty;
    const coverage =
      sellTxQty && sellTxQty > 0 ? totalQty / sellTxQty : 1;

    return {
      saleTransactionId,
      securityId: lots[0].securityId,
      symbol: lots[0].symbol,
      securityName: lots[0].securityName,
      securityType: lots[0].securityType,
      lots,
      totalQuantity: totalQty,
      sellTransactionQty: sellTxQty,
      lotCoverage: Math.min(coverage, 1), // cap at 1 (rounding)
      // Quantity-weighted per-unit price — NOT totalCost / totalQty, which
      // would be ×multiplier for options (entryCost carries the contract
      // multiplier; entryPrice and exitPrice are per-unit). Rechecked under
      // the v2 true-dollar tax_lot_sales convention (WS1 durable fixes,
      // 2026-08-23): cost_basis_allocated/proceeds now store real dollars
      // with the multiplier baked in at write time, and acquisition_price/
      // sale_price still stay per-unit — the reasoning here is unchanged.
      avgEntryPrice:
        totalQty > 0
          ? lots.reduce((s, rt) => s + rt.entryPrice * rt.exitQuantity, 0) /
            totalQty
          : 0,
      exitPrice: lots[0].exitPrice,
      exitDate: lots[0].exitDate,
      earliestEntryDate: entryDates[0],
      latestEntryDate: entryDates[entryDates.length - 1],
      avgHoldingDays: Math.round(weightedHoldingDays),
      maxHoldingDays: Math.max(...holdingDays),
      minHoldingDays: Math.min(...holdingDays),
      totalCost,
      totalProceeds,
      realizedPnl: totalPnl,
      returnPct: totalCost > 0 ? (totalPnl / totalCost) * 100 : 0,
      usdPerUnit: lots[0].usdPerUnit ?? 1,
      conventionPending: lots[0].conventionPending ?? false,
      isSyntheticClose: lots[0].isSyntheticClose ?? false,
    };
  });
}

/** Minimum lot coverage ratio to include a trade in reviews (90%) */
export const MIN_LOT_COVERAGE = 0.9;

/**
 * Filter grouped trades to only those with sufficient FIFO lot coverage.
 * Trades where matched lots cover <80% of the actual sell quantity are excluded
 * (they represent incomplete data — e.g., positions held before import history starts).
 */
export function filterFullyCoveredTrades(
  grouped: GroupedTrade[]
): GroupedTrade[] {
  return grouped.filter((g) => g.lotCoverage >= MIN_LOT_COVERAGE);
}

/**
 * Compute summary metrics from grouped trades (not individual lots).
 * Counts each sale transaction as one trade, matching user expectations.
 * Pure function — no DB access.
 */
export function computeGroupedSummary(
  grouped: GroupedTrade[]
): RoundTripSummary {
  if (grouped.length === 0) {
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

  const winners = grouped.filter((g) => g.realizedPnl > 0);
  const losers = grouped.filter((g) => g.realizedPnl < 0);

  const totalPnl = grouped.reduce((sum, g) => sum + g.realizedPnl, 0);
  const totalHoldingDays = grouped.reduce(
    (sum, g) => sum + g.avgHoldingDays,
    0
  );

  const grossWins = winners.reduce((sum, g) => sum + g.realizedPnl, 0);
  const grossLosses = Math.abs(
    losers.reduce((sum, g) => sum + g.realizedPnl, 0)
  );

  const best = grouped.reduce((max, g) =>
    g.realizedPnl > max.realizedPnl ? g : max
  );
  const worst = grouped.reduce((min, g) =>
    g.realizedPnl < min.realizedPnl ? g : min
  );

  return {
    totalTrades: grouped.length,
    winningTrades: winners.length,
    losingTrades: losers.length,
    winRate: grouped.length > 0 ? winners.length / grouped.length : 0,
    totalRealizedPnl: totalPnl,
    avgHoldingDays:
      grouped.length > 0 ? totalHoldingDays / grouped.length : 0,
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
