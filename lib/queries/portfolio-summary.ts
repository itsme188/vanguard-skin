import type Database from "better-sqlite3";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { formatUSD, formatNumber } from "@/lib/format";
import { getTaxConventionState } from "@/lib/compute/tax-convention";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { todayET } from "@/lib/calendar/date-utils";
import {
  getPortfolioCurrentValues,
  type AccountValueSourceKind,
} from "@/lib/queries/dashboard";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import { CURRENCY_CONVERSION_SECURITY_SQL, USD_ONLY } from "@/lib/queries/tax-lots";
import { longTermDateSql } from "@/lib/queries/long-term-sql";
import {
  isPendingStatementLot,
  pendingStatementKey,
  pendingStatementKeySet,
} from "@/lib/queries/pending-statement";

const CONVENTION_PENDING_NOTE =
  "Note: cost-basis figures are pending a recompute under the corrected dollar convention and may be unit-inconsistent.";

/** How each account's value source is named to the model. */
const ACCOUNT_VALUE_SOURCE_LABEL: Record<AccountValueSourceKind, string> = {
  live: "live broker value",
  daily: "daily valuation",
  statement: "statement",
};

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

/** Join keys selected only to consult the pending-statement read model. */
interface PairKeyed {
  account_id: number;
  security_id: number;
  is_short: number;
}

export function getPortfolioSummaryForChat(db: Database.Database, accountName?: string): string {
  // ET day — a UTC slice reads tomorrow from 20:00 ET and shifts every
  // days-to-long-term count and trailing window below by one.
  const today = todayET();
  const lines: string[] = [];
  lines.push("## Portfolio Summary\n");
  const conventionPending = !getTaxConventionState(db).recomputeCurrent;

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
  // Owner ruling 2026-10-08: the chat reads the Portfolio strip's total. The
  // per-account selection (recent live row, else newer daily valuation, else
  // latest statement) is the strip's own, from one shared helper, so the two
  // surfaces cannot state different totals. A named account that matches
  // nothing is an empty scope, never the whole portfolio.
  const valueScope = accountName ? (accountId != null ? [accountId] : []) : undefined;
  const portfolioValues = getPortfolioCurrentValues(db, valueScope);

  lines.push("### Account Values");
  for (const av of portfolioValues.accounts) {
    if (av.currentValue !== null) {
      const kind = av.sourceKind ? `, ${ACCOUNT_VALUE_SOURCE_LABEL[av.sourceKind]}` : "";
      lines.push(`- ${av.accountName}: ${formatUSD(av.currentValue)} (as of ${av.asOfDate}${kind})`);
    } else {
      lines.push(`- ${av.accountName}: No data yet`);
    }
  }

  if (portfolioValues.totalValue > 0) {
    const mixedDates =
      portfolioValues.oldestDate !== null && portfolioValues.oldestDate !== portfolioValues.latestDate;
    const asOf = portfolioValues.latestDate
      ? ` (as of ${portfolioValues.latestDate}${
          mixedDates
            ? `; the accounts are valued on different dates, the oldest account value is dated ${portfolioValues.oldestDate}`
            : ""
        })`
      : "";
    lines.push(`- **Total Portfolio**: ${formatUSD(portfolioValues.totalValue)}${asOf}`);
    lines.push(
      "- This total is the same figure as the Portfolio strip on Today. Each account line above states its own date and source.",
    );
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
            THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
            ELSE 0 END
        ), 1) AS total
        FROM holdings h
        JOIN securities s ON s.id = h.security_id
        LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
        LEFT JOIN fx_rates fx ON fx.currency = s.currency
        WHERE ${latestHoldingsPredicate({ includeShorts: false, accountFilter: "" })}
        AND (s.maturity_date IS NULL OR s.maturity_date >= date('now'))
        ${holdingsFilter}
      )
      SELECT a.name AS account_name, s.symbol, s.name AS security_name,
              s.security_type, s.asset_class, s.sector,
              h.quantity, h.cost_basis * COALESCE(fx.usd_per_unit, 1) AS cost_basis, h.as_of_date,
              lp.close_price AS latest_price,
              CASE WHEN lp.close_price IS NOT NULL
                THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
                ELSE NULL
              END AS market_value,
              CASE WHEN lp.close_price IS NOT NULL AND h.cost_basis IS NOT NULL AND h.cost_basis > 0
                THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} - (h.cost_basis * COALESCE(fx.usd_per_unit, 1))
                ELSE NULL
              END AS unrealized_gain,
              CASE WHEN lp.close_price IS NOT NULL
                THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} * 100.0 / (SELECT total FROM portfolio_total)
                ELSE NULL
              END AS position_weight_pct
       FROM holdings h
       JOIN accounts a ON a.id = h.account_id
       JOIN securities s ON s.id = h.security_id
       LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE ${latestHoldingsPredicate({ includeShorts: false, accountFilter: "" })}
       AND (s.maturity_date IS NULL OR s.maturity_date >= date('now'))
       ${holdingsFilter}
       ORDER BY market_value DESC`
    )
    .all(...holdingsParams, ...holdingsParams) as EnrichedHolding[];

  if (holdings.length > 0) {
    lines.push("\n### Current Holdings (verified positions with quantity > 0)");
    for (const h of holdings) {
      const unit = h.security_type?.toLowerCase() === "bond" ? "face" : h.security_type?.toLowerCase() === "option" ? "contracts" : "shares";
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
          ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} AS mv
        FROM holdings h
        JOIN securities s ON s.id = h.security_id
        LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
        LEFT JOIN fx_rates fx ON fx.currency = s.currency
        WHERE lp.close_price IS NOT NULL
          AND ${latestHoldingsPredicate({ includeShorts: false, accountFilter: "" })}
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
          ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} AS mv
        FROM holdings h
        JOIN securities s ON s.id = h.security_id
        LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
        LEFT JOIN fx_rates fx ON fx.currency = s.currency
        WHERE lp.close_price IS NOT NULL
          AND ${latestHoldingsPredicate({ includeShorts: false, accountFilter: "" })}
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
  // tax_lots.cost_basis is the v2 TRUE-DOLLAR total for the lot's original
  // quantity_acquired (bond ÷100, option ×multiplier, fees included); the
  // still-open share is dollar-proportional (see cost-basis-reconciliation.ts).
  //
  // Pending-statement lots (positions closed per live data, awaiting the
  // broker statement — lib/queries/pending-statement.ts) are NOT open
  // holdings: grouped per pair so the shared read model can split them out
  // into their own disclosed line, never re-derived here.
  const pendingKeys = pendingStatementKeySet(db, accountId != null ? [accountId] : undefined);
  const taxLotGroups = db
    .prepare(
      `SELECT
        tax_lots.account_id, tax_lots.security_id, tax_lots.is_short,
        COUNT(*) AS open_lots,
        COALESCE(SUM(tax_lots.cost_basis * tax_lots.quantity_remaining / tax_lots.quantity_acquired * COALESCE(fx.usd_per_unit, 1)), 0) AS total_cost_basis
       FROM tax_lots
       JOIN securities s ON s.id = tax_lots.security_id
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE quantity_remaining > 0
         AND quantity_acquired != 0
         AND NOT (${CURRENCY_CONVERSION_SECURITY_SQL})
         AND ${liveOptionExpirationSql("s", today)}
         ${taxLotsAccountFilter}
       GROUP BY tax_lots.account_id, tax_lots.security_id, tax_lots.is_short`
    )
    .all(...taxLotsAccountParams) as Array<{
    account_id: number;
    security_id: number;
    is_short: number;
    open_lots: number;
    total_cost_basis: number;
  }>;
  const taxSummary = { open_lots: 0, total_cost_basis: 0 };
  const pendingSummary = { positions: new Set<string>(), lots: 0, cost_basis: 0 };
  for (const g of taxLotGroups) {
    if (isPendingStatementLot(pendingKeys, g)) {
      pendingSummary.positions.add(pendingStatementKey(g));
      pendingSummary.lots += g.open_lots;
      pendingSummary.cost_basis += g.total_cost_basis;
    } else {
      taxSummary.open_lots += g.open_lots;
      taxSummary.total_cost_basis += g.total_cost_basis;
    }
  }

  const realizedGainsJoin = `JOIN tax_lots ON tax_lots.id = tax_lot_sales.tax_lot_id
       JOIN securities s ON s.id = tax_lots.security_id
       WHERE NOT (${CURRENCY_CONVERSION_SECURITY_SQL})
       ${accountId != null ? "AND tax_lots.account_id = ?" : ""}`;
  const realizedGainsParams = accountId != null ? [accountId] : [];
  const realizedGains = db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN ${USD_ONLY} THEN realized_gain_loss ELSE 0 END), 0) AS total,
        COALESCE(SUM(CASE WHEN ${USD_ONLY} AND is_long_term = 1 THEN realized_gain_loss ELSE 0 END), 0) AS long_term,
        COALESCE(SUM(CASE WHEN ${USD_ONLY} AND is_long_term = 0 THEN realized_gain_loss ELSE 0 END), 0) AS short_term,
        COALESCE(SUM(CASE WHEN NOT (${USD_ONLY}) THEN 1 ELSE 0 END), 0) AS excludedNonUsdSales
       FROM tax_lot_sales ${realizedGainsJoin}`
    )
    .get(...realizedGainsParams) as {
    total: number;
    long_term: number;
    short_term: number;
    excludedNonUsdSales: number;
  };

  if (
    taxSummary.open_lots > 0 ||
    realizedGains.total !== 0 ||
    realizedGains.excludedNonUsdSales > 0 ||
    pendingSummary.lots > 0
  ) {
    lines.push("\n### Tax Summary");
    lines.push(`- Open lots: ${taxSummary.open_lots} (cost basis: ${formatUSD(taxSummary.total_cost_basis)})`);
    if (pendingSummary.lots > 0) {
      lines.push(
        `- Positions closed per live data, awaiting broker statement: ${pendingSummary.positions.size} (${pendingSummary.lots} lot${pendingSummary.lots === 1 ? "" : "s"}, cost basis: ${formatUSD(pendingSummary.cost_basis)}) — not counted as open holdings or unrealized; realized gain unknown until the statement is imported`
      );
    }
    // Realized G/L is stored native per security, so only USD rows sum into
    // the dollar figures — same predicate and disclosure as the Tax Lots tiles.
    const nonUsdNote =
      realizedGains.excludedNonUsdSales > 0
        ? ` — USD totals exclude ${realizedGains.excludedNonUsdSales} non-USD sale${realizedGains.excludedNonUsdSales !== 1 ? "s" : ""} (native-currency figures)`
        : "";
    lines.push(`- Realized gains: ${formatUSD(realizedGains.total)} (LT: ${formatUSD(realizedGains.long_term)}, ST: ${formatUSD(realizedGains.short_term)})${nonUsdNote}`);
    if (conventionPending) {
      lines.push(CONVENTION_PENDING_NOTE);
    }
  }

  // Tax-loss harvesting candidates (positions with unrealized losses)
  const harvestCandidates = (db
    .prepare(
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT
        tl.account_id, tl.security_id, tl.is_short,
        s.symbol,
        a.name AS account_name,
        (${adjustedMarketValueSQL("tl.quantity_remaining", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
         - ${adjustedMarketValueSQL("tl.quantity_remaining", "tl.acquisition_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}) AS unrealized_loss,
        tl.cost_basis * COALESCE(fx.usd_per_unit, 1) AS cost_basis,
        CAST(julianday(?) - julianday(tl.acquisition_date) AS INTEGER) AS days_held
      FROM tax_lots tl
      JOIN accounts a ON a.id = tl.account_id
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = tl.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      WHERE tl.quantity_remaining > 0
        AND NOT (${CURRENCY_CONVERSION_SECURITY_SQL})
        AND ${liveOptionExpirationSql("s", today)}
        AND lp.close_price IS NOT NULL
        AND (${adjustedMarketValueSQL("tl.quantity_remaining", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
             - ${adjustedMarketValueSQL("tl.quantity_remaining", "tl.acquisition_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}) < -100
        ${taxLotsFilter}
      ORDER BY unrealized_loss ASC`
    )
    .all(today, ...taxLotsParams) as Array<HarvestCandidate & PairKeyed>)
    // A pending-statement lot is not held — nothing to harvest. LIMIT after
    // the exclusion so a pending lot never crowds out a real candidate.
    .filter((c) => !isPendingStatementLot(pendingKeys, c))
    .slice(0, 5);

  if (harvestCandidates.length > 0) {
    lines.push("\n### Tax-Loss Harvesting Candidates (from CURRENT open tax lots only)");
    for (const c of harvestCandidates) {
      lines.push(
        `- ${c.symbol} (${c.account_name}): ${formatUSD(c.unrealized_loss)} unrealized loss, held ${c.days_held} days`
      );
    }
  }

  // Lots approaching long-term threshold (within 60 days). The long-term
  // date is the engine's calendar-anniversary rule (shared SQL, pinned to
  // isLongTermHolding), never a fixed day count.
  const LONG_TERM_DATE = longTermDateSql("tl.acquisition_date");
  const approachingLT = (db
    .prepare(
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT
        tl.account_id, tl.security_id, tl.is_short,
        s.symbol,
        a.name AS account_name,
        tl.acquisition_date,
        ${LONG_TERM_DATE} AS long_term_date,
        CAST(julianday(${LONG_TERM_DATE}) - julianday(?) AS INTEGER) AS days_remaining,
        CASE WHEN lp.close_price IS NOT NULL
          THEN ${adjustedMarketValueSQL("tl.quantity_remaining", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
               - ${adjustedMarketValueSQL("tl.quantity_remaining", "tl.acquisition_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
          ELSE NULL END AS unrealized_gain
      FROM tax_lots tl
      JOIN accounts a ON a.id = tl.account_id
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN latest_prices lp ON lp.security_id = tl.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      WHERE tl.quantity_remaining > 0
        AND NOT (${CURRENCY_CONVERSION_SECURITY_SQL})
        AND ${liveOptionExpirationSql("s", today)}
        AND julianday(${LONG_TERM_DATE}) > julianday(?)
        AND julianday(${LONG_TERM_DATE}) - julianday(?) <= 60
        ${taxLotsFilter}
      ORDER BY days_remaining ASC`
    )
    .all(today, today, today, ...taxLotsParams) as Array<ApproachingLongTerm & PairKeyed>)
    .filter((lot) => !isPendingStatementLot(pendingKeys, lot))
    .slice(0, 10);

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
    lines.push("\n### Recent Transactions (historical activity — NOT current positions)");
    lines.push("These transactions show what has happened. A security listed here may have been bought AND subsequently sold.");
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
    // Whole calendar days from the price date to the ET day (both parsed as
    // UTC midnights, so this is pure date arithmetic).
    const priceAge = Math.round(
      (Date.parse(today + "T00:00:00Z") - Date.parse(latestPriceDate.max_date + "T00:00:00Z")) /
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
