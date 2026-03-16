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
}

export interface TaxLotSummary {
  totalOpenLots: number;
  totalClosedSales: number;
  totalUnrealizedGain: number;
  totalRealizedGain: number;
  longTermGain: number;
  shortTermGain: number;
}

export interface AccountTaxSummary {
  account_id: number;
  account_name: string;
  totalClosedSales: number;
  totalRealizedGain: number;
  longTermGain: number;
  shortTermGain: number;
}

export function getOpenTaxLots(db: Database.Database): TaxLotWithSecurity[] {
  return db
    .prepare(
      `SELECT
        tl.id, tl.account_id, a.name AS account_name,
        tl.security_id, s.symbol, s.name AS security_name,
        tl.acquisition_date, tl.acquisition_price,
        tl.quantity_acquired, tl.quantity_remaining,
        tl.cost_basis, tl.is_from_opening_snapshot,
        ${adjustedMarketValueSQL("tl.quantity_remaining", "tl.acquisition_price", "s.security_type", "s.multiplier")} AS adjusted_cost_basis,
        p.close_price AS current_price,
        CASE WHEN p.close_price IS NOT NULL
          THEN ${adjustedMarketValueSQL("tl.quantity_remaining", "p.close_price", "s.security_type", "s.multiplier")}
          ELSE NULL END AS current_value,
        CASE WHEN p.close_price IS NOT NULL
          THEN ${adjustedMarketValueSQL("tl.quantity_remaining", "p.close_price", "s.security_type", "s.multiplier")}
               - ${adjustedMarketValueSQL("tl.quantity_remaining", "tl.acquisition_price", "s.security_type", "s.multiplier")}
          ELSE NULL END AS unrealized_gain
      FROM tax_lots tl
      JOIN accounts a ON a.id = tl.account_id
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN prices p ON p.security_id = tl.security_id
        AND p.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = tl.security_id)
      WHERE tl.quantity_remaining > 0
      ORDER BY a.name, s.symbol, tl.acquisition_date`
    )
    .all() as TaxLotWithSecurity[];
}

export function getClosedTaxLotSales(
  db: Database.Database,
  year?: number
): TaxLotSaleWithDetails[] {
  const baseSql = `SELECT
        tls.id, a.name AS account_name, tl.account_id,
        s.symbol, s.name AS security_name,
        tl.acquisition_date, tls.sale_date,
        tls.quantity_sold, tl.acquisition_price,
        tls.sale_price, tls.proceeds,
        tls.cost_basis_allocated, tls.realized_gain_loss,
        tls.is_long_term, tls.holding_period_days
      FROM tax_lot_sales tls
      JOIN tax_lots tl ON tl.id = tls.tax_lot_id
      JOIN accounts a ON a.id = tl.account_id
      JOIN securities s ON s.id = tl.security_id`;

  if (year) {
    return db
      .prepare(`${baseSql} WHERE tls.sale_date >= ? AND tls.sale_date <= ? ORDER BY tls.sale_date DESC, s.symbol`)
      .all(`${year}-01-01`, `${year}-12-31`) as TaxLotSaleWithDetails[];
  }
  return db
    .prepare(`${baseSql} ORDER BY tls.sale_date DESC, s.symbol`)
    .all() as TaxLotSaleWithDetails[];
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
            THEN ${adjustedMarketValueSQL("tl.quantity_remaining", "p.close_price", "s.security_type", "s.multiplier")}
                 - ${adjustedMarketValueSQL("tl.quantity_remaining", "tl.acquisition_price", "s.security_type", "s.multiplier")}
            ELSE 0 END
        ), 0) AS totalUnrealizedGain
      FROM tax_lots tl
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN prices p ON p.security_id = tl.security_id
        AND p.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = tl.security_id)
      WHERE tl.quantity_remaining > 0`
    )
    .get() as { totalOpenLots: number; totalUnrealizedGain: number };

  const closedSalesSql = `SELECT
        COUNT(*) AS totalClosedSales,
        COALESCE(SUM(realized_gain_loss), 0) AS totalRealizedGain,
        COALESCE(SUM(CASE WHEN is_long_term = 1 THEN realized_gain_loss ELSE 0 END), 0) AS longTermGain,
        COALESCE(SUM(CASE WHEN is_long_term = 0 THEN realized_gain_loss ELSE 0 END), 0) AS shortTermGain
      FROM tax_lot_sales`;

  const closedSales = (year
    ? db.prepare(`${closedSalesSql} WHERE sale_date >= ? AND sale_date <= ?`).get(`${year}-01-01`, `${year}-12-31`)
    : db.prepare(closedSalesSql).get()
  ) as {
      totalClosedSales: number;
      totalRealizedGain: number;
      longTermGain: number;
      shortTermGain: number;
    };

  return {
    totalOpenLots: openLots.totalOpenLots,
    totalClosedSales: closedSales.totalClosedSales,
    totalUnrealizedGain: openLots.totalUnrealizedGain,
    totalRealizedGain: closedSales.totalRealizedGain,
    longTermGain: closedSales.longTermGain,
    shortTermGain: closedSales.shortTermGain,
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
        COALESCE(SUM(tls.realized_gain_loss), 0) AS totalRealizedGain,
        COALESCE(SUM(CASE WHEN tls.is_long_term = 1 THEN tls.realized_gain_loss ELSE 0 END), 0) AS longTermGain,
        COALESCE(SUM(CASE WHEN tls.is_long_term = 0 THEN tls.realized_gain_loss ELSE 0 END), 0) AS shortTermGain
      FROM tax_lot_sales tls
      JOIN tax_lots tl ON tl.id = tls.tax_lot_id
      JOIN accounts a ON a.id = tl.account_id
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
