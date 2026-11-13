import type Database from "better-sqlite3";
import { snapshotTwrFraction } from "@/lib/compute/monthly-snapshot-utils";
import { easternDaySql, unmaturedSecuritySql } from "@/lib/db/eastern-day-sql";
import { adjustedMarketValueSQL, scaledCostBasisFallbackSQL } from "@/lib/valuation";
import { todayET, addDays, calendarDaysBetween } from "@/lib/calendar/date-utils";
import { SECTOR_OWN_BUCKET_SQL } from "@/lib/queries/analysis";
import { normalizeSector } from "@/lib/securities/normalize-sector";
import { normalizeFundCategory } from "@/lib/securities/normalize-fund-category";
import { isCashEquivalentSecurity, cashEquivalentSecuritySql } from "@/lib/compute/cash-equivalents";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { marketCapCategoryBucketSql } from "@/lib/securities/normalize-market-cap";
import { getPendingStatementIndex, type PendingStatementIndex } from "@/lib/queries/pending-statement";
import { figureKindForSide, sideOf, type PendingFigureKind, type PendingReason } from "@/lib/queries/pending-statement-types";
import { liveOriginHoldingSql } from "@/lib/db/holding-sources";
import { accountScopeAndSql, accountScopeCondition } from "@/lib/queries/account-scope-sql";
import { transactionAmountCurrencySql, transactionAmountUsdSql } from "@/lib/queries/transaction-amount-currency";
import {
  DIVIDEND_INCOME_SQL,
  FEES_SQL,
  INCOME_PAIRED_JOIN,
  INCOME_TYPES_SQL,
  INTEREST_EARNED_SQL,
  INTEREST_PAID_SQL,
  NET_INCOME_SQL,
  UNPAIRED_NEGATIVE_REINVESTMENT_SQL,
  incomePairingCtes,
} from "@/lib/queries/income-sql";
import { isOptionLive, liveOptionExpirationSql } from "@/lib/compute/option-expiry";
import {
  getClosedTaxLotSales,
  isCurrencyConversionSecurityType,
  isCurrencyConversionTaxLot,
  lotSideSignSql,
  remainingLotBasisSql,
} from "@/lib/queries/tax-lots";
import { isLongTermSql, longTermDateSql } from "@/lib/queries/long-term-sql";
import { computePositionTotals, getHoldingsBySecurity } from "@/lib/queries/security-detail";
import { getPortfolioCurrentValues } from "@/lib/queries/dashboard";

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
  /**
   * Resolved scope ids; wins over account_name. `[]` reads no account.
   * Either one narrows the position_weight_pct denominator to the same
   * accounts (B5); symbol, type and sector filters never do.
   */
  account_ids?: number[];
  /** Return every matching row (no LIMIT); for engines that count positions. */
  noLimit?: boolean;
  /** Only holdings whose price currency is this ISO code (case-insensitive). */
  currency?: string;
  /** Only holdings whose price currency is not USD. */
  non_usd?: boolean;
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
  /** Resolved scope ids; wins over account_name. `[]` reads no account. */
  account_ids?: number[];
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
  /** USD. A short's is its sale proceeds, signed negative like quantity and market_value. */
  cost_basis: number | null;
  /** NATIVE close in `currency`; never converted. market_value and cost_basis are USD. */
  latest_price: number | null;
  /** The security's currency (the unit of latest_price). */
  currency: string;
  /** Date of the `prices` row behind latest_price / market_value (YYYY-MM-DD). */
  price_date: string | null;
  market_value: number | null;
  /** market_value - cost_basis; for a short, the proceeds less the cost to cover (query_tax_lots' figure). */
  unrealized_gain: number | null;
  /** unrealized_gain as a percent of |cost_basis|, signed by the gain. */
  unrealized_gain_pct: number | null;
  position_weight_pct: number | null;
  /** What position_weight_pct is a share of: the filtered accounts' book, or every account's. */
  weight_basis: "account" | "all accounts";
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
  /** The account's tax treatment (`accounts.tax_treatment`). */
  account_tax_treatment?: string | null;
  symbol: string;
  /** The security's currency: the unit of acquisition_price, current_price and every *_native figure. */
  currency?: string;
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
  /** Date of the `prices` row behind current_price / current_value (null on closed sales). */
  price_date: string | null;
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
   * Open lots only: the lot's (account, security, side) is pending in the
   * shared read model (lib/queries/pending-statement.ts), for any reason.
   * Not a current holding: no unrealized gain / market value, and
   * `status_note` says so in words.
   */
  pending_statement?: boolean;
  /**
   * Open lots only: WHY the lot is pending, or null when it is not.
   * `awaiting_statement` = closed per live broker data, the statement with
   * the closing trade is not imported yet; `closing_entry_missing` = the
   * statement shows the position closed but the ledger has no closing
   * trade; `resymbol_repair_pending` = the option was renamed to a new
   * contract after a split and is still held under it.
   */
  pending_statement_reason?: PendingReason | null;
  /**
   * Open lots only: what `cost_basis` is. `cost_basis` for a long lot;
   * `short_sale_proceeds` for a short lot (the opening sale's net proceeds
   * still open: money received, never a cost). Fixed by the side.
   */
  figure_kind?: PendingFigureKind;
  status_note?: string;
  // Only for closed lots (built on getClosedTaxLotSales). `cost_basis`,
  // `proceeds` and `realized_gain_loss` are NATIVE, as stored.
  sale_date?: string;
  sale_price?: number;
  proceeds?: number;
  realized_gain_loss?: number;
  holding_period_days?: number;
  proceeds_native?: number;
  cost_basis_native?: number;
  realized_gain_native?: number;
  /** Converted at TODAY's rate (not the sale date's); null when no rate is on file. */
  proceeds_usd_at_current_fx?: number | null;
  cost_basis_usd_at_current_fx?: number | null;
  realized_gain_usd_at_current_fx?: number | null;
  /** How a non-USD sale was converted, or why it was not. */
  fx_note?: string;
  /** An engine-made RECONCILE_CLOSE, not a recorded broker sale. */
  is_synthetic_close?: boolean;
}

export interface TransactionResult {
  trade_date: string;
  type: string;
  symbol: string | null;
  security_name: string | null;
  account_name: string;
  quantity: number | null;
  /** In `amount_currency`, as stored. */
  price_per_share: number | null;
  /** As stored, in `amount_currency` (signed: negative is cash out). */
  amount: number | null;
  /** In `amount_currency`. */
  fees: number;
  /** The currency `amount`, `price_per_share` and `fees` are stored in (lib/queries/transaction-amount-currency.ts). */
  amount_currency: string;
  /** `amount` in USD at the current rate; equal to `amount` for USD; null when no rate is on file. */
  amount_usd: number | null;
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
  /** Time-weighted return for the month as a FRACTION (0.0521 = 5.21%). */
  twr: number | null;
}

/** Income semantics: lib/queries/income-sql.ts (plan Contract J). */
export interface IncomeResult {
  group_name: string;
  /** Each payout once: signed DIVIDEND amounts plus unpaired reinvestment purchases. */
  total_dividends: number;
  /** Interest EARNED (positive INTEREST rows only). */
  total_interest: number;
  /** Interest CHARGED (e.g. on a margin debit), as a positive magnitude; a cost. */
  interest_paid: number;
  total_fees: number;
  /** total_dividends + total_interest - interest_paid - total_fees. */
  net_income: number;
  /** Unpaired REINVESTMENT rows that reverse a purchase (`reinvestmentIsPurchase`), left out of income. */
  unpaired_reinvestment_count: number;
}

/** 'mutual_fund' / 'Mutual Fund' / ' MUTUAL FUND ' all read as 'mutual fund'. */
function normalizeSecurityTypeToken(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
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
    account_ids,
    symbol,
    security_type,
    sector,
    sort_by = "market_value",
    limit = 50,
    includeShorts = false,
    noLimit = false,
    currency,
    non_usd,
  } = filters;

  // The account filter, shared by the rows and the weight denominator (B5):
  // an account-filtered call's weights are shares of THAT book.
  const accountConditions: string[] = [];
  const accountParams: (string | number)[] = [];
  if (account_ids) {
    const scope = accountScopeCondition(account_ids, "h.account_id");
    if (scope.condition) accountConditions.push(scope.condition);
    accountParams.push(...scope.params);
  } else if (account_name) {
    accountConditions.push("h.account_id IN (SELECT id FROM accounts WHERE name = ?)");
    accountParams.push(account_name);
  }
  // An id list that names every account is the whole book (nit, review R2).
  const coversEveryAccount =
    account_ids !== undefined &&
    account_ids.length > 0 &&
    (db.prepare("SELECT id FROM accounts").all() as { id: number }[]).every((a) => account_ids.includes(a.id));
  const weightBasis: HoldingResult["weight_basis"] =
    accountConditions.length > 0 && !coversEveryAccount ? "account" : "all accounts";

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
      WHERE ${[latestHoldingsPredicate({ includeShorts }), unmaturedSecuritySql("s"), liveOptionSql, ...accountConditions].join("\n      AND ")}`
    )
    .get(...accountParams) as { total: number };

  const totalPortfolioValue = totalRow.total || 1; // avoid division by zero

  // Build filtered query
  const conditions: string[] = [
    latestHoldingsPredicate({ includeShorts }),
    unmaturedSecuritySql("s"),
    liveOptionSql,
    ...accountConditions,
  ];
  const params: (string | number)[] = [...accountParams];

  if (symbol) {
    conditions.push("UPPER(s.symbol) = UPPER(?)");
    params.push(symbol);
  }
  if (security_type) {
    // The tool hands the model lowercase tokens ('option', 'mutual_fund');
    // the table stores 'Option', 'Mutual Fund'. Compare the normalized
    // spellings, and read 'money_market' through the one cash-equivalent
    // predicate: a sweep fund is stored as a Mutual Fund with a cash
    // fund_category, never with a money-market type.
    const token = normalizeSecurityTypeToken(security_type);
    if (token === "money market") {
      conditions.push(cashEquivalentSecuritySql("s"));
    } else {
      conditions.push("LOWER(REPLACE(TRIM(COALESCE(s.security_type, '')), '_', ' ')) = ?");
      params.push(token);
    }
  }
  if (sector) {
    conditions.push("s.sector = ?");
    params.push(normalizeSectorFilter(sector));
  }
  // The PRICE currency (the security's own); like the other filters it never
  // narrows the weight denominator.
  if (currency) {
    conditions.push("UPPER(COALESCE(s.currency, 'USD')) = UPPER(?)");
    params.push(currency);
  }
  if (non_usd) conditions.push("UPPER(COALESCE(s.currency, 'USD')) <> 'USD'");

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

  // Same basis the Accounts page shows: the row's own, else the latest earlier row of the pair, scaled by quantity.
  const storedBasisExpr = scaledCostBasisFallbackSQL("h", "h3");
  // A short's basis is its sale proceeds, stored NEGATIVE by every IBKR
  // source (position x avgCost). A short stored positive is still a short,
  // so its basis is read as minus its magnitude: the rule the cost-basis
  // reconciliation applies (lib/compute/cost-basis-reconciliation.ts). The
  // gain is then market value minus the signed basis, the Accounts page's
  // formula (lib/queries/holdings.ts), which for a short is the proceeds
  // less the cost to cover: the figure query_tax_lots gives the open lot
  // (lotSideSignSql x (value - remainingLotBasisSql)). The percent is over
  // the basis magnitude (unrealizedGainRatio, lib/format.ts). Before this a
  // real short (negative basis) had no gain at all, and one stored positive
  // read market value minus proceeds.
  const costBasisExpr = `(CASE WHEN h.quantity < 0 THEN -ABS(${storedBasisExpr}) ELSE ${storedBasisExpr} END)`;
  const hasGainBasis = `(${storedBasisExpr} IS NOT NULL AND (${storedBasisExpr} > 0 OR (h.quantity < 0 AND ${storedBasisExpr} <> 0)))`;

  const sql = `
    WITH latest_prices AS (
      SELECT p.security_id, p.close_price, lp.max_date
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
      ${costBasisExpr} * COALESCE(fx.usd_per_unit, 1) AS cost_basis,
      lp.close_price AS latest_price,
      COALESCE(s.currency, 'USD') AS currency,
      lp.max_date AS price_date,
      CASE WHEN lp.close_price IS NOT NULL
        THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
        ELSE NULL END AS market_value,
      CASE WHEN lp.close_price IS NOT NULL AND ${hasGainBasis}
        THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} - (${costBasisExpr} * COALESCE(fx.usd_per_unit, 1))
        ELSE NULL END AS unrealized_gain,
      CASE WHEN lp.close_price IS NOT NULL AND ${hasGainBasis}
        THEN (${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} - (${costBasisExpr} * COALESCE(fx.usd_per_unit, 1))) * 100.0 / ABS(${costBasisExpr} * COALESCE(fx.usd_per_unit, 1))
        ELSE NULL END AS unrealized_gain_pct,
      -- Gross-exposure convention: when includeShorts is true, both this
      -- numerator and the denominator above (totalPortfolioValue) are ABS(mv)
      -- — a short's market value is negative, so a signed numerator over a
      -- gross denominator would produce a negative weight. Wrapping both in
      -- ABS() makes every weight positive and the set sum to 100%.
      CASE WHEN lp.close_price IS NOT NULL
        THEN ${grossDenominatorMvExpr} * 100.0 / ${totalPortfolioValue}
        ELSE NULL END AS position_weight_pct,
      '${weightBasis}' AS weight_basis,
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

  // LIMIT -1 is SQLite's "no limit".
  params.push(noLimit ? -1 : limit);

  return db.prepare(sql).all(...params) as HoldingResult[];
}

/**
 * The base for `account_value_weight_pct` in query_holdings (owner ruling B,
 * 2026-11-12): the scope's total account value INCLUDING cash, read from
 * `getPortfolioCurrentValues` (lib/queries/dashboard.ts), the one reader the
 * Portfolio strip and the chat summary use. Never a hand-built total.
 *
 * The value is each account's net value (positions plus cash), so a margin
 * debit (negative cash) lowers it and a short's proceeds sit in its cash.
 * `account_value_usd` is null when unknown: no account in scope has a value
 * on record, or an account in scope holds positions but has no value (the
 * combined figure would leave it out). Zero or negative is returned as is,
 * with a reason; the weight is then null, never 0.
 */
export interface AccountValueBase {
  /** USD; null when unknown. */
  account_value_usd: number | null;
  /** Newest of the accounts' own as-of dates. */
  as_of_date: string | null;
  /** Oldest of the accounts' own as-of dates (differs when accounts were valued on different days). */
  oldest_as_of_date: string | null;
  /** Why account_value_weight_pct is null on every row; null when it is computed. */
  reason: string | null;
}

/** `accountIds`: undefined = every account; `[]` = no account. */
export function getAccountValueBaseForChat(
  db: Database.Database,
  accountIds: number[] | undefined,
): AccountValueBase {
  if (accountIds !== undefined && accountIds.length === 0) {
    return { account_value_usd: null, as_of_date: null, oldest_as_of_date: null, reason: "No account is in scope." };
  }
  const values = getPortfolioCurrentValues(db, accountIds);
  const unvalued = values.accounts.filter((a) => a.currentValue === null);
  // An account with no value counts only if it holds a current position that
  // the holdings rows would show; an empty account changes nothing.
  const holding = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT h.account_id AS id
             FROM holdings h
             JOIN securities s ON s.id = h.security_id
            WHERE ${[latestHoldingsPredicate({ includeShorts: true }), unmaturedSecuritySql("s"), liveOptionExpirationSql("s", todayET())].join(" AND ")}`,
        )
        .all() as { id: number }[]
    ).map((r) => r.id),
  );
  const missing = unvalued.filter((a) => holding.has(a.accountId));
  const valued = values.accounts.some((a) => a.currentValue !== null);
  const dates = { as_of_date: values.latestDate, oldest_as_of_date: values.oldestDate };
  if (!valued || missing.length > 0) {
    const names = missing.map((a) => a.accountName).join(", ");
    return {
      account_value_usd: null,
      ...dates,
      reason: !valued
        ? "No value on record for any account in scope, so no share of account value is given."
        : `No value on record for ${names}, which holds positions; the combined account value is unknown, so no share of account value is given.`,
    };
  }
  return {
    account_value_usd: values.totalValue,
    ...dates,
    reason:
      values.totalValue > 0
        ? null
        : "The account value is zero or negative, so a share of it has no meaning; account_value_weight_pct is null.",
  };
}

/** The base as query_holdings returns it: plus the rows' newest price date and whether the base is older. */
export interface AccountValueBaseForRows extends AccountValueBase {
  /** Newest `price_date` among the rows returned; null when none is priced. */
  newest_price_date: string | null;
  /**
   * True when an account's value in the base (`oldest_as_of_date`) is dated
   * before `newest_price_date`: the base predates the prices, so in an account
   * with no margin the weights can still sum above or below 100. The two
   * dates are reported, never reconciled.
   */
  base_older_than_prices: boolean;
  /** Present only when base_older_than_prices is true. */
  date_note?: string;
}

/** Compare the base's date with the rows' newest price date (review follow-up, 2026-11-12). */
export function withPriceDateCheck(
  base: AccountValueBase,
  priceDates: readonly (string | null)[],
): AccountValueBaseForRows {
  const newest = priceDates.reduce<string | null>((m, d) => (d && (m === null || d > m) ? d : m), null);
  const baseDate = base.oldest_as_of_date;
  const older = baseDate !== null && newest !== null && baseDate < newest;
  return {
    ...base,
    newest_price_date: newest,
    base_older_than_prices: older,
    ...(older
      ? {
          date_note: `The account value is as of ${baseDate} but the positions are priced as of ${newest}, so the weights on account value can sum above or below 100 for that reason alone, not margin.`,
        }
      : {}),
  };
}

/** A position's signed market value as a percent of the account value base; null when either is unusable. */
export function accountValueWeightPct(marketValue: number | null, base: AccountValueBase): number | null {
  const v = base.account_value_usd;
  if (marketValue === null || v === null || !(v > 0)) return null;
  return (marketValue * 100) / v;
}

/** A position closed per LIVE broker data whose closing trade awaits the statement. */
export interface ClosedPerLiveDataResult {
  account_name: string;
  symbol: string;
  /** Date of the pair's last NON-ZERO holdings row (the last day it was seen held). */
  as_of_date: string;
  /** Quantity on that last non-zero row (signed: negative = short). */
  quantity: number;
  /** Date of the live-origin zero row that says it is closed. */
  closed_as_of_date: string;
  /**
   * Newest transaction date in this ACCOUNT's imported ledger, any symbol:
   * where the account's ledger ends. Null when the account has none.
   */
  account_ledger_last_date: string | null;
  pending_statement: true;
  status_note: string;
}

/**
 * For a symbol with no live holdings row: every (account, security) pair of
 * that symbol whose newest holdings row is a LIVE-origin zero (a `:live`
 * reconciler tombstone, a legacy live tombstone, or a live-sync zero row;
 * `liveOriginHoldingSql`), plus every pair whose side the pending read model
 * lists as `awaiting_statement`. Each comes back as its last NON-ZERO row,
 * flagged pending statement.
 *
 * Ruling R3 (plan 2026-10-26), applied to BOTH sources:
 *  - a pair is dropped when any of its sides is pending for another reason
 *    (`closing_entry_missing`: the statement already shows it closed and the
 *    closing trade is missing, so "awaiting the statement" would be false;
 *    `resymbol_repair_pending`: still held under the new contract, never
 *    closed);
 *  - a pair is listed only when its newest row is exactly zero: a pair whose
 *    newest row is non-zero holds the opposite side (a live-flipped pair) and
 *    is never described as closed.
 *
 * A pair whose newest row is statement-grade closure evidence is closed per
 * the statement and is NOT listed. Same account filter as
 * `getHoldingsForChat` (an exact account name; omitted = every account).
 * Read-only; never feeds a total or a weight.
 */
export function getClosedPerLiveDataForChat(
  db: Database.Database,
  filters: { account_name?: string; symbol: string }
): ClosedPerLiveDataResult[] {
  const { account_name, symbol } = filters;

  let accountIds: number[] | undefined;
  if (account_name) {
    accountIds = (
      db.prepare("SELECT id FROM accounts WHERE name = ?").all(account_name) as { id: number }[]
    ).map((r) => r.id);
    if (accountIds.length === 0) return [];
  }
  const accountSql = accountIds ? `AND h.account_id IN (${accountIds.map(() => "?").join(", ")})` : "";

  // One Eastern day for the expiry rule here and in the pending index.
  const today = todayET();
  // Newest row of the pair (per-(account, security) correlated) is a
  // live-origin zero, and no non-zero row shares that date. An option past
  // its expiration is left out (the shared expiry rule,
  // lib/compute/option-expiry.ts): it is expired, awaiting its closing
  // entry, never "awaiting the statement", and this tool excludes expired
  // options. The index merge below cannot reach one (expired beats pending).
  const zeroRows = db
    .prepare(
      `SELECT h.account_id, h.security_id, h.as_of_date AS closed_as_of_date
         FROM holdings h
         JOIN securities s ON s.id = h.security_id
        WHERE UPPER(s.symbol) = UPPER(?)
          AND h.as_of_date = (
            SELECT MAX(h2.as_of_date) FROM holdings h2
             WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
          )
          AND h.quantity = 0
          AND ${liveOriginHoldingSql("h")}
          AND (LOWER(COALESCE(s.security_type, '')) != 'option' OR ${liveOptionExpirationSql("s", today)})
          AND NOT EXISTS (
            SELECT 1 FROM holdings hn
             WHERE hn.account_id = h.account_id AND hn.security_id = h.security_id
               AND hn.as_of_date = h.as_of_date AND hn.quantity != 0
          )
          ${accountSql}`
    )
    .all(symbol, ...(accountIds ?? [])) as {
    account_id: number;
    security_id: number;
    closed_as_of_date: string;
  }[];

  // The pair's newest date carries a zero row and no non-zero row: the
  // position is flat there, not flipped to the other side.
  const newestIsZero = db.prepare(
    `SELECT 1 FROM holdings h
      WHERE h.account_id = ? AND h.security_id = ?
        AND h.as_of_date = (
          SELECT MAX(h2.as_of_date) FROM holdings h2
           WHERE h2.account_id = h.account_id AND h2.security_id = h.security_id
        )
      GROUP BY h.as_of_date
     HAVING SUM(CASE WHEN h.quantity = 0 THEN 1 ELSE 0 END) > 0
        AND SUM(CASE WHEN h.quantity != 0 THEN 1 ELSE 0 END) = 0`
  );
  const index = getPendingStatementIndex(db, accountIds, { today });
  const listable = (accountId: number, securityId: number): boolean =>
    !blocksClosedPerLiveData(index, accountId, securityId) && newestIsZero.get(accountId, securityId) != null;

  // A LOCAL (account, security) key for de-duplication only; never tested
  // against the pending index (its keys carry the side).
  const pairs = new Map<string, { account_id: number; security_id: number; closed_as_of_date: string }>();
  for (const r of zeroRows) {
    if (listable(r.account_id, r.security_id)) pairs.set(`${r.account_id}|${r.security_id}`, r);
  }
  for (const p of index.pairs) {
    if (p.symbol !== symbol || p.reason !== "awaiting_statement") continue;
    const localKey = `${p.account_id}|${p.security_id}`;
    if (pairs.has(localKey) || !listable(p.account_id, p.security_id)) continue;
    pairs.set(localKey, { account_id: p.account_id, security_id: p.security_id, closed_as_of_date: p.flat_date });
  }

  const lastNonZero = db.prepare(
    `SELECT a.name AS account_name, s.symbol, h.as_of_date, h.quantity
       FROM holdings h
       JOIN accounts a ON a.id = h.account_id
       JOIN securities s ON s.id = h.security_id
      WHERE h.account_id = ? AND h.security_id = ? AND h.quantity != 0
      ORDER BY h.as_of_date DESC
      LIMIT 1`
  );

  const accountLedgerEnd = db.prepare(
    "SELECT MAX(trade_date) AS last_date FROM transactions WHERE account_id = ?"
  );

  const out: ClosedPerLiveDataResult[] = [];
  for (const pair of pairs.values()) {
    const row = lastNonZero.get(pair.account_id, pair.security_id) as
      | { account_name: string; symbol: string; as_of_date: string; quantity: number }
      | undefined;
    if (!row) continue;
    const ledgerEnd = accountLedgerEnd.get(pair.account_id) as { last_date: string | null } | undefined;
    out.push({
      account_name: row.account_name,
      symbol: row.symbol,
      as_of_date: row.as_of_date,
      quantity: row.quantity,
      closed_as_of_date: pair.closed_as_of_date,
      account_ledger_last_date: ledgerEnd?.last_date ?? null,
      pending_statement: true,
      status_note: PENDING_STATEMENT_CHAT_NOTE,
    });
  }
  return out.sort((a, b) => a.account_name.localeCompare(b.account_name));
}

/**
 * R3: a pair with any side pending for a reason other than
 * `awaiting_statement` is never described as "closed per live data".
 */
function blocksClosedPerLiveData(index: PendingStatementIndex, accountId: number, securityId: number): boolean {
  const reasons = index.pairReasons(accountId, securityId);
  return reasons.includes("closing_entry_missing") || reasons.includes("resymbol_repair_pending");
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
  const conditions: string[] = ["UPPER(s.symbol) = UPPER(?)"];
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
    // B8: an option past its expiration day (ET) is not a holding, as in
    // getHoldingsForChat, so the two tools size the same book.
    liveOptionExpirationSql("s", todayET()),
  ];
  const params: (string | number)[] = [];

  if (accountName) {
    conditions.push("a.name = ?");
    params.push(accountName);
  }

  // One row per position with its RAW label; the grouping happens below so
  // every spelling of one category lands in one group.
  const positions = db
    .prepare(
      `WITH latest_prices AS (
        SELECT p.security_id, p.close_price
        FROM prices p
        INNER JOIN (SELECT security_id, MAX(date) AS max_date FROM prices GROUP BY security_id) lp
        ON p.security_id = lp.security_id AND p.date = lp.max_date
      )
      SELECT
        ${groupExpr} AS group_name,
        CASE
          WHEN lp.close_price IS NOT NULL
            THEN ${adjustedMarketValueSQL("h.quantity", "lp.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
          WHEN h.cost_basis IS NOT NULL AND h.cost_basis > 0
            THEN h.cost_basis * COALESCE(fx.usd_per_unit, 1)
          ELSE 0
        END AS mv
      FROM holdings h
      JOIN accounts a ON a.id = h.account_id
      JOIN securities s ON s.id = h.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      LEFT JOIN latest_prices lp ON lp.security_id = h.security_id
      ${factorJoins}
      WHERE ${conditions.join(" AND ")}`
    )
    .all(...params) as { group_name: string; mv: number }[];

  return groupAllocation(positions, (raw) => allocationLabel(groupBy, raw));
}

/** Stored security_type spellings, by normalized token (the DB's canonical labels). */
const SECURITY_TYPE_LABELS: Record<string, string> = {
  stock: "Stock",
  etf: "ETF",
  bond: "Bond",
  option: "Option",
  "mutual fund": "Mutual Fund",
  "money market": "Money Market",
};

/**
 * The display label a raw group value belongs to. Security types compare
 * case-insensitively (underscores as spaces); sectors go through
 * normalizeSector (GICS-11) and, for a fund-category fallback,
 * normalizeFundCategory; fund categories through normalizeFundCategory.
 * Account names are exact. Every other label is folded on case later.
 */
function allocationLabel(groupBy: string, raw: string): string {
  const value = (raw ?? "").trim() || raw;
  switch (groupBy) {
    case "account":
    case "symbol":
      return raw;
    case "security_type": {
      const token = normalizeSecurityTypeToken(value);
      return SECURITY_TYPE_LABELS[token] ?? value;
    }
    case "sector":
      return normalizeSector(value) ?? normalizeFundCategory(value) ?? value;
    case "fund_category":
      return normalizeFundCategory(value) ?? value;
    default:
      return value;
  }
}

/**
 * Sum positions into groups keyed case-insensitively on their label (the
 * label shown is the first spelling in code-point order, so it is stable).
 * Totals are kept whole, so the groups sum to the allocation total.
 */
function groupAllocation(
  positions: { group_name: string; mv: number }[],
  label: (raw: string) => string
): AllocationResult[] {
  const groups = new Map<string, { names: string[]; total: number; count: number }>();
  for (const p of positions) {
    const name = label(p.group_name);
    const key = name.trim().toLowerCase();
    const g = groups.get(key) ?? { names: [], total: 0, count: 0 };
    g.names.push(name);
    g.total += p.mv ?? 0;
    g.count += 1;
    groups.set(key, g);
  }
  const grand = [...groups.values()].reduce((sum, g) => sum + g.total, 0);
  return [...groups.values()]
    .map((g) => ({
      group_name: [...g.names].sort()[0],
      total_market_value: g.total,
      // A book worth nothing has no shares: 0, never a division by zero.
      percentage: grand !== 0 ? (g.total * 100) / grand : 0,
      position_count: g.count,
    }))
    .sort((a, b) => b.total_market_value - a.total_market_value);
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

  // Account tax treatment, for open and closed rows (quality audit §2).
  const taxTreatmentById = new Map<number, string | null>(
    (db.prepare("SELECT id, tax_treatment FROM accounts").all() as { id: number; tax_treatment: string | null }[]).map(
      (a) => [a.id, a.tax_treatment]
    )
  );

  const queryClosedSales = (): TaxLotResult[] => {
    // B6: built on the one closed-sales reader. Its *_usd fields multiply by
    // today's fx_rates row and read a MISSING rate as 1 (parity), so a
    // converted figure is offered only for USD or a currency with a rate on
    // file, and is labelled as a current-rate conversion (ruling P14).
    const fxCurrencies = new Set(
      (db.prepare("SELECT currency FROM fx_rates").all() as { currency: string }[]).map((r) => r.currency)
    );
    const wantSymbol = symbol?.trim().toUpperCase();
    const sales = getClosedTaxLotSales(db, year, account_name ? { accountName: account_name } : undefined).filter(
      (r) => !wantSymbol || r.symbol.toUpperCase() === wantSymbol
    );

    const rows: TaxLotResult[] = sales.map((r) => {
      const convertible = r.currency === "USD" || fxCurrencies.has(r.currency);
      const notes: string[] = [];
      if (r.is_synthetic_close) notes.push(SYNTHETIC_CLOSE_CHAT_NOTE);
      if (isCurrencyConversionTaxLot(r)) notes.push(CURRENCY_CONVERSION_CHAT_NOTE);
      return {
        account_name: r.account_name,
        account_tax_treatment: taxTreatmentById.get(r.account_id) ?? null,
        symbol: r.symbol,
        security_name: r.security_name,
        security_type: r.security_type,
        currency: r.currency,
        acquisition_date: r.acquisition_date,
        acquisition_price: r.acquisition_price,
        quantity_remaining: r.quantity_sold,
        // Native, as stored (the same figures as the *_native fields).
        cost_basis: r.cost_basis_allocated,
        current_price: null,
        price_date: null,
        current_value: null,
        unrealized_gain: null,
        days_held: r.holding_period_days,
        is_long_term: Boolean(r.is_long_term),
        long_term_date: null,
        sale_date: r.sale_date,
        sale_price: r.sale_price,
        proceeds: r.proceeds,
        realized_gain_loss: r.realized_gain_loss,
        holding_period_days: r.holding_period_days,
        proceeds_native: r.proceeds,
        cost_basis_native: r.cost_basis_allocated,
        realized_gain_native: r.realized_gain_loss,
        proceeds_usd_at_current_fx: convertible ? r.proceeds_usd : null,
        cost_basis_usd_at_current_fx: convertible ? r.cost_basis_allocated_usd : null,
        realized_gain_usd_at_current_fx: convertible ? r.realized_gain_loss_usd : null,
        fx_note: r.currency === "USD" ? undefined : convertible ? CURRENT_FX_CHAT_NOTE : NO_FX_RATE_CHAT_NOTE,
        is_synthetic_close: r.is_synthetic_close,
        status_note: notes.length > 0 ? notes.join(" ") : undefined,
      };
    });

    // sort_by applies to closed sales too (B6's second half). Money sorts
    // compare USD figures only; a non-USD sale with no rate on file has no
    // comparable figure and sorts last (never its native figure among dollars).
    const byMoney =
      (key: (r: TaxLotResult) => number | null | undefined, direction: 1 | -1) =>
      (a: TaxLotResult, b: TaxLotResult) => {
        const x = key(a);
        const y = key(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return direction * (x - y);
      };
    const compare: Record<NonNullable<TaxLotFilters["sort_by"]>, (a: TaxLotResult, b: TaxLotResult) => number> = {
      unrealized_gain: byMoney((r) => r.realized_gain_usd_at_current_fx, 1), // losses first
      acquisition_date: (a, b) => a.acquisition_date.localeCompare(b.acquisition_date),
      holding_period_days: (a, b) => Math.abs(b.holding_period_days ?? 0) - Math.abs(a.holding_period_days ?? 0),
      cost_basis: byMoney((r) => r.cost_basis_usd_at_current_fx, -1),
    };
    const sorted = rows.sort(compare[sort_by] ?? compare.unrealized_gain);
    // A negative limit is "every row" (the totals read), as LIMIT -1 is in SQL.
    return limit < 0 ? sorted : sorted.slice(0, limit);
  };

  const queryOpenLots = (): TaxLotResult[] => {
  // Open lots
  const conditions: string[] = ["tl.quantity_remaining > 0"];
  const params: (string | number)[] = [];

  if (symbol) {
    conditions.push("UPPER(s.symbol) = UPPER(?)");
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
      SELECT p.security_id, p.close_price, lp.max_date
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
      COALESCE(s.currency, 'USD') AS currency,
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
      lp.max_date AS price_date,
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

  // Pending state comes from the shared read model, never re-derived here
  // (one index, the same Eastern day as the expiry note). A lot that is not
  // ordinary-open carries NO value and NO gain (ruling R1): a pending lot
  // (any reason), and an expired option awaiting its closing entry, which
  // the index never lists as pending (expired beats pending). The last MARK
  // is withheld with them: a shipped current_price was multiplied back into
  // a "value at last mark" for a put that finished out of the money (QA
  // 2026-10-28), so no figure the model could turn into a value reaches it.
  const pendingIndex = getPendingStatementIndex(db, undefined, { today });
  return rows.map(({ account_id, security_id, is_short, ...r }) => {
    const reason = pendingIndex.reasonFor({ account_id, security_id, is_short });
    const expiredOption = isExpiredOptionRow(r, today);
    const baseNote = taxLotStatusNote(r, today);
    // A short lot says so in words as well as in the flag, so the model never
    // suggests "selling" it or waiting for long-term treatment.
    const short = is_short === 1;
    const side = sideOf(is_short);
    const statusNote = short ? (baseNote ? `${SHORT_LOT_CHAT_NOTE} ${baseNote}` : SHORT_LOT_CHAT_NOTE) : baseNote;
    const common = {
      account_tax_treatment: taxTreatmentById.get(account_id) ?? null,
      is_long_term: Boolean(r.is_long_term),
      position_side: side,
      figure_kind: figureKindForSide(side),
    };
    if (reason != null) {
      const lead = short ? `${pendingReasonChatNote(reason)} ${SHORT_PENDING_FIGURE_CHAT_NOTE}` : pendingReasonChatNote(reason);
      return {
        ...r,
        ...common,
        current_price: null,
        current_value: null,
        unrealized_gain: null,
        pending_statement: true,
        pending_statement_reason: reason,
        status_note: statusNote ? `${lead} ${statusNote}` : lead,
      };
    }
    return {
      ...r,
      ...common,
      ...(expiredOption ? { current_price: null, current_value: null, unrealized_gain: null } : {}),
      pending_statement: false,
      pending_statement_reason: null,
      status_note: statusNote,
    };
  }) as TaxLotResult[];
  };

  if (status === "closed") return queryClosedSales();
  if (status === "all") return [...queryOpenLots(), ...queryClosedSales()];
  return queryOpenLots();
}

/** Totals over EVERY lot matching a query_tax_lots filter (not the rows returned). */
export interface TaxLotTotals {
  open_lots?: {
    long: { count: number; cost_basis_usd: number; unrealized_gain_usd: number; unpriced_count: number };
    short: { count: number; short_sale_proceeds_usd: number; unrealized_gain_usd: number; unpriced_count: number };
  };
  pending_lots?: { count: number; by_reason: Record<string, number> };
  closed_sales?: { count: number; realized_gain_usd_at_current_fx: number; left_out_no_fx_rate: number };
  note: string;
}

export const TAX_LOT_TOTALS_NOTE =
  "Totals cover every lot matching the filter, not only the rows returned. Long cost basis and short-sale proceeds are separate figures and never added together; so are long and short unrealized gains (USD). Pending lots (awaiting a statement or a closing entry, or an expired option awaiting its close) are counted only: they carry no value and no gain. Closed sales are totalled in USD at today's FX rate; a sale whose currency has no rate on file is counted in left_out_no_fx_rate and not in the total.";

/**
 * The totals block for query_tax_lots: the SAME reader as the rows
 * (getTaxLotsForChat, so the same filter, pending index and FX rule), read
 * with no limit and summed by side. Pending and expired rows already carry
 * null value and gain there; they are counted here, never totalled.
 */
export function getTaxLotTotalsForChat(
  db: Database.Database,
  filters: Pick<TaxLotFilters, "status" | "symbol" | "account_name" | "year">,
): TaxLotTotals {
  const status = filters.status ?? "open";
  const today = todayET();
  const out: TaxLotTotals = { note: TAX_LOT_TOTALS_NOTE };
  if (status !== "closed") {
    const rows = getTaxLotsForChat(db, { ...filters, status: "open", limit: -1 });
    const long = { count: 0, cost_basis_usd: 0, unrealized_gain_usd: 0, unpriced_count: 0 };
    const short = { count: 0, short_sale_proceeds_usd: 0, unrealized_gain_usd: 0, unpriced_count: 0 };
    const byReason: Record<string, number> = {};
    let pending = 0;
    for (const r of rows) {
      const reason = r.pending_statement
        ? (r.pending_statement_reason ?? "pending")
        : isExpiredOptionRow(r, today)
          ? "expired_option_awaiting_close"
          : null;
      if (reason) {
        pending++;
        byReason[reason] = (byReason[reason] ?? 0) + 1;
        continue;
      }
      const side = r.position_side === "short" ? short : long;
      side.count++;
      if (side === short) short.short_sale_proceeds_usd += r.cost_basis;
      else long.cost_basis_usd += r.cost_basis;
      if (r.unrealized_gain == null) side.unpriced_count++;
      else side.unrealized_gain_usd += r.unrealized_gain;
    }
    out.open_lots = { long, short };
    out.pending_lots = { count: pending, by_reason: byReason };
  }
  if (status !== "open") {
    const sales = getTaxLotsForChat(db, { ...filters, status: "closed", limit: -1 });
    let total = 0;
    let leftOut = 0;
    for (const r of sales) {
      if (r.realized_gain_usd_at_current_fx == null) leftOut++;
      else total += r.realized_gain_usd_at_current_fx;
    }
    out.closed_sales = { count: sales.length, realized_gain_usd_at_current_fx: total, left_out_no_fx_rate: leftOut };
  }
  return out;
}

/** One security held in two or more positions in scope, summed. */
export interface HoldingSymbolRollup {
  symbol: string;
  security_name: string | null;
  security_type: string | null;
  accounts: string[];
  positions: number;
  total_quantity: number;
  total_cost_basis_usd: number | null;
  cost_basis_per_share_usd: number | null;
  cost_basis_per_share_reason?: string;
  market_value: number;
  unrealized_gain: number | null;
  positions_without_basis: number;
}

const PER_SHARE_TYPES = new Set(["stock", "etf", "mutual fund"]);

/**
 * Per-security roll-up for query_holdings: the security page's POSITIONS
 * reader and totals (getHoldingsBySecurity + computePositionTotals), limited
 * to the scope's accounts, for every security of `symbols` held in two or
 * more positions. Keyed by security, never blended across securities that
 * share a symbol. The per-share basis is total basis / total quantity for a
 * long stock, ETF or fund position with every basis known; otherwise null
 * with the reason.
 */
export function getHoldingsBySymbolForChat(
  db: Database.Database,
  symbols: string[],
  accountIds: number[] | undefined,
): HoldingSymbolRollup[] {
  const inScope = accountIds ? new Set(accountIds) : null;
  const secStmt = db.prepare("SELECT id, symbol, name, security_type FROM securities WHERE symbol = ? ORDER BY id");
  const out: HoldingSymbolRollup[] = [];
  for (const symbol of [...new Set(symbols)]) {
    for (const sec of secStmt.all(symbol) as Array<{ id: number; symbol: string; name: string | null; security_type: string | null }>) {
      // A short's basis is read as minus its magnitude, the rule the rows use
      // (getHoldingsForChat). Every real source stores it negative, so this
      // changes nothing for real data; a short stored positive would
      // otherwise sum to a different gain than the rows beside it.
      const positions = getHoldingsBySecurity(db, sec.id)
        .filter((p) => !inScope || inScope.has(p.account_id))
        .map((p) =>
          p.quantity < 0 && p.cost_basis != null && p.cost_basis > 0
            ? {
                ...p,
                cost_basis: -p.cost_basis,
                unrealized_gain: p.current_value != null ? p.current_value + p.cost_basis : p.unrealized_gain,
              }
            : p,
        );
      if (positions.length < 2) continue;
      const totals = computePositionTotals(positions);
      const qty = positions.reduce((a, p) => a + p.quantity, 0);
      const type = (sec.security_type ?? "").trim().toLowerCase().replace(/_/g, " ");
      const anyLong = positions.some((p) => p.quantity > 0);
      const anyShort = positions.some((p) => p.quantity < 0);
      let reason: string | undefined;
      if (!PER_SHARE_TYPES.has(type)) reason = `a per-share basis is given for stocks, ETFs and funds only; this is ${sec.security_type ?? "an unknown type"}`;
      else if (anyLong && anyShort) reason = "held long and short: the positions do not share one per-share basis";
      else if (anyShort) reason = "a short position: its basis is the sale proceeds, not a cost per share";
      else if (totals.positionsWithoutBasis.length > 0 || totals.totalCostBasis == null) reason = `${totals.positionsWithoutBasis.length} position(s) have no cost basis on file`;
      out.push({
        symbol: sec.symbol,
        security_name: sec.name,
        security_type: sec.security_type,
        accounts: [...new Set(positions.map((p) => p.account_name))].sort(),
        positions: positions.length,
        total_quantity: qty,
        total_cost_basis_usd: totals.totalCostBasis,
        cost_basis_per_share_usd: reason || qty === 0 ? null : (totals.totalCostBasis as number) / qty,
        ...(reason ? { cost_basis_per_share_reason: reason } : {}),
        market_value: totals.totalValue,
        unrealized_gain: totals.totalUnrealizedGain,
        positions_without_basis: totals.positionsWithoutBasis.length,
      });
    }
  }
  return out;
}

/** How chat describes an open short lot (pinned by tests). */
export const SHORT_LOT_CHAT_NOTE =
  "Short position: unrealized_gain is signed for the short side (a gain when the price has fallen). Closing it means buying to cover, and the gain or loss on a short is short-term however long it has been open.";

/** How chat describes a pending-statement lot (pinned by tests). */
export const PENDING_STATEMENT_CHAT_NOTE =
  "Pending statement: this position was closed per live broker data, awaiting the broker statement for the closing trade. It is not an unrealized holding, and its realized gain is unknown until the statement is imported.";

/** A closed sale the lot engine made (RECONCILE_CLOSE); pinned by tests. */
export const SYNTHETIC_CLOSE_CHAT_NOTE =
  "Estimated by the lot engine from a missing broker trade; not a recorded sale.";

/** Ruling P14: how a converted closed-sale figure was converted. */
export const CURRENT_FX_CHAT_NOTE =
  "USD figures use the current FX rate, not the rate on the sale date; native figures are primary.";

/** Ruling P14: a non-USD sale with no rate on file. */
export const NO_FX_RATE_CHAT_NOTE = "no FX rate on file; native figures only";

const CURRENCY_CONVERSION_CHAT_NOTE =
  "Currency conversion: this is a Section 988 ordinary-income cash-management lot, not a capital tax lot.";

/** How chat describes a lot whose statement shows the position closed with no closing trade in the ledger (pinned by tests). */
export const CLOSING_ENTRY_MISSING_CHAT_NOTE =
  "Closing entry missing: the broker statement shows this position closed, but the closing trade is not in the ledger. It is not a holding, and its realized result is unknown until that entry is imported.";

/**
 * How chat describes an old-symbol option lot whose contract was renamed
 * after a split (pinned by tests). Says what must happen (the ledger
 * entries move to the new symbol), never that a particular script will do
 * it (ruling R7).
 */
export const RESYMBOL_REPAIR_PENDING_CHAT_NOTE =
  "Re-symbolled: this option was renamed to a new contract after a split of the underlying. The position is still held under the new contract; these old-symbol lots are not valued until their ledger entries are moved to the new symbol. Do not describe it as closed.";

/** Added for a pending SHORT lot: its figure is proceeds, not a cost. */
export const SHORT_PENDING_FIGURE_CHAT_NOTE =
  "Its cost_basis is the short-sale proceeds still open (money received when it was sold short), not a cost.";

/** The chat note for each pending reason (one place). */
export function pendingReasonChatNote(reason: PendingReason): string {
  switch (reason) {
    case "awaiting_statement":
      return PENDING_STATEMENT_CHAT_NOTE;
    case "closing_entry_missing":
      return CLOSING_ENTRY_MISSING_CHAT_NOTE;
    case "resymbol_repair_pending":
      return RESYMBOL_REPAIR_PENDING_CHAT_NOTE;
  }
}

const EXPIRED_OPTION_CHAT_NOTE =
  "Expired option: this contract is past expiration and is awaiting a real broker closing entry.";

function isExpiredOptionRow(row: { security_type?: unknown; expiration_date?: unknown }, today: string): boolean {
  return (
    String(row.security_type ?? "").trim().toLowerCase() === "option" &&
    !isOptionLive(row.expiration_date as string | null | undefined, today)
  );
}

function taxLotStatusNote(row: { security_type?: string | null; expiration_date?: string | null }, today: string): string | undefined {
  if (isCurrencyConversionSecurityType(row.security_type)) return CURRENCY_CONVERSION_CHAT_NOTE;
  if (isExpiredOptionRow(row, today)) return EXPIRED_OPTION_CHAT_NOTE;
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

  // Engine-owned synthetic closes are never user activity (same rule as lib/queries/transactions.ts).
  const conditions: string[] = ["t.type != 'RECONCILE_CLOSE'"];
  const params: (string | number)[] = [];

  if (account_name) {
    conditions.push("a.name = ?");
    params.push(account_name);
  }
  if (symbol) {
    conditions.push("UPPER(s.symbol) = UPPER(?)");
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
        t.fees,
        ${transactionAmountCurrencySql()} AS amount_currency,
        ${transactionAmountUsdSql()} AS amount_usd
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN securities s ON s.id = t.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      ${whereClause}
      ORDER BY t.trade_date DESC
      LIMIT ?`
    )
    .all(...params, limit) as TransactionResult[];
}

const RECONCILE_GAP_NOTE_LIMIT = 50;

/**
 * Notes for engine-made RECONCILE_CLOSE rows the transactions tool hides.
 * The engine mints one only when the broker's holdings showed the position
 * flat while the ledger still held shares, so the ledger is missing the real
 * closing sale. Without a note the model reads buys with no sale as a
 * position that stayed open.
 */
export function getReconcileGapNotesForChat(
  db: Database.Database,
  filters: TransactionFilters = {}
): string[] {
  const conditions: string[] = ["t.type = 'RECONCILE_CLOSE'"];
  const params: string[] = [];
  if (filters.account_name) {
    conditions.push("a.name = ?");
    params.push(filters.account_name);
  }
  if (filters.symbol) {
    conditions.push("UPPER(s.symbol) = UPPER(?)");
    params.push(filters.symbol);
  }
  if (filters.start_date) {
    conditions.push("t.trade_date >= ?");
    params.push(filters.start_date);
  }
  if (filters.end_date) {
    conditions.push("t.trade_date <= ?");
    params.push(filters.end_date);
  }
  const rows = db
    .prepare(
      `SELECT t.trade_date, t.quantity, s.symbol, a.name AS account_name
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN securities s ON s.id = t.security_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY t.trade_date DESC, t.id DESC`
    )
    .all(...params) as { trade_date: string; quantity: number | null; symbol: string | null; account_name: string }[];
  // Same cap as the transactions tool, newest first.
  const notes = rows.slice(0, RECONCILE_GAP_NOTE_LIMIT).map((r) => {
    const qty = Math.abs(r.quantity ?? 0);
    const sym = r.symbol ?? "this security";
    // The engine dates its close ON the statement-flat day, so the missing sale
    // falls on or before that date (after the last ledger buy), never after it.
    return `Ledger gap: the broker statement of ${r.trade_date} shows ${sym} flat in ${r.account_name}, but the ledger has no sale closing these ${qty} shares. Report a ledger gap and read the holdings history; do not say the position stayed open or invent a purchase to explain a later quantity.`;
  });
  const omitted = rows.length - notes.length;
  if (omitted > 0) {
    notes.push(
      `${omitted} more ledger gaps omitted (showing the newest ${RECONCILE_GAP_NOTE_LIMIT}); narrow by symbol, account or date to see them.`
    );
  }
  return notes;
}

/**
 * The newest transaction date within the account and symbol filter (type and
 * date filters deliberately NOT applied). With a symbol this is that
 * symbol's LAST TRADE, not where the ledger ends: the account's ledger can
 * run weeks past it (use {@link getLedgerEndByAccountForChat} for that).
 * Null when the filter matches no transaction.
 */
export function getLedgerLastDateForChat(
  db: Database.Database,
  filters: { account_name?: string; symbol?: string } = {}
): string | null {
  const conditions: string[] = [];
  const params: string[] = [];
  if (filters.account_name) {
    conditions.push("a.name = ?");
    params.push(filters.account_name);
  }
  if (filters.symbol) {
    conditions.push("UPPER(s.symbol) = UPPER(?)");
    params.push(filters.symbol);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const row = db
    .prepare(
      `SELECT MAX(t.trade_date) AS last_date
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN securities s ON s.id = t.security_id
         ${whereClause}`
    )
    .get(...params) as { last_date: string | null } | undefined;
  return row?.last_date ?? null;
}

/** Where one account's imported ledger ends. */
export interface LedgerEndForAccount {
  account_name: string;
  /** Newest transaction date in the account, any symbol and type. Null when it has none. */
  ledger_last_date: string | null;
}

/**
 * Where the imported ledger ends, per ACCOUNT (symbol, type and date filters
 * never narrow the date: a symbol's last trade is not the ledger's end).
 * Activity after an account's date may exist only in holdings (live broker
 * data awaiting the statement).
 *
 * Accounts listed: those in `accountIds` (undefined = every account, an empty
 * list = none) that are involved: with a symbol, the accounts holding or
 * trading it (any holdings or transaction row); without one, the accounts
 * with any transaction.
 */
export function getLedgerEndByAccountForChat(
  db: Database.Database,
  filters: { accountIds?: readonly number[]; symbol?: string } = {}
): LedgerEndForAccount[] {
  const scope = accountScopeAndSql(filters.accountIds, "a.id");
  const involvedSql = filters.symbol
    ? `AND (
         EXISTS (SELECT 1 FROM transactions t JOIN securities s ON s.id = t.security_id
                  WHERE t.account_id = a.id AND UPPER(s.symbol) = UPPER(?))
         OR EXISTS (SELECT 1 FROM holdings h JOIN securities s ON s.id = h.security_id
                     WHERE h.account_id = a.id AND UPPER(s.symbol) = UPPER(?))
       )`
    : "AND EXISTS (SELECT 1 FROM transactions t WHERE t.account_id = a.id)";
  const involvedParams = filters.symbol ? [filters.symbol, filters.symbol] : [];
  return db
    .prepare(
      `SELECT a.name AS account_name,
              (SELECT MAX(t.trade_date) FROM transactions t WHERE t.account_id = a.id) AS ledger_last_date
         FROM accounts a
        WHERE 1 = 1 ${scope.sql} ${involvedSql}
        ORDER BY a.name`
    )
    .all(...scope.params, ...involvedParams) as LedgerEndForAccount[];
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

  const rows = db
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
        ms.twr,
        ms.source AS twr_source
      FROM monthly_snapshots ms
      JOIN accounts a ON a.id = ms.account_id
      ${whereClause}
      ORDER BY ms.month_end_date ASC, a.name`
    )
    .all(...params) as Array<PerformanceResult & { twr_source: string | null }>;

  // The stored twr column is mixed-unit (a percent on ibkr-activity rows, a
  // fraction elsewhere); the model always gets a fraction, through the one
  // reader, so an IBKR month can never read 100x too large.
  return rows.map(({ twr_source, ...row }) => ({
    ...row,
    twr: snapshotTwrFraction({ twr: row.twr, source: twr_source }),
  }));
}

/**
 * Summarize investment income (dividends, interest) and fees over a period.
 */
export function getIncomeSummaryForChat(
  db: Database.Database,
  filters: IncomeSummaryFilters = {}
): IncomeResult[] {
  const { period = "trailing_12m", group_by = "symbol", account_name, account_ids } = filters;

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

  const incomeConditions = ["t.trade_date >= ?", "t.trade_date <= ?", INCOME_TYPES_SQL];
  const incomeParams: (string | number)[] = [startDate, endDate];

  // Ids (the dispatcher's resolved scope) win; `[]` reads no account. The
  // exact account name still works for existing callers.
  if (account_ids) {
    const scope = accountScopeCondition(account_ids, "t.account_id");
    if (scope.condition) incomeConditions.push(scope.condition);
    incomeParams.push(...scope.params);
  } else if (account_name) {
    incomeConditions.push("a.name = ?");
    incomeParams.push(account_name);
  }

  // Contract J (lib/queries/income-sql.ts): a reinvested dividend counts
  // once, a reversal nets, margin interest charged is a cost.
  return db
    .prepare(
      `WITH ${incomePairingCtes(db)}
      SELECT
        ${expr} AS group_name,
        COALESCE(SUM(${DIVIDEND_INCOME_SQL}), 0) AS total_dividends,
        COALESCE(SUM(${INTEREST_EARNED_SQL}), 0) AS total_interest,
        COALESCE(SUM(${INTEREST_PAID_SQL}), 0) AS interest_paid,
        COALESCE(SUM(${FEES_SQL}), 0) AS total_fees,
        COALESCE(SUM(${NET_INCOME_SQL}), 0) AS net_income,
        COALESCE(SUM(${UNPAIRED_NEGATIVE_REINVESTMENT_SQL}), 0) AS unpaired_reinvestment_count
      FROM transactions t
      JOIN accounts a ON a.id = t.account_id
      LEFT JOIN securities s ON s.id = t.security_id
      ${INCOME_PAIRED_JOIN}
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

/**
 * How old the data behind a tool result is, in whole Eastern calendar days
 * (B25: never the UTC clock, which already reads tomorrow from 20:00
 * Eastern).
 *
 * Reads the scope's latest holdings (`latestHoldingsPredicate`; undefined
 * = every account, `[]` = none; Codex 12): the holdings date is the newest
 * of those rows, the price date the newest price among the securities they
 * hold. So a stale account is never reported fresh because an unrelated
 * account (or an unheld watchlist price) is.
 */
export function getDataFreshness(
  db: Database.Database,
  opts?: { accountIds?: number[] },
): DataFreshness {
  const accountIds = opts?.accountIds;
  // One read for every scope (undefined = every account): the scope's
  // latest holdings rows, through the shared predicate.
  const scope = accountScopeAndSql(accountIds, "h.account_id");
  const scopedHoldings = `FROM holdings h WHERE ${latestHoldingsPredicate({ includeShorts: true, accountFilter: scope.sql })}`;
  // Newest date among rows the predicate already chose (a freshness read
  // over a correct row set, not a row filter).
  const latestHoldings =
    (
      db.prepare(`SELECT h.as_of_date AS latest ${scopedHoldings} ORDER BY h.as_of_date DESC LIMIT 1`).get(
        ...scope.params
      ) as { latest: string } | undefined
    )?.latest ?? null;
  const latestPrice = (
    db
      .prepare(
        `SELECT MAX(p.date) AS latest FROM prices p
         WHERE p.security_id IN (SELECT h.security_id ${scopedHoldings})`
      )
      .get(...scope.params) as { latest: string | null }
  ).latest;

  const today = todayET();
  return {
    latest_price_date: latestPrice,
    price_age_days: latestPrice ? calendarDaysBetween(latestPrice, today) : null,
    latest_holdings_date: latestHoldings,
    holdings_age_days: latestHoldings ? calendarDaysBetween(latestHoldings, today) : null,
  };
}
