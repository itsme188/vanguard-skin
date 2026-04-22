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
import { getArticlesForSecurity, type ResearchMention } from "@/lib/queries/research";

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

export interface SecurityDetailData {
  security: Security;
  price: SecurityPriceInfo | null;
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
}

export interface TradeGradeEntry {
  grade: string | null;
  entry_date: string;
  exit_date: string;
  realized_pnl: number;
  return_pct: number;
  holding_days: number;
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
        h.quantity, h.cost_basis, h.as_of_date,
        s.security_type, COALESCE(s.multiplier, 1) AS multiplier,
        p.close_price AS current_price,
        CASE WHEN p.close_price IS NOT NULL
          THEN ${adjustedMarketValueSQL("h.quantity", "p.close_price", "s.security_type", "s.multiplier")}
          ELSE NULL END AS current_value,
        CASE WHEN p.close_price IS NOT NULL AND h.cost_basis IS NOT NULL
          THEN ${adjustedMarketValueSQL("h.quantity", "p.close_price", "s.security_type", "s.multiplier")} - h.cost_basis
          ELSE NULL END AS unrealized_gain
      FROM holdings h
      JOIN accounts a ON a.id = h.account_id
      JOIN securities s ON s.id = h.security_id
      LEFT JOIN prices p ON p.security_id = h.security_id
        AND p.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = h.security_id)
      WHERE h.security_id = ?
        AND h.quantity > 0
        AND h.as_of_date = (
          SELECT MAX(h2.as_of_date) FROM holdings h2
          WHERE h2.account_id = h.account_id AND h2.security_id = ?
        )
      ORDER BY a.name`
    )
    .all(securityId, securityId) as SecurityPosition[];
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
 */
export function getTransactionsBySecurity(
  db: Database.Database,
  securityId: number,
  limit: number = 100
): SecurityDetailTransaction[] {
  return db
    .prepare(
      `SELECT t.*, s.symbol, s.name AS security_name, a.name AS account_name,
              s.security_type, s.option_type, s.underlying_symbol,
              s.strike_price, s.expiration_date
      FROM transactions t
      LEFT JOIN securities s ON s.id = t.security_id
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
         AND UPPER(s.underlying_symbol) = UPPER(?)
       ORDER BY t.trade_date DESC
       LIMIT ?`
    )
    .all(underlyingSymbol, limit) as SecurityDetailTransaction[];
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
 * Get AI trade grades for a specific security from trade_roundtrips.
 * Returns most recent grades (up to 10) with the review period they came from.
 */
export function getTradeGradesBySecurity(
  db: Database.Database,
  securityId: number
): TradeGradeEntry[] {
  return db
    .prepare(
      `SELECT
        tr.grade, tr.entry_date, tr.exit_date,
        tr.realized_pnl, tr.return_pct, tr.holding_days,
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
  };
}
