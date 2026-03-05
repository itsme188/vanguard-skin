import type Database from "better-sqlite3";

interface AccountValue {
  name: string;
  latest_value: number | null;
  latest_date: string | null;
}

interface TopHolding {
  account_name: string;
  symbol: string;
  security_name: string | null;
  security_type: string | null;
  quantity: number;
  latest_price: number | null;
  market_value: number | null;
  as_of_date: string;
}

interface RecentTransaction {
  account_name: string;
  trade_date: string;
  type: string;
  symbol: string | null;
  quantity: number | null;
  amount: number | null;
}

export function getPortfolioSummaryForChat(db: Database.Database): string {
  // Account values from latest monthly snapshots
  const accountValues = db
    .prepare(
      `SELECT a.name, ms.total_value AS latest_value, ms.month_end_date AS latest_date
       FROM accounts a
       LEFT JOIN monthly_snapshots ms ON ms.account_id = a.id
         AND ms.month_end_date = (
           SELECT MAX(ms2.month_end_date) FROM monthly_snapshots ms2 WHERE ms2.account_id = a.id
         )
       ORDER BY a.id`
    )
    .all() as AccountValue[];

  // Top holdings with market values
  const topHoldings = db
    .prepare(
      `SELECT a.name AS account_name, s.symbol, s.name AS security_name,
              s.security_type, h.quantity, h.as_of_date,
              (SELECT p.close_price FROM prices p WHERE p.security_id = h.security_id ORDER BY p.date DESC LIMIT 1) AS latest_price,
              CASE WHEN s.security_type = 'bond'
                THEN h.quantity * COALESCE(
                  (SELECT p.close_price FROM prices p WHERE p.security_id = h.security_id ORDER BY p.date DESC LIMIT 1),
                  0) / 100.0
                ELSE h.quantity * COALESCE(
                  (SELECT p.close_price FROM prices p WHERE p.security_id = h.security_id ORDER BY p.date DESC LIMIT 1),
                  0)
              END AS market_value
       FROM holdings h
       JOIN accounts a ON a.id = h.account_id
       JOIN securities s ON s.id = h.security_id
       WHERE h.as_of_date = (
         SELECT MAX(h2.as_of_date) FROM holdings h2
         WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
       )
       ORDER BY market_value DESC
       LIMIT 25`
    )
    .all() as TopHolding[];

  // Recent transactions
  const recentTxns = db
    .prepare(
      `SELECT a.name AS account_name, t.trade_date, t.type,
              s.symbol, t.quantity, t.amount
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN securities s ON s.id = t.security_id
       ORDER BY t.trade_date DESC
       LIMIT 20`
    )
    .all() as RecentTransaction[];

  // Tax lot summary
  const taxSummary = db
    .prepare(
      `SELECT
        COUNT(*) AS open_lots,
        COALESCE(SUM(quantity_remaining * acquisition_price), 0) AS total_cost_basis
       FROM tax_lots WHERE quantity_remaining > 0`
    )
    .get() as { open_lots: number; total_cost_basis: number };

  const realizedGains = db
    .prepare(
      `SELECT
        COALESCE(SUM(realized_gain_loss), 0) AS total,
        COALESCE(SUM(CASE WHEN is_long_term = 1 THEN realized_gain_loss ELSE 0 END), 0) AS long_term,
        COALESCE(SUM(CASE WHEN is_long_term = 0 THEN realized_gain_loss ELSE 0 END), 0) AS short_term
       FROM tax_lot_sales`
    )
    .get() as { total: number; long_term: number; short_term: number };

  // Build context string
  const lines: string[] = [];
  lines.push("## Portfolio Summary\n");

  // Account values
  lines.push("### Account Values");
  for (const av of accountValues) {
    if (av.latest_value !== null) {
      lines.push(`- ${av.name}: $${av.latest_value.toLocaleString()} (as of ${av.latest_date})`);
    } else {
      lines.push(`- ${av.name}: No data yet`);
    }
  }

  const totalValue = accountValues.reduce((sum, a) => sum + (a.latest_value ?? 0), 0);
  if (totalValue > 0) {
    lines.push(`- **Total Portfolio**: $${totalValue.toLocaleString()}`);
  }

  // Holdings
  if (topHoldings.length > 0) {
    lines.push("\n### Top Holdings");
    for (const h of topHoldings) {
      const unit = h.security_type === "bond" ? "face value" : "shares";
      const value = h.market_value ? ` — market value $${h.market_value.toLocaleString()}` : "";
      const price = h.latest_price ? ` @ $${h.latest_price}` : "";
      lines.push(
        `- ${h.symbol} (${h.account_name}): ${h.quantity.toLocaleString()} ${unit}${price}${value}${h.security_name ? ` — ${h.security_name}` : ""}`
      );
    }
  }

  // Tax summary
  if (taxSummary.open_lots > 0 || realizedGains.total !== 0) {
    lines.push("\n### Tax Lot Summary");
    lines.push(`- Open lots: ${taxSummary.open_lots} (cost basis: $${taxSummary.total_cost_basis.toLocaleString()})`);
    lines.push(`- Realized gains: $${realizedGains.total.toLocaleString()} (LT: $${realizedGains.long_term.toLocaleString()}, ST: $${realizedGains.short_term.toLocaleString()})`);
  }

  // Recent transactions
  if (recentTxns.length > 0) {
    lines.push("\n### Recent Transactions");
    for (const t of recentTxns) {
      const sym = t.symbol ?? "CASH";
      const amt = t.amount !== null ? ` $${Math.abs(t.amount).toLocaleString()}` : "";
      const qty = t.quantity !== null ? ` ${t.quantity} shares` : "";
      lines.push(`- ${t.trade_date} | ${t.account_name} | ${t.type} ${sym}${qty}${amt}`);
    }
  }

  return lines.join("\n");
}
