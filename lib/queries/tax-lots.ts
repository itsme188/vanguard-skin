import type Database from "better-sqlite3";
import { adjustedMarketValueSQL } from "@/lib/valuation";

export interface TaxLotWithSecurity {
  id: number;
  account_id: number;
  account_name: string;
  security_id: number;
  symbol: string;
  security_name: string | null;
  acquisition_date: string;
  acquisition_price: number;
  quantity_acquired: number;
  quantity_remaining: number;
  cost_basis: number;
  adjusted_cost_basis: number;
  current_price: number | null;
  current_value: number | null;
  unrealized_gain: number | null;
  is_from_opening_snapshot: number;
}

export interface TaxLotSaleWithDetails {
  id: number;
  account_name: string;
  account_id: number;
  security_id: number;
  symbol: string;
  security_name: string | null;
  acquisition_date: string;
  sale_date: string;
  quantity_sold: number;
  acquisition_price: number;
  sale_price: number;
  proceeds: number;
  cost_basis_allocated: number;
  realized_gain_loss: number;
  is_long_term: number;
  holding_period_days: number;
  currency: string;
  /** 1 for a short round-trip lot (SELL_TO_OPEN → cover); see lib/compute/tax-lots.ts. */
  is_short: number;
  /**
   * True when the sale transaction is the engine-owned synthetic
   * RECONCILE_CLOSE row (never real broker activity — computeTaxLots
   * synthesizes it to close a lot the broker's own snapshot shows zeroed
   * with no matching statement SELL). Already excluded from filing
   * surfaces (`filingOnly`); operational P&L surfaces that still show
   * these rows must label the realized figure "estimated" rather than
   * hide it (finding 1, number-trust durable fixes).
   */
  is_synthetic_close: boolean;
}

export interface TaxLotSummary {
  totalOpenLots: number;
  totalClosedSales: number;
  totalUnrealizedGain: number;
  totalRealizedGain: number;
  longTermGain: number;
  shortTermGain: number;
  /** Sales on non-USD securities excluded from the USD realized totals above (never fabricate an FX vintage on tax rows). */
  excludedNonUsdSales: number;
}

export interface AccountTaxSummary {
  account_id: number;
  account_name: string;
  totalClosedSales: number;
  totalRealizedGain: number;
  longTermGain: number;
  shortTermGain: number;
  excludedNonUsdSales: number;
}

/** Realized G/L is stored native per security; only USD rows may sum into USD totals. */
const USD_ONLY = `COALESCE(s.currency, 'USD') = 'USD'`;

export function getOpenTaxLots(db: Database.Database): TaxLotWithSecurity[] {
  return db
    .prepare(
      `SELECT
        tl.id, tl.account_id, a.name AS account_name,
        tl.security_id, s.symbol, s.name AS security_name,
        tl.acquisition_date, tl.acquisition_price,
        tl.quantity_acquired, tl.quantity_remaining,
        tl.cost_basis * COALESCE(fx.usd_per_unit, 1) AS cost_basis, tl.is_from_opening_snapshot,
        ${adjustedMarketValueSQL("tl.quantity_remaining", "tl.acquisition_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} AS adjusted_cost_basis,
        p.close_price AS current_price,
        CASE WHEN p.close_price IS NOT NULL
          THEN ${adjustedMarketValueSQL("tl.quantity_remaining", "p.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
          ELSE NULL END AS current_value,
        CASE WHEN p.close_price IS NOT NULL
          THEN ${adjustedMarketValueSQL("tl.quantity_remaining", "p.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
               - ${adjustedMarketValueSQL("tl.quantity_remaining", "tl.acquisition_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
          ELSE NULL END AS unrealized_gain
      FROM tax_lots tl
      JOIN accounts a ON a.id = tl.account_id
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      LEFT JOIN prices p ON p.security_id = tl.security_id
        AND p.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = tl.security_id)
      WHERE tl.quantity_remaining > 0
      ORDER BY a.name, s.symbol, tl.acquisition_date`
    )
    .all() as TaxLotWithSecurity[];
}

export function getClosedTaxLotSales(
  db: Database.Database,
  year?: number,
  opts?: { filingOnly?: boolean }
): TaxLotSaleWithDetails[] {
  const baseSql = `SELECT
        tls.id, a.name AS account_name, tl.account_id, tl.security_id, tl.is_short,
        s.symbol, s.name AS security_name,
        tl.acquisition_date, tls.sale_date,
        tls.quantity_sold, tl.acquisition_price,
        tls.sale_price, tls.proceeds,
        tls.cost_basis_allocated, tls.realized_gain_loss,
        tls.is_long_term, tls.holding_period_days,
        COALESCE(s.currency, 'USD') AS currency,
        (t.type = 'RECONCILE_CLOSE') AS is_synthetic_close
      FROM tax_lot_sales tls
      JOIN tax_lots tl ON tl.id = tls.tax_lot_id
      JOIN accounts a ON a.id = tl.account_id
      JOIN securities s ON s.id = tl.security_id
      JOIN transactions t ON t.id = tls.sale_transaction_id`;

  // filingOnly (Task 6 dependency): exclude premium-rollover closes (option
  // premium that moved to the underlying leg — not a separate disposition,
  // IRS Pub 550) and engine-synthesized RECONCILE_CLOSE sales (never real
  // broker activity) from anything destined for a filing surface.
  const conditions: string[] = [];
  const params: string[] = [];
  if (year) {
    conditions.push("tls.sale_date >= ? AND tls.sale_date <= ?");
    params.push(`${year}-01-01`, `${year}-12-31`);
  }
  if (opts?.filingOnly) {
    conditions.push("tls.premium_rollover = 0 AND t.type != 'RECONCILE_CLOSE'");
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = db
    .prepare(`${baseSql} ${whereClause} ORDER BY tls.sale_date DESC, s.symbol`)
    .all(...params) as Array<
    Omit<TaxLotSaleWithDetails, "is_synthetic_close"> & { is_synthetic_close: number }
  >;
  return rows.map((r) => ({ ...r, is_synthetic_close: Boolean(r.is_synthetic_close) }));
}

export function getTaxLotSummary(
  db: Database.Database,
  year?: number
): TaxLotSummary {
  const openLots = db
    .prepare(
      `SELECT
        COUNT(*) AS totalOpenLots,
        COALESCE(SUM(
          CASE WHEN p.close_price IS NOT NULL
            THEN ${adjustedMarketValueSQL("tl.quantity_remaining", "p.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
                 - ${adjustedMarketValueSQL("tl.quantity_remaining", "tl.acquisition_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
            ELSE 0 END
        ), 0) AS totalUnrealizedGain
      FROM tax_lots tl
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      LEFT JOIN prices p ON p.security_id = tl.security_id
        AND p.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = tl.security_id)
      WHERE tl.quantity_remaining > 0`
    )
    .get() as { totalOpenLots: number; totalUnrealizedGain: number };

  const closedSalesSql = `SELECT
        COUNT(*) AS totalClosedSales,
        COALESCE(SUM(CASE WHEN ${USD_ONLY} THEN tls.realized_gain_loss ELSE 0 END), 0) AS totalRealizedGain,
        COALESCE(SUM(CASE WHEN ${USD_ONLY} AND tls.is_long_term = 1 THEN tls.realized_gain_loss ELSE 0 END), 0) AS longTermGain,
        COALESCE(SUM(CASE WHEN ${USD_ONLY} AND tls.is_long_term = 0 THEN tls.realized_gain_loss ELSE 0 END), 0) AS shortTermGain,
        COALESCE(SUM(CASE WHEN NOT (${USD_ONLY}) THEN 1 ELSE 0 END), 0) AS excludedNonUsdSales
      FROM tax_lot_sales tls
      JOIN tax_lots tl ON tl.id = tls.tax_lot_id
      JOIN securities s ON s.id = tl.security_id`;

  const closedSales = (year
    ? db.prepare(`${closedSalesSql} WHERE tls.sale_date >= ? AND tls.sale_date <= ?`).get(`${year}-01-01`, `${year}-12-31`)
    : db.prepare(closedSalesSql).get()
  ) as {
      totalClosedSales: number;
      totalRealizedGain: number;
      longTermGain: number;
      shortTermGain: number;
      excludedNonUsdSales: number;
    };

  return {
    totalOpenLots: openLots.totalOpenLots,
    totalClosedSales: closedSales.totalClosedSales,
    totalUnrealizedGain: openLots.totalUnrealizedGain,
    totalRealizedGain: closedSales.totalRealizedGain,
    longTermGain: closedSales.longTermGain,
    shortTermGain: closedSales.shortTermGain,
    excludedNonUsdSales: closedSales.excludedNonUsdSales,
  };
}

export function getTaxLotSummaryByAccount(
  db: Database.Database,
  year: number
): AccountTaxSummary[] {
  return db
    .prepare(
      `SELECT
        tl.account_id,
        a.name AS account_name,
        COUNT(*) AS totalClosedSales,
        COALESCE(SUM(CASE WHEN ${USD_ONLY} THEN tls.realized_gain_loss ELSE 0 END), 0) AS totalRealizedGain,
        COALESCE(SUM(CASE WHEN ${USD_ONLY} AND tls.is_long_term = 1 THEN tls.realized_gain_loss ELSE 0 END), 0) AS longTermGain,
        COALESCE(SUM(CASE WHEN ${USD_ONLY} AND tls.is_long_term = 0 THEN tls.realized_gain_loss ELSE 0 END), 0) AS shortTermGain,
        COALESCE(SUM(CASE WHEN NOT (${USD_ONLY}) THEN 1 ELSE 0 END), 0) AS excludedNonUsdSales
      FROM tax_lot_sales tls
      JOIN tax_lots tl ON tl.id = tls.tax_lot_id
      JOIN accounts a ON a.id = tl.account_id
      JOIN securities s ON s.id = tl.security_id
      WHERE tls.sale_date >= ? AND tls.sale_date <= ?
      GROUP BY tl.account_id
      ORDER BY a.name`
    )
    .all(`${year}-01-01`, `${year}-12-31`) as AccountTaxSummary[];
}

export function getTaxLotAccountNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT a.name
      FROM accounts a
      JOIN tax_lots tl ON tl.account_id = a.id
      ORDER BY a.name`
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

export function getAvailableSaleYears(db: Database.Database): number[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT CAST(strftime('%Y', sale_date) AS INTEGER) AS year
      FROM tax_lot_sales
      ORDER BY year DESC`
    )
    .all() as { year: number }[];
  return rows.map((r) => r.year);
}
