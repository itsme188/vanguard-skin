/**
 * Consolidated queries for the Security Detail page.
 * Aggregates data from holdings, tax lots, transactions, notes, calendar events,
 * factors, and transcripts into a single typed result for the server component.
 */

import type Database from "better-sqlite3";
import type {
  Security,
  SecurityFactor,
  CalendarEvent,
  EarningsTranscript,
} from "@/lib/types";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { getNotesForSecurity, type NoteWithContext } from "@/lib/queries/notes";
import type {
  TaxLotWithSecurity,
  TaxLotSaleWithDetails,
} from "@/lib/queries/tax-lots";
import type { TransactionWithSecurity } from "@/lib/queries/transactions";
import type { TradeRoundtrip } from "@/lib/types";
import { getSecurityById } from "@/lib/queries/securities";
import { getUpcomingEvents } from "@/lib/queries/calendar";
import { getTranscriptsForSecurity } from "@/lib/queries/transcripts";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { getArticlesForSecurity, type ResearchMention } from "@/lib/queries/research";
import { getLatestDailyBar, get52WeekRange, getOhlcvBars } from "@/lib/queries/ohlcv";
import { getUsdPerUnit } from "@/lib/queries/fx-rates";
import { getSecurityQuote } from "@/lib/queries/security-quotes";
import { computeATR, type OhlcBar } from "@/lib/chart/indicators";

// ─── Result types ──────────────────────────────────────────────

export interface SecurityPosition {
  account_id: number;
  account_name: string;
  quantity: number;
  cost_basis: number | null;
  as_of_date: string;
  current_price: number | null;
  current_value: number | null;
  unrealized_gain: number | null;
  security_type: string | null;
  multiplier: number;
}

export interface SecurityPriceInfo {
  close_price: number;
  date: string;
  prev_close: number | null;
  change: number | null;
  change_pct: number | null;
}

export interface SecurityDetailTransaction extends TransactionWithSecurity {
  security_type: string | null;
  option_type: "CALL" | "PUT" | null;
  underlying_symbol: string | null;
  strike_price: number | null;
  expiration_date: string | null;
}

export interface SecurityKpis {
  /** Date of the latest daily bar (may lag by weekend/holidays). */
  asOfDate: string;
  open: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  volume: number | null;
  week52High: number | null;
  week52Low: number | null;
  /**
   * As-of date of whichever 52-week source won the freshness arbitration
   * (IBKR quote vs daily bars) — bars anchor their trailing window to their
   * own latest date, so stale bars back-shift the window and resurrect
   * rolled-out extremes. Null when no range is available.
   */
  week52AsOf: string | null;
  /** 14-period ATR on daily bars (Wilder smoothing). Null if <15 bars. */
  atr14: number | null;
}

export interface SecurityDetailData {
  security: Security;
  price: SecurityPriceInfo | null;
  kpis: SecurityKpis | null;
  positions: SecurityPosition[];
  totalValue: number;
  totalCostBasis: number;
  totalUnrealizedGain: number;
  openTaxLots: TaxLotWithSecurity[];
  closedSales: TaxLotSaleWithDetails[];
  recentTransactions: SecurityDetailTransaction[];
  relatedOptionTransactions: SecurityDetailTransaction[];
  notes: NoteWithContext[];
  upcomingEvents: CalendarEvent[];
  factors: SecurityFactor | null;
  transcripts: EarningsTranscript[];
  tradeGrades: TradeGradeEntry[];
  researchMentions: ResearchMention[];
  /**
   * USD per unit of the security's native currency (1 for USD/unknown).
   * `price` and `kpis` stay NATIVE — the chart price-line and ATR/52wk
   * ratios need native units — so $-display sites multiply by this factor
   * at render time (MarketDataPanel / QuoteStats).
   */
  usdPerUnit: number;
}

export interface TradeGradeEntry {
  grade: string | null;
  entry_date: string;
  exit_date: string;
  realized_pnl: number;
  return_pct: number;
  holding_days: number;
  // Cleanly-named (post-migration 047). Null for rows written before the migration.
  assessment: string | null;
  what_went_well: string | null;
  what_went_wrong: string | null;
  // Legacy columns — only populated on rows pre-migration; readers should fall
  // back to these when `assessment` is null.
  entry_thesis: string | null;
  exit_assessment: string | null;
  review_period: string;
}

// ─── Individual queries ────────────────────────────────────────

/**
 * Get latest price with previous close for change calculation.
 */
export function getLatestPriceForSecurity(
  db: Database.Database,
  securityId: number
): SecurityPriceInfo | null {
  const row = db
    .prepare(
      `SELECT
        p.close_price, p.date,
        prev.close_price AS prev_close
      FROM prices p
      LEFT JOIN prices prev ON prev.security_id = p.security_id
        AND prev.date = (
          SELECT MAX(p2.date) FROM prices p2
          WHERE p2.security_id = p.security_id AND p2.date < p.date
        )
      WHERE p.security_id = ?
        AND p.date = (SELECT MAX(p3.date) FROM prices p3 WHERE p3.security_id = ?)
      LIMIT 1`
    )
    .get(securityId, securityId) as {
    close_price: number;
    date: string;
    prev_close: number | null;
  } | undefined;

  if (!row) return null;

  const change = row.prev_close != null ? row.close_price - row.prev_close : null;
  const change_pct =
    change != null && row.prev_close != null && row.prev_close !== 0
      ? (change / row.prev_close) * 100
      : null;

  return {
    close_price: row.close_price,
    date: row.date,
    prev_close: row.prev_close,
    change,
    change_pct,
  };
}

/**
 * Get current positions across all accounts for a security.
 * Uses latest holdings date per account.
 */
export function getHoldingsBySecurity(
  db: Database.Database,
  securityId: number
): SecurityPosition[] {
  return db
    .prepare(
      `SELECT
        h.account_id, a.name AS account_name,
        h.quantity, h.cost_basis * COALESCE(fx.usd_per_unit, 1) AS cost_basis, h.as_of_date,
        s.security_type, COALESCE(s.multiplier, 1) AS multiplier,
        p.close_price AS current_price,
        CASE WHEN p.close_price IS NOT NULL
          THEN ${adjustedMarketValueSQL("h.quantity", "p.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
          ELSE NULL END AS current_value,
        CASE WHEN p.close_price IS NOT NULL AND h.cost_basis IS NOT NULL
          THEN ${adjustedMarketValueSQL("h.quantity", "p.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} - (h.cost_basis * COALESCE(fx.usd_per_unit, 1))
          ELSE NULL END AS unrealized_gain
      FROM holdings h
      JOIN accounts a ON a.id = h.account_id
      JOIN securities s ON s.id = h.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      LEFT JOIN prices p ON p.security_id = h.security_id
        AND p.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = h.security_id)
      WHERE h.security_id = ?
        AND ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: false })}
      ORDER BY a.name`
    )
    .all(securityId) as SecurityPosition[];
}

/**
 * Get open tax lots for a specific security.
 */
export function getOpenTaxLotsBySecurity(
  db: Database.Database,
  securityId: number
): TaxLotWithSecurity[] {
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
      WHERE tl.quantity_remaining > 0 AND tl.security_id = ?
      ORDER BY a.name, tl.acquisition_date`
    )
    .all(securityId) as TaxLotWithSecurity[];
}

/**
 * Get closed tax lot sales for a specific security.
 */
export function getClosedSalesBySecurity(
  db: Database.Database,
  securityId: number,
  limit: number = 20
): TaxLotSaleWithDetails[] {
  return db
    .prepare(
      `SELECT
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
      JOIN securities s ON s.id = tl.security_id
      WHERE tl.security_id = ?
      ORDER BY tls.sale_date DESC
      LIMIT ?`
    )
    .all(securityId, limit) as TaxLotSaleWithDetails[];
}

/**
 * Get recent transactions for a specific security across all accounts.
 *
 * price_per_share / amount are stored in the security's NATIVE currency
 * (FX convention) — the fx_rates join converts them to USD for this
 * pure-display path, matching the tax-lot + hero queries on the same page.
 * The converted aliases after t.* deliberately shadow the native columns
 * (better-sqlite3 row objects are built in column order, so the last
 * same-named column wins — pinned by the FX test).
 */
export function getTransactionsBySecurity(
  db: Database.Database,
  securityId: number,
  limit: number = 100
): SecurityDetailTransaction[] {
  return db
    .prepare(
      `SELECT t.*,
              t.price_per_share * COALESCE(fx.usd_per_unit, 1) AS price_per_share,
              t.amount * COALESCE(fx.usd_per_unit, 1) AS amount,
              s.symbol, s.name AS security_name, a.name AS account_name,
              s.security_type, s.option_type, s.underlying_symbol,
              s.strike_price, s.expiration_date
      FROM transactions t
      LEFT JOIN securities s ON s.id = t.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      JOIN accounts a ON a.id = t.account_id
      WHERE t.security_id = ?
      ORDER BY t.trade_date DESC
      LIMIT ?`
    )
    .all(securityId, limit) as SecurityDetailTransaction[];
}

/**
 * Get option transactions whose underlying is this stock. Lets the Security
 * Detail page for e.g. APP surface the user's APP calls/puts alongside the
 * stock's own transactions.
 *
 * Dual match logic: historical IBKR-imported options often have a NULL
 * `underlying_symbol` — their ticker lives only in the symbol prefix
 * (e.g. "HOOD 03JUL25 89 C" or the OCC-padded "HOOD  250620C00043000").
 * The symbol-prefix LIKE (`ticker + ' %'`) picks those up. The required
 * space after the ticker prevents cross-ticker false matches (ticker "HO"
 * won't match "HOOD ..." because position 3 is 'O', not a space).
 */
export function getRelatedOptionTransactions(
  db: Database.Database,
  underlyingSymbol: string,
  limit: number = 100
): SecurityDetailTransaction[] {
  return db
    .prepare(
      `SELECT t.*, s.symbol, s.name AS security_name, a.name AS account_name,
              s.security_type, s.option_type, s.underlying_symbol,
              s.strike_price, s.expiration_date
       FROM transactions t
       JOIN securities s ON s.id = t.security_id
       JOIN accounts a ON a.id = t.account_id
       WHERE LOWER(s.security_type) = 'option'
         AND (
           UPPER(s.underlying_symbol) = UPPER(?)
           OR UPPER(s.symbol) LIKE UPPER(?) || ' %'
         )
       ORDER BY t.trade_date DESC
       LIMIT ?`
    )
    .all(underlyingSymbol, underlyingSymbol, limit) as SecurityDetailTransaction[];
}

/**
 * Get factor exposure for a security.
 * Falls back to underlying security's factors for options.
 */
export function getFactorsForSecurity(
  db: Database.Database,
  securityId: number
): SecurityFactor | null {
  // Try direct factor first, then underlying's factors for options
  const row = db
    .prepare(
      `SELECT
        COALESCE(sf.security_id, sf_u.security_id) AS security_id,
        COALESCE(sf.interest_rate_sensitive, sf_u.interest_rate_sensitive) AS interest_rate_sensitive,
        COALESCE(sf.growth_vs_value, sf_u.growth_vs_value) AS growth_vs_value,
        COALESCE(sf.cyclical, sf_u.cyclical) AS cyclical,
        COALESCE(sf.international_exposure, sf_u.international_exposure) AS international_exposure,
        COALESCE(sf.geopolitical_onshoring, sf_u.geopolitical_onshoring) AS geopolitical_onshoring,
        COALESCE(sf.tariff_exposure, sf_u.tariff_exposure) AS tariff_exposure,
        COALESCE(sf.ai_exposure, sf_u.ai_exposure) AS ai_exposure,
        COALESCE(sf.crypto_adjacent, sf_u.crypto_adjacent) AS crypto_adjacent,
        COALESCE(sf.regulatory_risk, sf_u.regulatory_risk) AS regulatory_risk,
        COALESCE(sf.factor_source, sf_u.factor_source) AS factor_source,
        COALESCE(sf.updated_at, sf_u.updated_at) AS updated_at
      FROM securities s
      LEFT JOIN security_factors sf ON sf.security_id = s.id
      LEFT JOIN securities s_u ON s_u.symbol = s.underlying_symbol
      LEFT JOIN security_factors sf_u ON sf_u.security_id = s_u.id
      WHERE s.id = ?
      LIMIT 1`
    )
    .get(securityId) as SecurityFactor | undefined;

  // If no factor data exists at all, return null
  if (!row || !row.security_id) return null;
  return row;
}

/**
 * Collect "quote-strip" KPIs for the Security Detail Terminal panel:
 * open, day high/low, volume, 52-week range, and ATR(14). All derived
 * from the stored daily OHLCV bars — no external fetch.
 *
 * Returns null when the security has no daily bars at all (option contracts,
 * newly-tracked symbols before first backfill). Returns partial values when
 * some pieces are available and others aren't (e.g. <15 bars → atr14 = null
 * but everything else populated).
 */
export function getKpisForSecurity(
  db: Database.Database,
  securityId: number,
): SecurityKpis | null {
  const latest = getLatestDailyBar(db, securityId);
  if (!latest) return null;

  const range = get52WeekRange(db, securityId);

  // 52-week range: fresher source wins. get52WeekRange anchors its trailing
  // window to the latest BAR date, so months-stale bars back-shift the window
  // and re-include lows/highs that rolled out of the true 52-week window
  // (HOOD showed a 15-month-old low while QuoteStats' IBKR quote was right).
  // The quote goes stale as a whole but never shifts its window.
  const quote = getSecurityQuote(db, securityId);
  let week52High = range?.high ?? null;
  let week52Low = range?.low ?? null;
  let week52AsOf = range?.endDate ?? null;
  if (
    quote &&
    quote.week52_high != null &&
    quote.week52_low != null &&
    (range == null || quote.as_of_date >= range.endDate)
  ) {
    week52High = quote.week52_high;
    week52Low = quote.week52_low;
    week52AsOf = quote.as_of_date;
  }

  // ATR needs consecutive bars with prev-close. 30 is enough for a stable
  // Wilder-smoothed 14-period ATR and cheap to read.
  const recentBars = getOhlcvBars(db, securityId, "1 day", { limit: undefined })
    .slice(-30);
  let atr14: number | null = null;
  if (recentBars.length >= 15) {
    const ohlcBars: OhlcBar[] = recentBars.map((b) => ({
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    const series = computeATR(ohlcBars, 14);
    if (series.length > 0) atr14 = series[series.length - 1].value;
  }

  return {
    asOfDate: latest.date,
    open: latest.open,
    dayHigh: latest.high,
    dayLow: latest.low,
    volume: latest.volume,
    week52High,
    week52Low,
    week52AsOf,
    atr14,
  };
}

/**
 * Get AI trade grades for a specific security from trade_roundtrips.
 * Returns most recent grades (up to 10) with the review period they came from.
 */
export function getTradeGradesBySecurity(
  db: Database.Database,
  securityId: number
): TradeGradeEntry[] {
  // SELECT *-style: include both new (post-migration 047) and legacy columns
  // so readers can fall back when querying pre-migration rows.
  // Detect the new column at runtime — in-memory test DBs may not have it.
  const hasAssessmentCol = db
    .prepare(
      "SELECT COUNT(*) as cnt FROM pragma_table_info('trade_roundtrips') WHERE name = 'assessment'"
    )
    .get() as { cnt: number };

  const assessmentSelect =
    hasAssessmentCol.cnt > 0
      ? "tr.assessment, tr.what_went_well, tr.what_went_wrong,"
      : "NULL AS assessment, tr.what_went_well, tr.what_went_wrong,";

  return db
    .prepare(
      `SELECT
        tr.grade, tr.entry_date, tr.exit_date,
        tr.realized_pnl, tr.return_pct, tr.holding_days,
        ${assessmentSelect}
        tr.entry_thesis, tr.exit_assessment,
        rv.period_start AS review_period
      FROM trade_roundtrips tr
      JOIN trade_reviews rv ON rv.id = tr.review_id
      WHERE tr.security_id = ?
      ORDER BY tr.exit_date DESC
      LIMIT 10`
    )
    .all(securityId) as TradeGradeEntry[];
}

// ─── Aggregator ────────────────────────────────────────────────

/**
 * Load all data needed for the Security Detail page in one call.
 * Calls individual queries internally, following the project's DI pattern.
 */
export function getSecurityDetail(
  db: Database.Database,
  securityId: number
): SecurityDetailData | null {
  const security = getSecurityById(db, securityId);
  if (!security) return null;

  const price = getLatestPriceForSecurity(db, securityId);
  const kpis = getKpisForSecurity(db, securityId);
  const positions = getHoldingsBySecurity(db, securityId);
  const openTaxLots = getOpenTaxLotsBySecurity(db, securityId);
  const closedSales = getClosedSalesBySecurity(db, securityId);
  const recentTransactions = getTransactionsBySecurity(db, securityId);
  // Related options: only when the current security is a stock (or unknown) —
  // option pages don't cross-link to sibling strikes.
  const isOption = (security.security_type ?? "").toLowerCase() === "option";
  const relatedOptionTransactions =
    !isOption && security.symbol
      ? getRelatedOptionTransactions(db, security.symbol)
      : [];
  const notes = getNotesForSecurity(db, securityId);
  const factors = getFactorsForSecurity(db, securityId);
  const transcripts = getTranscriptsForSecurity(db, securityId);
  const tradeGrades = getTradeGradesBySecurity(db, securityId);

  // Research feed mentions
  let researchMentions: ResearchMention[] = [];
  try {
    researchMentions = getArticlesForSecurity(db, securityId, 5);
  } catch {
    // Table may not exist yet (pre-migration 019)
  }

  // Upcoming events: filter to future events for this security
  const today = new Date().toISOString().slice(0, 10);
  const upcomingEvents = getUpcomingEvents(db, {
    securityId: security.id,
    startDate: today,
    limit: 10,
  });

  // Aggregate position totals
  const totalValue = positions.reduce((sum, p) => sum + (p.current_value ?? 0), 0);
  const totalCostBasis = positions.reduce((sum, p) => sum + (p.cost_basis ?? 0), 0);
  const totalUnrealizedGain = positions.reduce(
    (sum, p) => sum + (p.unrealized_gain ?? 0),
    0
  );

  return {
    security,
    price,
    kpis,
    positions,
    totalValue,
    totalCostBasis,
    totalUnrealizedGain,
    openTaxLots,
    closedSales,
    recentTransactions,
    relatedOptionTransactions,
    notes,
    upcomingEvents,
    factors,
    transcripts,
    tradeGrades,
    researchMentions,
    usdPerUnit: getUsdPerUnit(db, security.currency ?? "USD"),
  };
}
