import type Database from "better-sqlite3";
import { easternDaySql, unmaturedSecuritySql } from "@/lib/db/eastern-day-sql";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { SECTOR_OWN_BUCKET_SQL } from "@/lib/queries/analysis";
import { normalizeSector } from "@/lib/securities/normalize-sector";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { marketCapCategoryBucketSql } from "@/lib/securities/normalize-market-cap";
import { isPendingStatementLot, pendingStatementKeySet } from "@/lib/queries/pending-statement";
import { isOptionLive, liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import { isCurrencyConversionSecurityType, lotSideSignSql, remainingLotBasisSql } from "@/lib/queries/tax-lots";
import { isLongTermSql, longTermDateSql } from "@/lib/queries/long-term-sql";

/**
 * Chat sector-FILTER-only alias, on top of normalizeSector. normalizeSector
 * deliberately demotes "Financial" (returns null — see normalize-sector.ts's
 * DEMOTED comment) because tagging a SECURITY's `sector` column "Financial"
 * is genuinely ambiguous (could be Real Estate). That risk is a WRITE-side
 * concern; a chat model asking to FILTER holdings by "Financial" carries no
 * such risk (worst case zero/extra rows, never a corrupted tag), so this
 * query-only alias fills the gap normalizeSector leaves on purpose. Mirrors
 * the fund_category-local alias in lib/queries/data-health.ts. Never promote
 * this into the global ALIASES.
 */
const CHAT_SECTOR_FILTER_ALIASES: Record<string, string> = {
  financial: "Financials",
};

/**
 * Normalize an incoming chat sector filter to the canonical GICS-11
 * spelling. A model may still say "Financial" or "Health Care" (Bloomberg
 * spellings, pre-dating the sector-tag-verification sweep) even though
 * `securities.sector` is now pure GICS-11 — normalize so those still match.
 * Falls back to the raw value for open-vocabulary terms neither map
 * recognizes (e.g. "Diversified").
 */
function normalizeSectorFilter(raw: string): string {
  const alias = CHAT_SECTOR_FILTER_ALIASES[raw.trim().toLowerCase()];
  if (alias) return alias;
  return normalizeSector(raw) ?? raw;
}

// ─── Filter types ─────────────────────────────────────────────────

export interface HoldingsFilters {
  account_name?: string;
  symbol?: string;
  security_type?: string;
  sector?: string;
  sort_by?: "market_value" | "unrealized_gain" | "position_weight" | "symbol";
  limit?: number;
  /**
   * Opt-in shorts inclusion (default false: a bare call stays on the
   * long-book predicate and long-book denominator). The query_holdings chat
   * tool, lib/chat/ibkr-context.ts and the market-snapshot universe all pass
   * `true` — a short is a holding, and none of them can report one from a
   * `> 0` row set. Rows then carry SIGNED quantity / market_value (negative =
   * short). See the position_weight_pct comment below for the gross-exposure
   * convention this flips on.
   */
  includeShorts?: boolean;
}

export interface TaxLotFilters {
  status?: "open" | "closed" | "all";
  symbol?: string;
  account_name?: string;
  year?: number;
  sort_by?: "unrealized_gain" | "acquisition_date" | "holding_period_days" | "cost_basis";
  limit?: number;
}

export interface TransactionFilters {
  account_name?: string;
  symbol?: string;
  type?: string;
  start_date?: string;
  end_date?: string;
  limit?: number;
}

export interface PerformanceFilters {
  account_name?: string;
  start_date?: string;
  end_date?: string;
}

export interface IncomeSummaryFilters {
  period?: "ytd" | "trailing_12m" | "last_year" | "all_time";
  group_by?: "symbol" | "account" | "month" | "type";
  account_name?: string;
}

// ─── Result types ─────────────────────────────────────────────────

export interface HoldingResult {
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
  unrealized_gain_pct: number | null;
  position_weight_pct: number | null;
  maturity_date: string | null;
  maturity_note: string | null;
}

export interface PriceHistoryResult {
  date: string;
  close_price: number;
  source: string;
}

export interface AllocationResult {
  group_name: string;
  total_market_value: number;
  percentage: number;
  position_count: number;
}

export interface TaxLotResult {
  account_name: string;
  symbol: string;
  security_name: string | null;
  security_type?: string | null;
  expiration_date?: string | null;
  acquisition_date: string;
  acquisition_price: number;
  quantity_remaining: number;
  /**
   * Open lots: the basis of the quantity STILL OPEN (fees included), the
   * figure `unrealized_gain` is measured against, so it pairs with
   * `current_value`. Closed rows: the basis allocated to the quantity sold.
   */
  cost_basis: number;
  /**
   * Open lots only: the basis of the WHOLE lot as acquired. Equal to
   * `cost_basis` unless part of the lot has been closed. Never subtract it
   * from `current_value`.
   */
  original_lot_cost_basis?: number;
  current_price: number | null;
  current_value: number | null;
  unrealized_gain: number | null;
  days_held: number;
  is_long_term: boolean;
  long_term_date: string | null;
  /**
   * Open lots only: "short" for a short lot, "long" otherwise (the same words
   * the holdings tool uses). The raw `is_short` join key is never returned
   * (tests/queries/chat-pending-statement.test.ts). `quantity_remaining`, `cost_basis`
   * (the net opening proceeds of the quantity still open) and `current_value` (what covering would cost) stay
   * positive; `unrealized_gain` is signed by side (a short gains when the
   * price falls). A short lot is never long-term: `is_long_term` is false and
   * `long_term_date` is null, because the engine books every short close as
   * short-term however long the short was open. `status_note` says so in words.
   */
  position_side?: "long" | "short";
  /**
   * Open lots only: the lot belongs to a position closed per LIVE broker data
   * whose closing trade awaits the broker statement
   * (lib/queries/pending-statement.ts). Not a current holding: no
   * unrealized gain / market value, and `status_note` says so in words.
   */
  pending_statement?: boolean;
  status_note?: string;
  // Only for closed lots:
  sale_date?: string;
  sale_price?: number;
  proceeds?: number;
  realized_gain_loss?: number;
  holding_period_days?: number;
}

export interface TransactionResult {
  trade_date: string;
  type: string;
  symbol: string | null;
  security_name: string | null;
  account_name: string;
  quantity: number | null;
  price_per_share: number | null;
  amount: number | null;
  fees: number;
}

export interface PerformanceResult {
  month_end_date: string;
  account_name: string;
  total_value: number;
  monthly_change: number | null;
  deposits_withdrawals: number | null;
  investment_change: number | null;
  dividends: number | null;
  interest: number | null;
  fees: number | null;
  twr: number | null;
}

export interface IncomeResult {
  group_name: string;
  total_dividends: number;
  total_interest: number;
  total_fees: number;
  net_income: number;
}

// ─── Query functions ──────────────────────────────────────────────

/**
 * Query current holdings with cost basis, market value, unrealized gain,
 * and position weight. Handles bonds and options correctly.
 */
export function getHoldingsForChat(
  db: Database.Database,
  filters: HoldingsFilters = {}
): HoldingResult[] {
  const {
    account_name,
    symbol,
    security_type,
    sector,
    sort_by = "market_value",
    limit = 50,
    includeShorts = false,
  } = filters;

  // The denominator for position_weight_pct. Long-only (default): a plain
  // signed SUM is correct because every included row's market value is
  // already positive (quantity > 0). Shorts-included: a short's market value
  // is negative, so a signed SUM would net shorts AGAINST longs rather than
  // sizing the book — this must be a GROSS (ABS) exposure denominator, paired
  // with a GROSS numerator below, or short weights would come out negative.
  const denominatorMvExpr = adjustedMarketValueSQL(
    "h.quantity",
    "lp.close_price",
    "s.security_type",
    "s.multiplier",
    "COALESCE(fx.usd_per_unit, 1)"
  );
  const grossDenominatorMvExpr = includeShorts ? `ABS(${denominatorMvExpr})` : denominatorMvExpr;

  // An option past its expiration day (ET) is not a holding. The purge keeps
  // the row one grace day, so the read applies the shared cutoff itself
  // (also normalizes legacy YYYYMMDD expirations).
  const liveOptionSql = liveOptionExpirationSql("s", todayET());

  // First compute total portfolio value for position weights
  const totalRow = db
    .prepare(
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT COALESCE(SUM(
        CASE WHEN lp.close_price IS NOT NULL
          THEN ${grossDenominatorMvExpr}
          ELSE 0 END
      ), 0) AS total
      FROM holdings h
      JOIN securities s ON s.id = h.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
      WHERE ${latestHoldingsPredicate({ includeShorts })}
      AND ${unmaturedSecuritySql("s")}
      AND ${liveOptionSql}`
    )
    .get() as { total: number };

  const totalPortfolioValue = totalRow.total || 1; // avoid division by zero

  // Build filtered query
  const conditions: string[] = [
    latestHoldingsPredicate({ includeShorts }),
    unmaturedSecuritySql("s"),
    liveOptionSql,
  ];
  const params: (string | number)[] = [];

  if (account_name) {
    conditions.push("a.name = ?");
    params.push(account_name);
  }
  if (symbol) {
    conditions.push("s.symbol = ?");
    params.push(symbol);
  }
  if (security_type) {
    conditions.push("s.security_type = ?");
    params.push(security_type);
  }
  if (sector) {
    conditions.push("s.sector = ?");
    params.push(normalizeSectorFilter(sector));
  }

  // Ranked by the expression itself: selecting it as a column leaked an
  // internal sort key into every returned row and the tool JSON. The account
  // name completes the tie-break, so two accounts holding the same symbol at
  // the same exposure always come back in the same order.
  const grossExposureSort = `CASE WHEN lp.close_price IS NOT NULL
        THEN ABS(${denominatorMvExpr})
        ELSE 0 END DESC, s.symbol ASC, a.name ASC`;
  const sortMap: Record<string, string> = {
    market_value: includeShorts ? grossExposureSort : "market_value DESC",
    unrealized_gain: "unrealized_gain DESC",
    position_weight: includeShorts ? grossExposureSort : "market_value DESC",
    symbol: "s.symbol ASC",
  };

  const sql = `
    WITH latest_prices AS (
      SELECT p.security_id, p.close_price
      FROM prices p
      INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
      ON p.security_id = lp.security_id AND p.date = lp.max_date
    )
    SELECT
      a.name AS account_name,
      s.symbol,
      s.name AS security_name,
      s.security_type,
      s.asset_class,
      s.sector,
      h.quantity,
      h.cost_basis * COALESCE(fx.usd_per_unit, 1) AS cost_basis,
      lp.close_price AS latest_price,
      CASE WHEN lp.close_price IS NOT NULL
        THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
        ELSE NULL END AS market_value,
      CASE WHEN lp.close_price IS NOT NULL AND h.cost_basis IS NOT NULL AND h.cost_basis > 0
        THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} - (h.cost_basis * COALESCE(fx.usd_per_unit, 1))
        ELSE NULL END AS unrealized_gain,
      CASE WHEN lp.close_price IS NOT NULL AND h.cost_basis IS NOT NULL AND h.cost_basis > 0
        THEN (${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} - (h.cost_basis * COALESCE(fx.usd_per_unit, 1))) * 100.0 / (h.cost_basis * COALESCE(fx.usd_per_unit, 1))
        ELSE NULL END AS unrealized_gain_pct,
      -- Gross-exposure convention: when includeShorts is true, both this
      -- numerator and the denominator above (totalPortfolioValue) are ABS(mv)
      -- — a short's market value is negative, so a signed numerator over a
      -- gross denominator would produce a negative weight. Wrapping both in
      -- ABS() makes every weight positive and the set sum to 100%.
      CASE WHEN lp.close_price IS NOT NULL
        THEN ${grossDenominatorMvExpr} * 100.0 / ${totalPortfolioValue}
        ELSE NULL END AS position_weight_pct,
      s.maturity_date,
      -- Whole calendar days from the Eastern day to the maturity day (0 on
      -- the maturity day itself). Never julianday('now'): that is a UTC
      -- instant, which rolled to the next day at 20:00 Eastern and, as a
      -- fraction, printed one day short all day.
      CASE WHEN s.maturity_date IS NOT NULL
        AND julianday(s.maturity_date) - julianday(${easternDaySql()}) BETWEEN 0 AND 90
        THEN CASE CAST(julianday(s.maturity_date) - julianday(${easternDaySql()}) AS INTEGER)
          WHEN 0 THEN 'Matures today'
          WHEN 1 THEN 'Matures in 1 day'
          ELSE 'Matures in ' || CAST(julianday(s.maturity_date) - julianday(${easternDaySql()}) AS INTEGER) || ' days'
        END
        ELSE NULL END AS maturity_note
    FROM holdings h
    JOIN accounts a ON a.id = h.account_id
    JOIN securities s ON s.id = h.security_id
    LEFT JOIN fx_rates fx ON fx.currency = s.currency
    LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY ${sortMap[sort_by] ?? "market_value DESC"}
    LIMIT ?`;

  params.push(limit);

  return db.prepare(sql).all(...params) as HoldingResult[];
}

/**
 * Get historical price data for a security.
 */
export function getPriceHistory(
  db: Database.Database,
  symbol: string,
  startDate?: string,
  endDate?: string
): PriceHistoryResult[] {
  const conditions: string[] = ["s.symbol = ?"];
  const params: (string | number)[] = [symbol];

  // Default to last 90 days if no start date specified
  const effectiveStart = startDate ?? addDays(todayET(), -90);
  conditions.push("p.date >= ?");
  params.push(effectiveStart);

  if (endDate) {
    conditions.push("p.date <= ?");
    params.push(endDate);
  }

  return db
    .prepare(
      `SELECT p.date, p.close_price, p.source
       FROM prices p
       JOIN securities s ON s.id = p.security_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.date ASC`
    )
    .all(...params) as PriceHistoryResult[];
}

/**
 * Compute portfolio allocation breakdown by a grouping dimension.
 */
// Factor columns that require security_factors JOIN
const FACTOR_DIM_SET = new Set([
  "interest_rate_sensitive", "growth_vs_value", "cyclical",
  "international_exposure", "geopolitical_onshoring", "tariff_exposure",
  "ai_exposure", "crypto_adjacent", "regulatory_risk",
]);

export function getAllocationBreakdown(
  db: Database.Database,
  groupBy: string,
  accountName?: string
): AllocationResult[] {
  const standardColumns: Record<string, string> = {
    asset_class: "COALESCE(s.asset_class, 'Unknown')",
    security_type: "COALESCE(s.security_type, 'Unknown')",
    sector: SECTOR_OWN_BUCKET_SQL,
    account: "a.name",
    symbol: "s.symbol",
    fund_category: "COALESCE(s.fund_category, 'Unclassified')",
    geography: "COALESCE(s.geography, 'Unknown')",
    // NULLIF(...,'null') guards rows where an AI classify pass stored the
    // literal string "null"; marketCapCategoryBucketSql is the SQL twin of
    // normalizeMarketCapCategory, folding legacy bare "Large"/"Mid"/"Small"
    // labels into the canonical "X Cap" scheme so this tool doesn't answer
    // with "Large" as a bucket separate from "Large Cap" — same idiom as
    // CLASSIFICATION_BUCKET_COLUMNS in lib/queries/analysis.ts.
    market_cap_category: `COALESCE(NULLIF(${marketCapCategoryBucketSql("s.market_cap_category")}, 'null'), 'Unknown')`,
    style: "COALESCE(s.style, 'Unknown')",
  };

  const isFactorDim = FACTOR_DIM_SET.has(groupBy);
  const groupExpr = isFactorDim
    ? `COALESCE(sf.${groupBy}, sf_u.${groupBy}, 'Unknown')`
    : standardColumns[groupBy] ?? "COALESCE(s.security_type, 'Unknown')";

  const factorJoins = isFactorDim
    ? `LEFT JOIN security_factors sf ON sf.security_id = s.id
       LEFT JOIN securities s_u ON s_u.symbol = s.underlying_symbol
       LEFT JOIN security_factors sf_u ON sf_u.security_id = s_u.id`
    : "";

  const conditions: string[] = [
    latestHoldingsPredicate({ includeShorts: false }),
    unmaturedSecuritySql("s"),
  ];
  const params: (string | number)[] = [];

  if (accountName) {
    conditions.push("a.name = ?");
    params.push(accountName);
  }

  return db
    .prepare(
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      ),
      allocation AS (
        SELECT
          ${groupExpr} AS group_name,
          CASE
            WHEN lp.close_price IS NOT NULL
              THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
            WHEN h.cost_basis IS NOT NULL AND h.cost_basis > 0
              THEN h.cost_basis * COALESCE(fx.usd_per_unit, 1)
            ELSE 0
          END AS mv,
          1 AS cnt
        FROM holdings h
        JOIN accounts a ON a.id = h.account_id
        JOIN securities s ON s.id = h.security_id
        LEFT JOIN fx_rates fx ON fx.currency = s.currency
        LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
        ${factorJoins}
        WHERE ${conditions.join(" AND ")}
      )
      SELECT
        group_name,
        SUM(mv) AS total_market_value,
        SUM(mv) * 100.0 / NULLIF(SUM(SUM(mv)) OVER (), 0) AS percentage,
        SUM(cnt) AS position_count
      FROM allocation
      GROUP BY group_name
      ORDER BY total_market_value DESC`
    )
    .all(...params) as AllocationResult[];
}

/**
 * Query tax lots for open/closed positions with detailed gain/loss info.
 *
 * status "open" returns open lots, "closed" returns closed sales, and "all"
 * returns BOTH (open lots first, then closed sales). `year` filters the closed
 * sales only. `limit` applies to each query separately, so "all" can return up
 * to `limit` open lots plus up to `limit` closed sales.
 */
export function getTaxLotsForChat(
  db: Database.Database,
  filters: TaxLotFilters = {}
): TaxLotResult[] {
  const { status = "open", symbol, account_name, year, sort_by = "unrealized_gain", limit = 50 } = filters;

  const today = todayET();

  const queryClosedSales = (): TaxLotResult[] => {
    // Closed sales
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (symbol) {
      conditions.push("s.symbol = ?");
      params.push(symbol);
    }
    if (account_name) {
      conditions.push("a.name = ?");
      params.push(account_name);
    }
    if (year) {
      conditions.push("tls.sale_date >= ? AND tls.sale_date <= ?");
      params.push(`${year}-01-01`, `${year}-12-31`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const closedSql = `
      SELECT
        a.name AS account_name,
        s.symbol,
        s.name AS security_name,
        s.security_type,
        s.expiration_date,
        tl.acquisition_date,
        tl.acquisition_price,
        tls.quantity_sold AS quantity_remaining,
        tls.cost_basis_allocated AS cost_basis,
        NULL AS current_price,
        NULL AS current_value,
        NULL AS unrealized_gain,
        tls.holding_period_days AS days_held,
        tls.is_long_term,
        NULL AS long_term_date,
        tls.sale_date,
        tls.sale_price,
        tls.proceeds,
        tls.realized_gain_loss,
        tls.holding_period_days
      FROM tax_lot_sales tls
      JOIN tax_lots tl ON tl.id = tls.tax_lot_id
      JOIN accounts a ON a.id = tl.account_id
      JOIN securities s ON s.id = tl.security_id
      ${whereClause}
      ORDER BY tls.realized_gain_loss ASC
      LIMIT ?`;

    params.push(limit);
    const rows = db.prepare(closedSql).all(...params) as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      ...r,
      is_long_term: Boolean(r.is_long_term),
      status_note: taxLotStatusNote(r, today),
    })) as TaxLotResult[];
  };

  const queryOpenLots = (): TaxLotResult[] => {
  // Open lots
  const conditions: string[] = ["tl.quantity_remaining > 0"];
  const params: (string | number)[] = [];

  if (symbol) {
    conditions.push("s.symbol = ?");
    params.push(symbol);
  }
  if (account_name) {
    conditions.push("a.name = ?");
    params.push(account_name);
  }

  const sortMap: Record<string, string> = {
    unrealized_gain: "unrealized_gain ASC", // losses first (most useful for harvesting)
    acquisition_date: "tl.acquisition_date ASC",
    holding_period_days: "days_held DESC",
    cost_basis: "cost_basis DESC",
  };

  const openSql = `
    WITH latest_prices AS (
      SELECT p.security_id, p.close_price
      FROM prices p
      INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
      ON p.security_id = lp.security_id AND p.date = lp.max_date
    )
    SELECT
      tl.account_id, tl.security_id, tl.is_short,
      a.name AS account_name,
      s.symbol,
      s.name AS security_name,
      s.security_type,
      s.expiration_date,
      tl.acquisition_date,
      tl.acquisition_price,
      tl.quantity_remaining,
      -- cost_basis is the basis of the quantity STILL OPEN (the page's
      -- fee-inclusive remaining basis, the one the gain below uses), so it
      -- sits beside current_value on the same quantity. The whole lot's
      -- figure is kept under its own name.
      ${remainingLotBasisSql()} AS cost_basis,
      tl.cost_basis * COALESCE(fx.usd_per_unit, 1) AS original_lot_cost_basis,
      lp.close_price AS current_price,
      CASE WHEN lp.close_price IS NOT NULL
        THEN ${adjustedMarketValueSQL("tl.quantity_remaining", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
        ELSE NULL END AS current_value,
      -- Signed by side (the shared fragment the Tax Lots reads use): a short
      -- lot stores a positive quantity_remaining and gains when the price
      -- FALLS, so its figure is the opening value minus the current value.
      -- Measured against the SAME remaining basis as the Tax Lots page
      -- (fees included), never quantity x acquisition_price.
      CASE WHEN lp.close_price IS NOT NULL
        THEN ${lotSideSignSql("tl")} * (${adjustedMarketValueSQL("tl.quantity_remaining", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
             - ${remainingLotBasisSql()})
        ELSE NULL END AS unrealized_gain,
      CAST(julianday(?) - julianday(tl.acquisition_date) AS INTEGER) AS days_held,
      -- Calendar-anniversary rule (IRS Pub 550, single-sourced at
      -- lib/compute/tax-lots.ts::isLongTermHolding): LT iff the disposition
      -- date is strictly AFTER the one-year anniversary of acquisition, not
      -- a fixed 365/366-day count. Never let this SQL diverge from that
      -- function's definition. The anniversary is the SAME month-day one
      -- year on, built as a string like that function does: SQLite's
      -- date(x, '+1 year') rolls Feb 29 forward to Mar 1, which made a
      -- Feb-29 lot long-term one day late (Mar 2 instead of Mar 1).
      -- Long lots only: the engine books every short close as short-term
      -- however long the short was open (computeTaxLots), so a short lot is
      -- never long-term and has no date on which it becomes so.
      CASE WHEN tl.is_short = 1 THEN 0 ELSE ${isLongTermSql("tl.acquisition_date")} END AS is_long_term,
      CASE WHEN tl.is_short = 1 THEN NULL ELSE ${longTermDateSql("tl.acquisition_date")} END AS long_term_date
    FROM tax_lots tl
    JOIN accounts a ON a.id = tl.account_id
    JOIN securities s ON s.id = tl.security_id
    LEFT JOIN fx_rates fx ON fx.currency = s.currency
    LEFT JOIN latest_prices lp ON lp.security_id = tl.security_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY ${sortMap[sort_by] ?? "unrealized_gain ASC"}
    LIMIT ?`;

  // today params go first (julianday(?) in SELECT), then WHERE params, then LIMIT
  const allParams = [today, today, ...params, limit];
  const rows = db.prepare(openSql).all(...allParams) as Array<
    Record<string, unknown> & { account_id: number; security_id: number; is_short: number }
  >;

  // Pending statement (shared read model, never re-derived here): the
  // position is closed per live data, so the lot is described as pending —
  // not as an unrealized holding.
  const pendingKeys = pendingStatementKeySet(db);
  return rows.map(({ account_id, security_id, is_short, ...r }) => {
    const pending = isPendingStatementLot(pendingKeys, { account_id, security_id, is_short });
    const baseNote = taxLotStatusNote(r, today);
    // A short lot says so in words as well as in the flag, so the model never
    // suggests "selling" it or waiting for long-term treatment.
    const short = is_short === 1;
    const statusNote = short ? (baseNote ? `${SHORT_LOT_CHAT_NOTE} ${baseNote}` : SHORT_LOT_CHAT_NOTE) : baseNote;
    return pending
      ? {
          ...r,
          current_value: null,
          unrealized_gain: null,
          is_long_term: Boolean(r.is_long_term),
          position_side: short ? ("short" as const) : ("long" as const),
          pending_statement: true,
          status_note: statusNote ? `${PENDING_STATEMENT_CHAT_NOTE} ${statusNote}` : PENDING_STATEMENT_CHAT_NOTE,
        }
      : {
          ...r,
          is_long_term: Boolean(r.is_long_term),
          position_side: short ? ("short" as const) : ("long" as const),
          pending_statement: false,
          status_note: statusNote,
        };
  }) as TaxLotResult[];
  };

  if (status === "closed") return queryClosedSales();
  if (status === "all") return [...queryOpenLots(), ...queryClosedSales()];
  return queryOpenLots();
}

/** How chat describes an open short lot (pinned by tests). */
export const SHORT_LOT_CHAT_NOTE =
  "Short position: unrealized_gain is signed for the short side (a gain when the price has fallen). Closing it means buying to cover, and the gain or loss on a short is short-term however long it has been open.";

/** How chat describes a pending-statement lot (pinned by tests). */
export const PENDING_STATEMENT_CHAT_NOTE =
  "Pending statement: this position was closed per live broker data, awaiting the broker statement for the closing trade. It is not an unrealized holding, and its realized gain is unknown until the statement is imported.";

const CURRENCY_CONVERSION_CHAT_NOTE =
  "Currency conversion: this is a Section 988 ordinary-income cash-management lot, not a capital tax lot.";

const EXPIRED_OPTION_CHAT_NOTE =
  "Expired option: this contract is past expiration and is awaiting a real broker closing entry.";

function taxLotStatusNote(row: { security_type?: string | null; expiration_date?: string | null }, today: string): string | undefined {
  if (isCurrencyConversionSecurityType(row.security_type)) return CURRENCY_CONVERSION_CHAT_NOTE;
  if ((row.security_type ?? "").trim().toLowerCase() === "option" && !isOptionLive(row.expiration_date, today)) {
    return EXPIRED_OPTION_CHAT_NOTE;
  }
  return undefined;
}

/**
 * Search transaction history with filters.
 */
export function getTransactionsForChat(
  db: Database.Database,
  filters: TransactionFilters = {}
): TransactionResult[] {
  const { account_name, symbol, type, start_date, end_date, limit = 50 } = filters;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (account_name) {
    conditions.push("a.name = ?");
    params.push(account_name);
  }
  if (symbol) {
    conditions.push("s.symbol = ?");
    params.push(symbol);
  }
  if (type) {
    conditions.push("UPPER(t.type) = UPPER(?)");
    params.push(type);
  }
  if (start_date) {
    conditions.push("t.trade_date >= ?");
    params.push(start_date);
  }
  if (end_date) {
    conditions.push("t.trade_date <= ?");
    params.push(end_date);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return db
    .prepare(
      `SELECT
        t.trade_date,
        t.type,
        s.symbol,
        s.name AS security_name,
        a.name AS account_name,
        t.quantity,
        t.price_per_share,
        t.amount,
        t.fees
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN securities s ON s.id = t.security_id
      ${whereClause}
      ORDER BY t.trade_date DESC
      LIMIT ?`
    )
    .all(...params, limit) as TransactionResult[];
}

/**
 * Get account performance over time from monthly snapshots.
 */
export function getPerformanceForChat(
  db: Database.Database,
  filters: PerformanceFilters = {}
): PerformanceResult[] {
  const { account_name, start_date, end_date } = filters;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (account_name) {
    conditions.push("a.name = ?");
    params.push(account_name);
  }
  if (start_date) {
    conditions.push("ms.month_end_date >= ?");
    params.push(start_date);
  }
  if (end_date) {
    conditions.push("ms.month_end_date <= ?");
    params.push(end_date);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  return db
    .prepare(
      `SELECT
        ms.month_end_date,
        a.name AS account_name,
        ms.total_value,
        ms.total_value - LAG(ms.total_value) OVER (
          PARTITION BY ms.account_id ORDER BY ms.month_end_date
        ) AS monthly_change,
        ms.deposits_withdrawals,
        (ms.total_value - LAG(ms.total_value) OVER (
          PARTITION BY ms.account_id ORDER BY ms.month_end_date
        )) - COALESCE(ms.deposits_withdrawals, 0) AS investment_change,
        ms.dividends,
        ms.interest,
        ms.fees,
        ms.twr
      FROM monthly_snapshots ms
      JOIN accounts a ON a.id = ms.account_id
      ${whereClause}
      ORDER BY ms.month_end_date ASC, a.name`
    )
    .all(...params) as PerformanceResult[];
}

/**
 * Summarize investment income (dividends, interest) and fees over a period.
 */
export function getIncomeSummaryForChat(
  db: Database.Database,
  filters: IncomeSummaryFilters = {}
): IncomeResult[] {
  const { period = "trailing_12m", group_by = "symbol", account_name } = filters;

  // Compute date range from period
  const today = todayET();
  const year = Number(today.slice(0, 4));
  let startDate: string;

  switch (period) {
    case "ytd":
      startDate = `${year}-01-01`;
      break;
    case "trailing_12m": {
      // Same month/day one year back (Feb 29 -> Feb 28), on the ET calendar.
      const md = today.slice(5);
      startDate = `${year - 1}-${md === "02-29" ? "02-28" : md}`;
      break;
    }
    case "last_year":
      startDate = `${year - 1}-01-01`;
      break;
    case "all_time":
      startDate = "1900-01-01";
      break;
  }

  const endDate = period === "last_year" ? `${year - 1}-12-31` : today;

  const groupExpr: Record<string, string> = {
    symbol: "COALESCE(s.symbol, 'CASH')",
    account: "a.name",
    month: "substr(t.trade_date, 1, 7)",
    type: "t.type",
  };

  const expr = groupExpr[group_by] ?? "COALESCE(s.symbol, 'CASH')";

  const incomeConditions = [
    "t.trade_date >= ?",
    "t.trade_date <= ?",
    "UPPER(t.type) IN ('DIVIDEND', 'REINVESTMENT', 'INTEREST', 'FEE', 'COMMISSION')",
  ];
  const incomeParams: (string | number)[] = [startDate, endDate];

  if (account_name) {
    incomeConditions.push("a.name = ?");
    incomeParams.push(account_name);
  }

  return db
    .prepare(
      `SELECT
        ${expr} AS group_name,
        COALESCE(SUM(CASE WHEN UPPER(t.type) IN ('DIVIDEND', 'REINVESTMENT') THEN ABS(t.amount) ELSE 0 END), 0) AS total_dividends,
        COALESCE(SUM(CASE WHEN UPPER(t.type) = 'INTEREST' THEN ABS(t.amount) ELSE 0 END), 0) AS total_interest,
        COALESCE(SUM(CASE WHEN UPPER(t.type) IN ('FEE', 'COMMISSION') THEN ABS(t.amount) ELSE 0 END), 0) AS total_fees,
        COALESCE(SUM(CASE WHEN UPPER(t.type) IN ('DIVIDEND', 'REINVESTMENT', 'INTEREST') THEN ABS(t.amount) ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN UPPER(t.type) IN ('FEE', 'COMMISSION') THEN ABS(t.amount) ELSE 0 END), 0) AS net_income
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN securities s ON s.id = t.security_id
      WHERE ${incomeConditions.join(" AND ")}
      GROUP BY ${expr}
      ORDER BY net_income DESC`
    )
    .all(...incomeParams) as IncomeResult[];
}

// ─── Cash estimation ──────────────────────────────────────────────

export interface CashEstimate {
  account_name: string;
  snapshot_total: number | null;
  snapshot_date: string | null;
  holdings_total: number;
  estimated_cash: number;
}

/**
 * Estimate cash balances per account by subtracting holdings market value
 * from the latest monthly snapshot total. This is an approximation since
 * prices may have changed since the snapshot date.
 *
 * Money-market sweep funds are cash, not holdings — the statement import
 * path writes them as ordinary `holdings` rows, so naively subtracting ALL
 * holdings from the snapshot total double-subtracts cash the user actually
 * holds (it moves the sweep's value from "cash" to "invested"). Excluded
 * here via the single-sourced `isCashEquivalentSecurity` predicate (never a
 * hand-rolled `security_type`/`fund_category` SQL literal — see
 * lib/compute/cash-equivalents.ts). Their value re-enters automatically
 * through estimated_cash's residual (snapshot_total − holdings_total).
 * Mirrors the same fix in lib/compute/daily-valuation.ts.
 */
export function getCashEstimates(db: Database.Database): CashEstimate[] {
  const allSecurities = db
    .prepare(`SELECT id, security_type, fund_category FROM securities`)
    .all() as { id: number; security_type: string | null; fund_category: string | null }[];
  const cashEquivalentIds = allSecurities
    .filter((s) => isCashEquivalentSecurity(s))
    .map((s) => s.id);
  // Integers sourced from our own SELECT above, never user input — safe to
  // splice directly rather than binding a dynamic-length placeholder list.
  const excludeCashEquivSql =
    cashEquivalentIds.length > 0 ? `AND h.security_id NOT IN (${cashEquivalentIds.join(",")})` : "";

  return db
    .prepare(
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT
        a.name AS account_name,
        ms.total_value AS snapshot_total,
        ms.month_end_date AS snapshot_date,
        COALESCE(SUM(
          CASE WHEN lp.close_price IS NOT NULL AND h.quantity > 0 ${excludeCashEquivSql}
            THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
            ELSE 0 END
        ), 0) AS holdings_total,
        COALESCE(ms.total_value, 0) - COALESCE(SUM(
          CASE WHEN lp.close_price IS NOT NULL AND h.quantity > 0 ${excludeCashEquivSql}
            THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
            ELSE 0 END
        ), 0) AS estimated_cash
      FROM accounts a
      LEFT JOIN monthly_snapshots ms ON ms.account_id = a.id
        AND ms.month_end_date = (SELECT MAX(ms2.month_end_date) FROM monthly_snapshots ms2 WHERE ms2.account_id = a.id)
      LEFT JOIN holdings h ON h.account_id = a.id
        -- per-(account, security) latest; inline because latestHoldingsPredicate's quantity clause would defeat the LEFT JOIN (CASE below already guards quantity)
        AND h.as_of_date = (SELECT MAX(h2.as_of_date) FROM holdings h2 WHERE h2.account_id = a.id AND h2.security_id = h.security_id)
      LEFT JOIN securities s ON s.id = h.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
      WHERE ms.total_value IS NOT NULL
      GROUP BY a.id
      ORDER BY a.name`
    )
    .all() as CashEstimate[];
}

// ─── Data freshness helpers ───────────────────────────────────────

export interface DataFreshness {
  latest_price_date: string | null;
  price_age_days: number | null;
  latest_holdings_date: string | null;
  holdings_age_days: number | null;
}

export function getDataFreshness(db: Database.Database): DataFreshness {
  const priceRow = db
    .prepare("SELECT MAX(date) AS latest FROM prices")
    .get() as { latest: string | null };
  const holdingsRow = db
    .prepare("SELECT MAX(as_of_date) AS latest FROM holdings")
    .get() as { latest: string | null };

  const now = Date.now();
  const priceAge = priceRow.latest
    ? Math.floor((now - new Date(priceRow.latest + "T00:00:00Z").getTime()) / 86400000)
    : null;
  const holdingsAge = holdingsRow.latest
    ? Math.floor((now - new Date(holdingsRow.latest + "T00:00:00Z").getTime()) / 86400000)
    : null;

  return {
    latest_price_date: priceRow.latest,
    price_age_days: priceAge,
    latest_holdings_date: holdingsRow.latest,
    holdings_age_days: holdingsAge,
  };
}
