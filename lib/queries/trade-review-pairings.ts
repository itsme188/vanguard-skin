import type Database from "better-sqlite3";

/** Compare frozen reviews with current pairings, without rewriting their AI prose. */
export function getStaleTradeReviewIds(db: Database.Database, reviewIds: number[]): Set<number> {
  if (reviewIds.length === 0) return new Set();
  const ids = [...new Set(reviewIds)];
  const rows = db.prepare(`SELECT DISTINCT r.review_id
    FROM trade_roundtrips r JOIN securities s ON s.id=r.security_id
    LEFT JOIN fx_rates fx ON fx.currency=s.currency
    WHERE r.review_id IN (${ids.map(() => "?").join(",")}) AND (
      r.entry_date > r.exit_date OR NOT EXISTS (
        SELECT 1 FROM tax_lot_sales x JOIN tax_lots l ON l.id=x.tax_lot_id
        WHERE x.sale_transaction_id=r.sale_transaction_id
          AND l.account_id=r.account_id AND l.security_id=r.security_id
          AND l.acquisition_date=r.entry_date AND x.sale_date=r.exit_date
          AND l.acquisition_date <= x.sale_date
          AND ABS(x.quantity_sold-r.exit_quantity)<0.00000001
          AND ABS(x.cost_basis_allocated*COALESCE(fx.usd_per_unit,1)-r.entry_cost)<0.005
          AND ABS(x.proceeds*COALESCE(fx.usd_per_unit,1)-r.exit_proceeds)<0.005
          AND ABS(x.realized_gain_loss*COALESCE(fx.usd_per_unit,1)-r.realized_pnl)<0.005
      ))`).all(...ids) as { review_id: number }[];
  return new Set(rows.map((r) => r.review_id));
}
