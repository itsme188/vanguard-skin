import type Database from "better-sqlite3";
import { bondAdjustedMarketValueSQL } from "@/lib/valuation";
import { formatUSD, formatNumber } from "@/lib/format";

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
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (
          SELECT security_id, MAX(date) AS max_date
          FROM prices GROUP BY security_id
        ) lp ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT a.name AS account_name, s.symbol, s.name AS security_name,
              s.security_type, h.quantity, h.as_of_date,
              lp.close_price AS latest_price,
              CASE WHEN lp.close_price IS NOT NULL
                THEN ${bondAdjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type")}
                ELSE NULL
              END AS market_value
       FROM holdings h
       JOIN accounts a ON a.id = h.account_id
       JOIN securities s ON s.id = h.security_id
       LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
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
      lines.push(`- ${av.name}: ${formatUSD(av.latest_value)} (as of ${av.latest_date})`);
    } else {
      lines.push(`- ${av.name}: No data yet`);
    }
  }

  const totalValue = accountValues.reduce((sum, a) => sum + (a.latest_value ?? 0), 0);
  if (totalValue > 0) {
    lines.push(`- **Total Portfolio**: ${formatUSD(totalValue)}`);
  }

  // Holdings
  if (topHoldings.length > 0) {
    lines.push("\n### Top Holdings");
    for (const h of topHoldings) {
      const unit = h.security_type === "bond" ? "face value" : "shares";
      const value = h.market_value != null ? ` — market value ${formatUSD(h.market_value)}` : "";
      const price = h.latest_price != null ? ` @ $${h.latest_price}` : " (no price data)";
      lines.push(
        `- ${h.symbol} (${h.account_name}): ${formatNumber(h.quantity)} ${unit}${price}${value}${h.security_name ? ` — ${h.security_name}` : ""}`
      );
    }
  }

  // Tax summary
  if (taxSummary.open_lots > 0 || realizedGains.total !== 0) {
    lines.push("\n### Tax Lot Summary");
    lines.push(`- Open lots: ${taxSummary.open_lots} (cost basis: ${formatUSD(taxSummary.total_cost_basis)})`);
    lines.push(`- Realized gains: ${formatUSD(realizedGains.total)} (LT: ${formatUSD(realizedGains.long_term)}, ST: ${formatUSD(realizedGains.short_term)})`);
  }

  // Recent transactions
  if (recentTxns.length > 0) {
    lines.push("\n### Recent Transactions");
    for (const t of recentTxns) {
      const sym = t.symbol ?? "CASH";
      const amt = t.amount !== null ? ` ${formatUSD(Math.abs(t.amount))}` : "";
      const qty = t.quantity !== null ? ` ${t.quantity} shares` : "";
      lines.push(`- ${t.trade_date} | ${t.account_name} | ${t.type} ${sym}${qty}${amt}`);
    }
  }

  // Data quality warnings
  const warnings: string[] = [];

  const holdingsWithoutPrices = topHoldings.filter((h) => h.latest_price == null);
  if (holdingsWithoutPrices.length > 0) {
    const syms = holdingsWithoutPrices.map((h) => h.symbol).join(", ");
    warnings.push(
      `${holdingsWithoutPrices.length} holding(s) have no price data and are excluded from market values: ${syms}`
    );
  }

  const latestPriceDate = db
    .prepare("SELECT MAX(date) AS max_date FROM prices")
    .get() as { max_date: string | null };
  if (latestPriceDate?.max_date) {
    const priceAge = Math.floor(
      (Date.now() - new Date(latestPriceDate.max_date + "T00:00:00Z").getTime()) /
        (1000 * 60 * 60 * 24)
    );
    if (priceAge > 45) {
      warnings.push(`Price data may be stale — most recent price is from ${latestPriceDate.max_date} (${priceAge} days ago)`);
    }
  }

  const latestSnapshotDate = db
    .prepare("SELECT MAX(month_end_date) AS max_date FROM monthly_snapshots")
    .get() as { max_date: string | null };
  if (latestSnapshotDate?.max_date) {
    const snapAge = Math.floor(
      (Date.now() - new Date(latestSnapshotDate.max_date + "T00:00:00Z").getTime()) /
        (1000 * 60 * 60 * 24)
    );
    if (snapAge > 45) {
      warnings.push(`Account values may be stale — most recent snapshot is from ${latestSnapshotDate.max_date} (${snapAge} days ago)`);
    }
  }

  if (warnings.length > 0) {
    lines.push("\n### Data Quality Notes");
    for (const w of warnings) {
      lines.push(`- ${w}`);
    }
  }

  return lines.join("\n");
}
