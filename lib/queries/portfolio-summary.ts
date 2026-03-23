import type Database from "better-sqlite3";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { formatUSD, formatNumber } from "@/lib/format";

interface AccountValue {
  name: string;
  latest_value: number | null;
  latest_date: string | null;
}

interface EnrichedHolding {
  account_name: string;
  symbol: string;
  security_name: string | null;
  security_type: string | null;
  asset_class: string | null;
  sector: string | null;
  quantity: number;
  cost_basis: number | null;
  latest_price: number | null;
  market_value: number | null;
  unrealized_gain: number | null;
  position_weight_pct: number | null;
}

interface RecentTransaction {
  account_name: string;
  trade_date: string;
  type: string;
  symbol: string | null;
  quantity: number | null;
  amount: number | null;
}

interface AllocationRow {
  group_name: string;
  total_market_value: number;
  percentage: number;
  count: number;
}

interface HarvestCandidate {
  symbol: string;
  account_name: string;
  unrealized_loss: number;
  cost_basis: number;
  days_held: number;
}

interface ApproachingLongTerm {
  symbol: string;
  account_name: string;
  acquisition_date: string;
  long_term_date: string;
  days_remaining: number;
  unrealized_gain: number | null;
}

export function getPortfolioSummaryForChat(db: Database.Database, accountName?: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [];
  lines.push("## Portfolio Summary\n");

  // ─── Resolve accountName to accountId ──────────────────────────
  let accountId: number | undefined;
  if (accountName) {
    const row = db.prepare("SELECT id FROM accounts WHERE name = ?").get(accountName) as { id: number } | undefined;
    accountId = row?.id;
  }

  const holdingsFilter = accountId != null ? `AND h.account_id = ?` : "";
  const holdingsParams = accountId != null ? [accountId] : [];
  const taxLotsFilter = accountId != null ? `AND tl.account_id = ?` : "";
  const taxLotsParams = accountId != null ? [accountId] : [];
  const txnFilter = accountId != null ? `AND t.account_id = ?` : "";
  const txnParams = accountId != null ? [accountId] : [];

  // ─── Account Values ────────────────────────────────────────────
  const accountFilter = accountName ? `WHERE a.name = ?` : `WHERE 1=1`;
  const accountParams = accountName ? [accountName] : [];

  const accountValues = db
    .prepare(
      `SELECT a.name, ms.total_value AS latest_value, ms.month_end_date AS latest_date
       FROM accounts a
       LEFT JOIN monthly_snapshots ms ON ms.account_id = a.id
         AND ms.month_end_date = (
           SELECT MAX(ms2.month_end_date) FROM monthly_snapshots ms2 WHERE ms2.account_id = a.id
         )
       ${accountFilter}
       ORDER BY a.id`
    )
    .all(...accountParams) as AccountValue[];

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

  // ─── All Holdings with enrichment ──────────────────────────────
  const holdings = db
    .prepare(
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (
          SELECT security_id, MAX(date) AS max_date
          FROM prices GROUP BY security_id
        ) lp ON p.security_id = lp.security_id AND p.date = lp.max_date
      ),
      portfolio_total AS (
        SELECT COALESCE(SUM(
          CASE WHEN lp.close_price IS NOT NULL
            THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier")}
            ELSE 0 END
        ), 1) AS total
        FROM holdings h
        JOIN securities s ON s.id = h.security_id
        LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
        WHERE h.as_of_date = (
          SELECT MAX(h2.as_of_date) FROM holdings h2
          WHERE h2.account_id = h.account_id
        )
        AND h.quantity > 0
        AND (s.maturity_date IS NULL OR s.maturity_date >= date('now'))
        ${holdingsFilter}
      )
      SELECT a.name AS account_name, s.symbol, s.name AS security_name,
              s.security_type, s.asset_class, s.sector,
              h.quantity, h.cost_basis, h.as_of_date,
              lp.close_price AS latest_price,
              CASE WHEN lp.close_price IS NOT NULL
                THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier")}
                ELSE NULL
              END AS market_value,
              CASE WHEN lp.close_price IS NOT NULL AND h.cost_basis IS NOT NULL AND h.cost_basis > 0
                THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier")} - h.cost_basis
                ELSE NULL
              END AS unrealized_gain,
              CASE WHEN lp.close_price IS NOT NULL
                THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier")} * 100.0 / (SELECT total FROM portfolio_total)
                ELSE NULL
              END AS position_weight_pct
       FROM holdings h
       JOIN accounts a ON a.id = h.account_id
       JOIN securities s ON s.id = h.security_id
       LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
       WHERE h.as_of_date = (
         SELECT MAX(h2.as_of_date) FROM holdings h2
         WHERE h2.account_id = h.account_id
       )
       AND h.quantity > 0
       AND (s.maturity_date IS NULL OR s.maturity_date >= date('now'))
       ${holdingsFilter}
       ORDER BY market_value DESC`
    )
    .all(...holdingsParams, ...holdingsParams) as EnrichedHolding[];

  if (holdings.length > 0) {
    lines.push("\n### All Holdings");
    for (const h of holdings) {
      const unit = h.security_type === "bond" ? "face" : h.security_type === "option" ? "contracts" : "shares";
      const value = h.market_value != null ? ` MV:${formatUSD(h.market_value)}` : "";
      const gain = h.unrealized_gain != null
        ? ` G/L:${h.unrealized_gain >= 0 ? "+" : ""}${formatUSD(h.unrealized_gain)}`
        : "";
      const weight = h.position_weight_pct != null
        ? ` (${h.position_weight_pct.toFixed(1)}%)`
        : "";
      const sector = h.sector ? ` [${h.sector}]` : "";
      lines.push(
        `- ${h.symbol} (${h.account_name}): ${formatNumber(h.quantity)} ${unit}${value}${gain}${weight}${sector}`
      );
    }
  }

  // ─── Asset Allocation ──────────────────────────────────────────
  const assetAllocation = db
    .prepare(
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      ),
      alloc AS (
        SELECT
          COALESCE(s.asset_class, s.security_type, 'Unknown') AS group_name,
          ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier")} AS mv
        FROM holdings h
        JOIN securities s ON s.id = h.security_id
        LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
        WHERE lp.close_price IS NOT NULL
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
            WHERE h2.account_id = h.account_id
          )
          AND h.quantity > 0
          AND (s.maturity_date IS NULL OR s.maturity_date >= date('now'))
          ${holdingsFilter}
      )
      SELECT group_name, SUM(mv) AS total_market_value,
             SUM(mv) * 100.0 / NULLIF(SUM(SUM(mv)) OVER (), 0) AS percentage,
             COUNT(*) AS count
      FROM alloc
      GROUP BY group_name
      ORDER BY total_market_value DESC`
    )
    .all(...holdingsParams) as AllocationRow[];

  if (assetAllocation.length > 0) {
    lines.push("\n### Asset Allocation");
    for (const a of assetAllocation) {
      lines.push(
        `- ${a.group_name}: ${formatUSD(a.total_market_value)} (${a.percentage.toFixed(1)}%, ${a.count} positions)`
      );
    }
  }

  // Sector allocation (if any sector data exists)
  const sectorAllocation = db
    .prepare(
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      ),
      alloc AS (
        SELECT
          COALESCE(s.sector, 'Unknown') AS group_name,
          ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier")} AS mv
        FROM holdings h
        JOIN securities s ON s.id = h.security_id
        LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
        WHERE lp.close_price IS NOT NULL
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
            WHERE h2.account_id = h.account_id
          )
          AND h.quantity > 0
          AND (s.maturity_date IS NULL OR s.maturity_date >= date('now'))
          ${holdingsFilter}
      )
      SELECT group_name, SUM(mv) AS total_market_value,
             SUM(mv) * 100.0 / NULLIF(SUM(SUM(mv)) OVER (), 0) AS percentage,
             COUNT(*) AS count
      FROM alloc
      GROUP BY group_name
      ORDER BY total_market_value DESC`
    )
    .all(...holdingsParams) as AllocationRow[];

  const hasSectorData = sectorAllocation.some((s) => s.group_name !== "Unknown");
  if (hasSectorData) {
    const withSector = sectorAllocation.filter((s) => s.group_name !== "Unknown");
    const unknown = sectorAllocation.find((s) => s.group_name === "Unknown");
    lines.push("\n### Sector Allocation");
    for (const s of withSector) {
      lines.push(
        `- ${s.group_name}: ${formatUSD(s.total_market_value)} (${s.percentage.toFixed(1)}%)`
      );
    }
    if (unknown) {
      lines.push(
        `- Unclassified: ${formatUSD(unknown.total_market_value)} (${unknown.percentage.toFixed(1)}%, ${unknown.count} positions without sector data)`
      );
    }
  }

  // ─── Tax Summary + Harvesting Candidates ───────────────────────
  const taxLotsAccountFilter = accountId != null ? `AND tax_lots.account_id = ?` : "";
  const taxLotsAccountParams = accountId != null ? [accountId] : [];
  const taxSummary = db
    .prepare(
      `SELECT
        COUNT(*) AS open_lots,
        COALESCE(SUM(quantity_remaining * acquisition_price), 0) AS total_cost_basis
       FROM tax_lots WHERE quantity_remaining > 0 ${taxLotsAccountFilter}`
    )
    .get(...taxLotsAccountParams) as { open_lots: number; total_cost_basis: number };

  const realizedGainsJoin = accountId != null
    ? `JOIN tax_lots ON tax_lots.id = tax_lot_sales.tax_lot_id WHERE tax_lots.account_id = ?`
    : "";
  const realizedGainsParams = accountId != null ? [accountId] : [];
  const realizedGains = db
    .prepare(
      `SELECT
        COALESCE(SUM(realized_gain_loss), 0) AS total,
        COALESCE(SUM(CASE WHEN is_long_term = 1 THEN realized_gain_loss ELSE 0 END), 0) AS long_term,
        COALESCE(SUM(CASE WHEN is_long_term = 0 THEN realized_gain_loss ELSE 0 END), 0) AS short_term
       FROM tax_lot_sales ${realizedGainsJoin}`
    )
    .get(...realizedGainsParams) as { total: number; long_term: number; short_term: number };

  if (taxSummary.open_lots > 0 || realizedGains.total !== 0) {
    lines.push("\n### Tax Summary");
    lines.push(`- Open lots: ${taxSummary.open_lots} (cost basis: ${formatUSD(taxSummary.total_cost_basis)})`);
    lines.push(`- Realized gains: ${formatUSD(realizedGains.total)} (LT: ${formatUSD(realizedGains.long_term)}, ST: ${formatUSD(realizedGains.short_term)})`);
  }

  // Tax-loss harvesting candidates (positions with unrealized losses)
  const harvestCandidates = db
    .prepare(
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT
        s.symbol,
        a.name AS account_name,
        (${adjustedMarketValueSQL("tl.quantity_remaining", "lp.close_price", "s.security_type", "s.multiplier")}
         - ${adjustedMarketValueSQL("tl.quantity_remaining", "tl.acquisition_price", "s.security_type", "s.multiplier")}) AS unrealized_loss,
        tl.cost_basis,
        CAST(julianday(?) - julianday(tl.acquisition_date) AS INTEGER) AS days_held
      FROM tax_lots tl
      JOIN accounts a ON a.id = tl.account_id
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = tl.security_id
      WHERE tl.quantity_remaining > 0
        AND lp.close_price IS NOT NULL
        AND (${adjustedMarketValueSQL("tl.quantity_remaining", "lp.close_price", "s.security_type", "s.multiplier")}
             - ${adjustedMarketValueSQL("tl.quantity_remaining", "tl.acquisition_price", "s.security_type", "s.multiplier")}) < -100
        ${taxLotsFilter}
      ORDER BY unrealized_loss ASC
      LIMIT 5`
    )
    .all(today, ...taxLotsParams) as HarvestCandidate[];

  if (harvestCandidates.length > 0) {
    lines.push("\n### Tax-Loss Harvesting Candidates");
    for (const c of harvestCandidates) {
      lines.push(
        `- ${c.symbol} (${c.account_name}): ${formatUSD(c.unrealized_loss)} unrealized loss, held ${c.days_held} days`
      );
    }
  }

  // Lots approaching long-term threshold (within 60 days)
  const approachingLT = db
    .prepare(
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT
        s.symbol,
        a.name AS account_name,
        tl.acquisition_date,
        date(tl.acquisition_date, '+366 days') AS long_term_date,
        CAST(julianday(date(tl.acquisition_date, '+366 days')) - julianday(?) AS INTEGER) AS days_remaining,
        CASE WHEN lp.close_price IS NOT NULL
          THEN ${adjustedMarketValueSQL("tl.quantity_remaining", "lp.close_price", "s.security_type", "s.multiplier")}
               - ${adjustedMarketValueSQL("tl.quantity_remaining", "tl.acquisition_price", "s.security_type", "s.multiplier")}
          ELSE NULL END AS unrealized_gain
      FROM tax_lots tl
      JOIN accounts a ON a.id = tl.account_id
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = tl.security_id
      WHERE tl.quantity_remaining > 0
        AND julianday(date(tl.acquisition_date, '+366 days')) > julianday(?)
        AND julianday(date(tl.acquisition_date, '+366 days')) - julianday(?) <= 60
        ${taxLotsFilter}
      ORDER BY days_remaining ASC
      LIMIT 10`
    )
    .all(today, today, today, ...taxLotsParams) as ApproachingLongTerm[];

  if (approachingLT.length > 0) {
    lines.push("\n### Lots Approaching Long-Term Status (within 60 days)");
    for (const lot of approachingLT) {
      const gain = lot.unrealized_gain != null
        ? ` (unrealized: ${lot.unrealized_gain >= 0 ? "+" : ""}${formatUSD(lot.unrealized_gain)})`
        : "";
      lines.push(
        `- ${lot.symbol} (${lot.account_name}): ${lot.days_remaining} days until long-term (${lot.long_term_date})${gain}`
      );
    }
  }

  // ─── Income Summary (trailing 12 months from snapshots) ────────
  const incomeSummary = db
    .prepare(
      `SELECT
        COALESCE(SUM(dividends), 0) AS total_dividends,
        COALESCE(SUM(interest), 0) AS total_interest,
        COALESCE(SUM(COALESCE(fees, 0) + COALESCE(commissions, 0)), 0) AS total_fees
      FROM monthly_snapshots
      WHERE month_end_date >= date(?, '-12 months')
      ${accountId != null ? `AND monthly_snapshots.account_id = ?` : ""}`
    )
    .get(today, ...holdingsParams) as { total_dividends: number; total_interest: number; total_fees: number };

  if (incomeSummary.total_dividends > 0 || incomeSummary.total_interest > 0) {
    lines.push("\n### Income (Trailing 12 Months)");
    lines.push(`- Dividends: ${formatUSD(incomeSummary.total_dividends)}`);
    lines.push(`- Interest: ${formatUSD(incomeSummary.total_interest)}`);
    if (incomeSummary.total_fees > 0) {
      lines.push(`- Fees/Commissions: ${formatUSD(incomeSummary.total_fees)}`);
    }
    const netIncome = incomeSummary.total_dividends + incomeSummary.total_interest - incomeSummary.total_fees;
    lines.push(`- Net Income: ${formatUSD(netIncome)}`);
  }

  // ─── Recent Transactions ───────────────────────────────────────
  const recentTxns = db
    .prepare(
      `SELECT a.name AS account_name, t.trade_date, t.type,
              s.symbol, t.quantity, t.amount
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN securities s ON s.id = t.security_id
       WHERE 1=1 ${txnFilter}
       ORDER BY t.trade_date DESC
       LIMIT 20`
    )
    .all(...txnParams) as RecentTransaction[];

  if (recentTxns.length > 0) {
    lines.push("\n### Recent Transactions");
    for (const t of recentTxns) {
      const sym = t.symbol ?? "CASH";
      const amt = t.amount !== null ? ` ${formatUSD(Math.abs(t.amount))}` : "";
      const qty = t.quantity !== null ? ` ${t.quantity} shares` : "";
      lines.push(`- ${t.trade_date} | ${t.account_name} | ${t.type} ${sym}${qty}${amt}`);
    }
  }

  // ─── Data Quality Notes ────────────────────────────────────────
  const warnings: string[] = [];

  const holdingsWithoutPrices = holdings.filter((h) => h.latest_price == null);
  if (holdingsWithoutPrices.length > 0) {
    const syms = holdingsWithoutPrices.map((h) => h.symbol).join(", ");
    warnings.push(
      `${holdingsWithoutPrices.length} holding(s) have no price data: ${syms}`
    );
  }

  const latestPriceDate = db
    .prepare("SELECT MAX(date) AS max_date FROM prices")
    .get() as { max_date: string | null };
  if (latestPriceDate?.max_date) {
    lines.push(`\n### Data Freshness`);
    lines.push(`- Latest price date: ${latestPriceDate.max_date}`);
    const priceAge = Math.floor(
      (Date.now() - new Date(latestPriceDate.max_date + "T00:00:00Z").getTime()) /
        (1000 * 60 * 60 * 24)
    );
    if (priceAge > 7) {
      warnings.push(`Price data is ${priceAge} days old (latest: ${latestPriceDate.max_date})`);
    }
  }

  const latestSnapshotDate = db
    .prepare("SELECT MAX(month_end_date) AS max_date FROM monthly_snapshots")
    .get() as { max_date: string | null };
  if (latestSnapshotDate?.max_date) {
    lines.push(`- Latest snapshot: ${latestSnapshotDate.max_date}`);
  }

  const latestHoldingsDate = db
    .prepare("SELECT MAX(as_of_date) AS max_date FROM holdings")
    .get() as { max_date: string | null };
  if (latestHoldingsDate?.max_date) {
    lines.push(`- Latest holdings: ${latestHoldingsDate.max_date}`);
  }

  if (warnings.length > 0) {
    lines.push("\n### Data Quality Notes");
    for (const w of warnings) {
      lines.push(`- ⚠ ${w}`);
    }
  }

  return lines.join("\n");
}
