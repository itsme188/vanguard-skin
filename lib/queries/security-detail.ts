import { getExpiredOptionLotsAwaitingClose, getOpenTaxLots } from "@/lib/queries/tax-lots";
import { getStaleTradeReviewIds } from "@/lib/queries/trade-review-pairings";
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
import { adjustedMarketValueSQL, scaledCostBasisFallbackSQL } from "@/lib/valuation";
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
import { todayET } from "@/lib/calendar/date-utils";
import { liveOptionExpirationSql } from "@/lib/compute/option-expiry";
// One predicate for the row cells and the TOTAL row: a basis of NULL or
// exactly 0 is unknown.
import { hasKnownBasis as hasKnownPositionBasis } from "@/lib/compute/known-basis";

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
  /**
   * The page's one 52-week range (getWeek52Range). The same object feeds
   * `kpis.week52*`; it is carried on its own because `kpis` is null for a
   * security with no daily bars, where a quote-only range still exists.
   */
  week52: Week52Range | null;
  positions: SecurityPosition[];
  totalValue: number;
  /** null when every constituent position's cost basis is unknown */
  totalCostBasis: number | null;
  /** null when every constituent position's gain is unknown */
  totalUnrealizedGain: number | null;
  /** Total gain over GROSS basis — see computePositionTotals. */
  totalGainRatio: number | null;
  /** Market value of the positions that are in the total gain. */
  gainCoveredValue: number | null;
  /** Positions left out of total cost basis, gain and %: basis unknown. */
  positionsWithoutBasis: PositionWithoutBasis[];
  /** Accounts with open lots and no current position — see computeLotsWithoutPosition. */
  lotsWithoutPosition: LotsWithoutPosition[];
  /** What the open lots carry for each unknown-basis position — see computeUnknownBasisLotNotes. */
  unknownBasisLotNotes: UnknownBasisLotNote[];
  /** Expired contract still on the latest holdings snapshot — see getExpiredOptionSnapshotRows. */
  expiredOptionSnapshotRows: ExpiredOptionSnapshotRow[];
  openTaxLots: TaxLotWithSecurity[];
  expiredOptionLotsAwaitingClose: TaxLotWithSecurity[];
  closedSales: TaxLotSaleWithDetails[];
  /** Every closed sale for the security; closedSales is capped at 20. */
  closedSalesTotal: number;
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
   * `price`, `kpis` and `week52` stay NATIVE — the chart price-line and ATR/52wk
   * ratios need native units — so $-display sites multiply by this factor
   * at render time (MarketDataPanel / QuoteStats).
   */
  usdPerUnit: number;
}

export interface TradeGradeEntry {
  pairings_stale?: boolean;
  grade: string | null;
  entry_date: string;
  exit_date: string;
  realized_pnl: number;
  return_pct: number;
  holding_days: number;
  // Column semantics per migration 047 (legacy scrambled columns dropped in 075).
  assessment: string | null;
  what_went_well: string | null;
  what_went_wrong: string | null;
  review_period: string;
  /**
   * How many stored trade_roundtrips rows this card covers (1 when the card is
   * a single roundtrip). The trade-review generator writes ONE AI verdict per
   * (symbol, exit_date) and the storage step copies the grade letter plus all
   * three prose fields onto every roundtrip row sharing that key, so the copies
   * are folded into one card here — see getTradeGradesBySecurity.
   */
  coversRoundtrips: number;
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
 * Latest per (account, security) via latestHoldingsPredicate.
 */
export function getHoldingsBySecurity(
  db: Database.Database,
  securityId: number
): SecurityPosition[] {
  // Cost basis fallback — see getAllHoldings (lib/queries/holdings.ts) for the
  // Plaid-NULL rationale. Scaled per-share to the current quantity and signed
  // like the position (scaledCostBasisFallbackSQL header has the short case).
  // The helper already treats a stored 0 as unknown (it falls through to the
  // rescue and, failing that, resolves NULL); the extra NULLIF on the gain
  // gate below is the same belt-and-braces guard lib/queries/holdings.ts
  // carries — the convention that a cost_basis of exactly 0 means "unknown,"
  // not "free," lives there and is mirrored by AllHoldingsTable's
  // hasKnownBasis at the render layer.
  const costBasisExpr = scaledCostBasisFallbackSQL("h", "h3");

  return db
    .prepare(
      `SELECT
        h.account_id, a.name AS account_name,
        h.quantity, ${costBasisExpr} * COALESCE(fx.usd_per_unit, 1) AS cost_basis, h.as_of_date,
        s.security_type, COALESCE(s.multiplier, 1) AS multiplier,
        p.close_price AS current_price,
        CASE WHEN p.close_price IS NOT NULL
          THEN ${adjustedMarketValueSQL("h.quantity", "p.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")}
          ELSE NULL END AS current_value,
        CASE WHEN p.close_price IS NOT NULL AND NULLIF(${costBasisExpr}, 0) IS NOT NULL
          THEN ${adjustedMarketValueSQL("h.quantity", "p.close_price", "s.security_type", "s.multiplier", "COALESCE(fx.usd_per_unit, 1)")} - (${costBasisExpr} * COALESCE(fx.usd_per_unit, 1))
          ELSE NULL END AS unrealized_gain
      FROM holdings h
      JOIN accounts a ON a.id = h.account_id
      JOIN securities s ON s.id = h.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      LEFT JOIN prices p ON p.security_id = h.security_id
        AND p.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = h.security_id)
      WHERE h.security_id = ?
        AND ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true })}
        -- Drop options past expiration on the ET calendar — the same cutoff
        -- lib/queries/holdings.ts and today-holdings.ts apply via the shared
        -- liveOptionExpirationSql (the purge's 1-day grace can leave
        -- yesterday's contract in the table).
        AND ${liveOptionExpirationSql("s")}
      ORDER BY a.name`
    )
    .all(securityId) as SecurityPosition[];
}

/**
 * Get open tax lots for a specific security.
 */
export function getOpenTaxLotsBySecurity(db: Database.Database, securityId: number): TaxLotWithSecurity[] {
  return getOpenTaxLots(db, securityId);
}

export function getExpiredOptionLotsAwaitingCloseBySecurity(
  db: Database.Database,
  securityId: number
): TaxLotWithSecurity[] {
  return getExpiredOptionLotsAwaitingClose(db, { securityId });
}

/**
 * FROM..WHERE shared by getClosedSalesBySecurity (the capped list) and
 * countClosedSalesBySecurity (the header total) so the "Recent Sales" count
 * and its rows can never disagree on which sales exist. One bound param:
 * the security id.
 */
const CLOSED_SALES_FROM_WHERE = `FROM tax_lot_sales tls
      JOIN tax_lots tl ON tl.id = tls.tax_lot_id
      JOIN accounts a ON a.id = tl.account_id
      JOIN securities s ON s.id = tl.security_id
      LEFT JOIN fx_rates fx ON fx.currency = s.currency
      JOIN transactions t ON t.id = tls.sale_transaction_id
      WHERE tl.security_id = ?`;

/**
 * Get closed tax lot sales for a specific security.
 *
 * sale_price / proceeds / cost_basis_allocated / realized_gain_loss /
 * acquisition_price are stored in the security's NATIVE currency (FX
 * convention) — the fx_rates join converts them to USD for this page's
 * "Recent Sales" card, matching the sibling getTransactionsBySecurity /
 * getHoldingsBySecurity queries on the same page. Unlike this function,
 * getClosedTaxLotSales (lib/queries/tax-lots.ts, backs the Tax Lots page)
 * deliberately stays native with a currency label — do not convert there.
 */
export function getClosedSalesBySecurity(
  db: Database.Database,
  securityId: number,
  limit: number = 20
): TaxLotSaleWithDetails[] {
  const rows = db
    .prepare(
      `SELECT
        tls.id, a.name AS account_name, tl.account_id,
        s.symbol, s.name AS security_name,
        tl.acquisition_date, tls.sale_date,
        tls.quantity_sold,
        tl.acquisition_price * COALESCE(fx.usd_per_unit, 1) AS acquisition_price,
        tls.sale_price * COALESCE(fx.usd_per_unit, 1) AS sale_price,
        tls.proceeds * COALESCE(fx.usd_per_unit, 1) AS proceeds,
        tls.cost_basis_allocated * COALESCE(fx.usd_per_unit, 1) AS cost_basis_allocated,
        tls.realized_gain_loss * COALESCE(fx.usd_per_unit, 1) AS realized_gain_loss,
        tls.is_long_term, tls.holding_period_days,
        (t.type = 'RECONCILE_CLOSE') AS is_synthetic_close
      ${CLOSED_SALES_FROM_WHERE}
      ORDER BY tls.sale_date DESC
      LIMIT ?`
    )
    .all(securityId, limit) as Array<
    Omit<TaxLotSaleWithDetails, "is_synthetic_close"> & { is_synthetic_close: number }
  >;
  return rows.map((r) => ({ ...r, is_synthetic_close: Boolean(r.is_synthetic_close) }));
}

/**
 * Total closed sales for a security — same predicate as
 * getClosedSalesBySecurity, uncapped. Feeds the hub's "Recent Sales · N of M"
 * header so a capped list never reads as the full history.
 */
export function countClosedSalesBySecurity(db: Database.Database, securityId: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n ${CLOSED_SALES_FROM_WHERE}`)
    .get(securityId) as { n: number };
  return row.n;
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

  // One arbitrated 52-week range for the whole page — see getWeek52Range.
  const week52 = getWeek52Range(db, securityId);
  const week52High = week52?.high ?? null;
  const week52Low = week52?.low ?? null;
  const week52AsOf = week52?.asOf ?? null;

  // ATR needs consecutive bars with prev-close. 30 is enough for a stable
  // Wilder-smoothed 14-period ATR and cheap to read.
  //
  // Gap rule (2026-10-05): getOhlcvBars reads through PRICED_BAR_SQL, so a
  // legacy zero bar is ABSENT from this series — never forward-filled. The
  // true range of the bar after it is measured against the last PRICED
  // close, the same way a market holiday is handled. Both prices in that
  // pair are real, so the range is a real (two-session) move, and ATR equals
  // what it would be had the row never been stored. Pinned by
  // tests/queries/security-kpis-zero-bar.test.ts.
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

export interface Week52Range {
  high: number;
  low: number;
  /** As-of date of the source that won (latest priced bar, or the quote). */
  asOf: string;
}

/**
 * THE 52-week range for a security: one value object for every module on the
 * hub (the stats strip through getKpisForSecurity, and QuoteStats). The two
 * used to read different sources — the strip took this arbitration, QuoteStats
 * took the stored quote alone — and printed two lows and two highs on one page
 * wherever the cached bars were fresher than the quote.
 *
 * Fresher source wins. get52WeekRange anchors its trailing window to the
 * latest BAR date, so months-stale bars back-shift the window and re-include
 * lows/highs that rolled out of the true 52-week window (HOOD showed a
 * 15-month-old low while the IBKR quote was right). The quote goes stale as a
 * whole but never shifts its window, so it wins only when it is at least as
 * fresh as the bars — or when there are no usable bars at all.
 *
 * Native currency, like the bars and the quote. Null when neither source has
 * a range.
 */
export function getWeek52Range(db: Database.Database, securityId: number): Week52Range | null {
  const range = get52WeekRange(db, securityId);
  const quote = getSecurityQuote(db, securityId);
  if (
    quote &&
    quote.week52_high != null &&
    quote.week52_low != null &&
    (range == null || quote.as_of_date >= range.endDate)
  ) {
    return { high: quote.week52_high, low: quote.week52_low, asOf: quote.as_of_date };
  }
  return range ? { high: range.high, low: range.low, asOf: range.endDate } : null;
}

/**
 * Row shape read from trade_roundtrips before grouping. `entry_cost` never
 * leaves this module — it is only the weight for the blended return.
 */
interface TradeGradeRow {
  review_id: number;
  grade: string | null;
  entry_date: string;
  exit_date: string;
  entry_cost: number | null;
  realized_pnl: number;
  return_pct: number;
  holding_days: number;
  assessment: string | null;
  what_went_well: string | null;
  what_went_wrong: string | null;
  review_period: string;
}

/**
 * Get AI trade grades for a specific security from trade_roundtrips.
 * Returns the most recent grades (up to 10 CARDS, not 10 rows).
 *
 * The trade-review generator produces ONE AI verdict per (symbol, exit_date)
 * and the storage step copies the grade letter plus all three prose fields
 * (assessment / what_went_well / what_went_wrong) onto EVERY trade_roundtrips
 * row sharing that key. Rendering each copy as its own card attributed the
 * group's verdict to individual legs — a +$62 / +1.0% QCOM roundtrip showed
 * an "F" captioned "Worst trade of the month … trim at -22.3%".
 *
 * So rows sharing (review_id, exit_date, grade, assessment, what_went_well,
 * what_went_wrong) collapse into ONE card. The grouping key carries the grade
 * and both prose fields as well as the assessment: assessment alone is NULL on
 * ungraded roundtrips, and a NULL key would merge legs whose grades differ.
 *
 * Aggregation over a group:
 *  - realized_pnl  — summed.
 *  - return_pct    — COST-WEIGHTED: SUM(realized_pnl) / SUM(entry_cost) × 100.
 *                    entry_cost is a stored column and is exactly the
 *                    denominator the generator used per leg
 *                    (lib/compute/trade-roundtrips.ts), so the blend is the
 *                    same number a single roundtrip over the whole group would
 *                    have carried. A group whose entry costs net to zero
 *                    (long + short legs) reports 0, matching the generator's
 *                    own divide-by-zero convention. Single-row cards keep the
 *                    stored return_pct untouched (no float drift).
 *  - entry_date / holding_days — from the EARLIEST entry leg (the card spans
 *                    from the first entry to the shared exit).
 *  - prose + grade — carried once.
 *  - coversRoundtrips — leg count; the UI captions any card above 1 so the
 *                    grade is never read as a verdict on a single leg.
 *
 * ORDER BY exit_date DESC / LIMIT 10 semantics are preserved but applied AFTER
 * grouping: 10 cards, newest exit first.
 */
export function getTradeGradesBySecurity(
  db: Database.Database,
  securityId: number
): TradeGradeEntry[] {
  const rows = db
    .prepare(
      `SELECT
        tr.review_id, tr.grade, tr.entry_date, tr.exit_date,
        tr.entry_cost, tr.realized_pnl, tr.return_pct, tr.holding_days,
        tr.assessment, tr.what_went_well, tr.what_went_wrong,
        rv.period_start AS review_period
      FROM trade_roundtrips tr
      JOIN trade_reviews rv ON rv.id = tr.review_id
      WHERE tr.security_id = ?
      ORDER BY tr.exit_date DESC, tr.id ASC`
    )
    .all(securityId) as TradeGradeRow[];

  const staleReviews = getStaleTradeReviewIds(db, rows.map((row) => row.review_id));

  // Rows arrive exit_date DESC and every row in a group shares that exit_date,
  // so first-seen Map order is already newest-exit-first — no re-sort needed.
  const groups = new Map<string, { entry: TradeGradeEntry; costSum: number }>();

  for (const row of rows) {
    const key = JSON.stringify([
      row.review_id,
      row.exit_date,
      row.grade,
      row.assessment,
      row.what_went_well,
      row.what_went_wrong,
    ]);
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        entry: {
          grade: row.grade,
          pairings_stale: staleReviews.has(row.review_id),
          entry_date: row.entry_date,
          exit_date: row.exit_date,
          realized_pnl: row.realized_pnl,
          return_pct: row.return_pct,
          holding_days: row.holding_days,
          assessment: row.assessment,
          what_went_well: row.what_went_well,
          what_went_wrong: row.what_went_wrong,
          review_period: row.review_period,
          coversRoundtrips: 1,
        },
        costSum: row.entry_cost ?? 0,
      });
      continue;
    }

    existing.entry.realized_pnl += row.realized_pnl;
    existing.costSum += row.entry_cost ?? 0;
    existing.entry.coversRoundtrips += 1;
    if (row.entry_date < existing.entry.entry_date) {
      existing.entry.entry_date = row.entry_date;
      existing.entry.holding_days = row.holding_days;
    }
  }

  const cards: TradeGradeEntry[] = [];
  for (const { entry, costSum } of groups.values()) {
    if (entry.coversRoundtrips > 1) {
      entry.return_pct = costSum !== 0 ? (entry.realized_pnl / costSum) * 100 : 0;
    }
    cards.push(entry);
    if (cards.length === 10) break;
  }
  return cards;
}

// ─── Hub display helpers (pure) ────────────────────────────────

const ASSET_CLASS_LABELS: Record<string, string> = {
  stk: "Equity",
  equity: "Equity",
  opt: "Option",
  option: "Option",
};

/**
 * Display label for securities.asset_class. The column holds whatever the
 * importer wrote: IBKR's contract code ("STK", "OPT") on some rows and
 * "equity" / "option" on others, so two like instruments were labelled two
 * ways. A value with no mapping is shown as stored. Display only — the column
 * is not rewritten.
 */
export function assetClassLabel(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  return ASSET_CLASS_LABELS[value.toLowerCase()] ?? value;
}

/** "Jane Doe (Chief Executive Officer):" — a speaker turn in a call excerpt. */
// A name word is a capital plus word characters, or a bare initial ("Q.") —
// never a word ending in a full stop, which is the end of the sentence before.
const SPEAKER_TAG_RE =
  /(?:^|\s)([A-Z](?:[\w'’-]*|\.)(?: [A-Z](?:[\w'’-]*|\.)){0,3}) \([^)]{1,80}\):/g;

/**
 * Plain-text preview for a hub transcript card's collapsed state.
 *
 * `summary` is either an AI desk note in markdown or an extractive excerpt of
 * the call (lib/transcripts/presentation.ts). Clamping the raw string showed
 * "# Title **Guidance** …" for the first and the operator's dial-in
 * instructions for the second. This drops heading lines, strips the markdown
 * markers, and starts a call excerpt at the first speaker who is not the
 * operator. If nothing is left, the cleaned text is returned as it stands, so
 * a card is never blank while a summary exists.
 */
export function transcriptPreviewText(
  summary: string | null | undefined,
  maxChars: number = 400
): string {
  if (!summary) return "";
  const parts: string[] = [];
  let pendingLabel: string | null = null;
  for (const rawLine of summary.split("\n")) {
    const line = rawLine.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^[-*_]{3,}$/.test(line)) continue;
    const body = line.replace(/^(?:[-*+]|\d+\.|>)\s+/, "");
    const text = body.replace(/\*\*|__|`/g, "").trim();
    if (!text) continue;
    // A line that is only a bold label ("**Guidance**") heads the next line.
    if (/^\*\*[^*]+\*\*:?$/.test(body)) {
      pendingLabel = text.replace(/:$/, "");
      continue;
    }
    parts.push(pendingLabel ? `${pendingLabel}: ${text}` : text);
    pendingLabel = null;
  }
  const cleaned = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";

  let preview = cleaned;
  if (/^operator\b/i.test(cleaned)) {
    SPEAKER_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = SPEAKER_TAG_RE.exec(cleaned)) !== null) {
      if (/\boperator$/i.test(match[1])) continue;
      preview = cleaned.slice(match.index).trim();
      break;
    }
  }

  if (preview.length <= maxChars) return preview;
  const cut = preview.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// ─── Position totals ───────────────────────────────────────────

export interface PositionWithoutBasis {
  account_id: number;
  account_name: string;
  quantity: number;
}

export interface PositionTotals {
  /** Market value of every position (a short is negative). */
  totalValue: number;
  /** NET cost basis over the known-basis positions; null when none is known. */
  totalCostBasis: number | null;
  /** Gain over the positions that have one; null when none does. */
  totalUnrealizedGain: number | null;
  /**
   * totalUnrealizedGain divided by GROSS basis: the sum of |cost basis| over
   * exactly the positions that are in the gain. Null when there is no gain or
   * that basis is zero.
   */
  totalGainRatio: number | null;
  /** Market value of the positions that are in the gain; null when none is. */
  gainCoveredValue: number | null;
  /** Positions whose basis is unknown — left out of cost basis, gain and %. */
  positionsWithoutBasis: PositionWithoutBasis[];
}

/**
 * Totals for the hub's POSITIONS table. Pure.
 *
 * Cost basis / gain stay null when EVERY constituent is unknown — summing
 * unknowns as $0 fabricated a "$0 cost, green $0 gain" TOTAL row on
 * all-Plaid-sourced positions. "Unknown" includes a basis of exactly 0
 * (hasKnownBasis, lib/compute/known-basis.ts).
 *
 * Gain % (2026-10-07): a short stores its sale proceeds as a NEGATIVE basis,
 * so a long and a short net to a small basis and gain / net basis printed a
 * percent outside both of its own rows. The denominator is the GROSS basis,
 * and only of the positions whose gain is in the numerator, so the percent is
 * a weighted average of the row percents (each row divides by |basis| too —
 * unrealizedGainRatio in lib/format.ts). The sign follows the gain: a short
 * that fell in price shows a positive percent.
 *
 * Value covers every position while cost basis and gain cover only the ones
 * with a known basis. positionsWithoutBasis and gainCoveredValue let the row
 * say so instead of printing a full value beside a partial basis unmarked.
 */
export function computePositionTotals(positions: SecurityPosition[]): PositionTotals {
  const totalValue = positions.reduce((sum, p) => sum + (p.current_value ?? 0), 0);
  const withBasis = positions.filter(hasKnownPositionBasis);
  const totalCostBasis =
    withBasis.length > 0 ? withBasis.reduce((sum, p) => sum + p.cost_basis!, 0) : null;

  // "In the gain" = has a gain AND a known basis. The query only produces a
  // gain for a known basis; the second test keeps the two sets identical even
  // if a caller hands in a row that breaks that rule.
  const inGain = positions.filter((p) => p.unrealized_gain != null && hasKnownPositionBasis(p));
  const totalUnrealizedGain =
    inGain.length > 0 ? inGain.reduce((sum, p) => sum + p.unrealized_gain!, 0) : null;
  const grossBasis = inGain.reduce((sum, p) => sum + Math.abs(p.cost_basis!), 0);
  const totalGainRatio =
    totalUnrealizedGain !== null && grossBasis > 0 ? totalUnrealizedGain / grossBasis : null;
  const gainCoveredValue =
    inGain.length > 0 ? inGain.reduce((sum, p) => sum + (p.current_value ?? 0), 0) : null;

  const positionsWithoutBasis = positions
    .filter((p) => !hasKnownPositionBasis(p))
    .map((p) => ({ account_id: p.account_id, account_name: p.account_name, quantity: p.quantity }));

  return {
    totalValue,
    totalCostBasis,
    totalUnrealizedGain,
    totalGainRatio,
    gainCoveredValue,
    positionsWithoutBasis,
  };
}

export interface LotsWithoutPosition {
  accountId: number;
  accountName: string;
  lotCount: number;
  /** Sum of quantity_remaining (lots store shorts as a positive quantity). */
  quantity: number;
  shortLotCount: number;
  /**
   * Every lot is "pending statement": the position is flat per live broker
   * data and the statement carrying the closing trade is not imported yet.
   */
  allPendingStatement: boolean;
}

const LOT_DUST = 1e-6;

/**
 * Accounts that still carry open tax lots for this security while the
 * positions list has no row for them (latest holding zero or absent). The hub
 * showed those lots with no Positions section and no explanation. Pure;
 * per-account, like computeLotCoverageGaps, which only looks at accounts that
 * DO have a position row. Float-dust remainders are ignored.
 */
export function computeLotsWithoutPosition(
  positions: Array<{ account_id: number }>,
  openLots: Array<{
    account_id: number;
    account_name: string;
    quantity_remaining: number;
    is_short: number;
    pending_statement: boolean;
  }>
): LotsWithoutPosition[] {
  const held = new Set(positions.map((p) => p.account_id));
  const byAccount = new Map<number, LotsWithoutPosition>();
  for (const lot of openLots) {
    if (held.has(lot.account_id)) continue;
    if (Math.abs(lot.quantity_remaining) <= LOT_DUST) continue;
    const entry = byAccount.get(lot.account_id);
    if (!entry) {
      byAccount.set(lot.account_id, {
        accountId: lot.account_id,
        accountName: lot.account_name,
        lotCount: 1,
        quantity: lot.quantity_remaining,
        shortLotCount: lot.is_short ? 1 : 0,
        allPendingStatement: lot.pending_statement,
      });
      continue;
    }
    entry.lotCount += 1;
    entry.quantity += lot.quantity_remaining;
    if (lot.is_short) entry.shortLotCount += 1;
    entry.allPendingStatement = entry.allPendingStatement && lot.pending_statement;
  }
  return [...byAccount.values()];
}

export interface UnknownBasisLotNote {
  accountId: number;
  accountName: string;
  /** The position quantity whose basis the holdings row does not carry. */
  positionQty: number;
  lotCount: number;
  /** Sum of quantity_remaining over this account's same-side open lots. */
  lotQty: number;
  /** Sum of those lots' cost basis, as the lots table prints it. */
  lotCostBasis: number;
}

/**
 * For each position whose basis is unknown, what the open lots of the same
 * account carry. The POSITIONS row printed a dash for basis and gain while
 * the lots table below it printed both, with nothing tying the two together.
 * The lot figures are only QUOTED: the position row does not adopt them (a
 * carryover lot can itself be suspect). Pure.
 *
 * Only same-side lots count — long lots for a long position, short-sale lots
 * for a short one. An account with none gets no note.
 */
export function computeUnknownBasisLotNotes(
  positionsWithoutBasis: PositionWithoutBasis[],
  openLots: Array<{
    account_id: number;
    quantity_remaining: number;
    is_short: number;
    adjusted_cost_basis: number | null;
  }>
): UnknownBasisLotNote[] {
  const notes: UnknownBasisLotNote[] = [];
  for (const position of positionsWithoutBasis) {
    const wantShort = position.quantity < 0;
    const lots = openLots.filter(
      (lot) =>
        lot.account_id === position.account_id &&
        !!lot.is_short === wantShort &&
        Math.abs(lot.quantity_remaining) > LOT_DUST &&
        lot.adjusted_cost_basis != null
    );
    if (lots.length === 0) continue;
    notes.push({
      accountId: position.account_id,
      accountName: position.account_name,
      positionQty: position.quantity,
      lotCount: lots.length,
      lotQty: lots.reduce((sum, lot) => sum + lot.quantity_remaining, 0),
      lotCostBasis: lots.reduce((sum, lot) => sum + (lot.adjusted_cost_basis ?? 0), 0),
    });
  }
  return notes;
}

export interface ExpiredOptionSnapshotRow {
  account_id: number;
  account_name: string;
  quantity: number;
  as_of_date: string;
}

/**
 * An option contract PAST its expiration that the latest holdings snapshot
 * still lists (non-zero quantity). Every position reader drops such a row
 * (liveOptionExpirationSql), so the hub showed no position at all and told
 * the user to import holdings for a contract the broker still reported. This
 * is the complement of the filter in getHoldingsBySecurity: the same latest
 * row per account, kept only when the contract is no longer live. Empty for
 * a non-option and for a live contract.
 */
export function getExpiredOptionSnapshotRows(
  db: Database.Database,
  securityId: number
): ExpiredOptionSnapshotRow[] {
  return db
    .prepare(
      `SELECT h.account_id, a.name AS account_name, h.quantity, h.as_of_date
       FROM holdings h
       JOIN accounts a ON a.id = h.account_id
       JOIN securities s ON s.id = h.security_id
       WHERE h.security_id = ?
         AND ${latestHoldingsPredicate({ keyBy: "account_security", includeShorts: true })}
         AND LOWER(COALESCE(s.security_type, '')) = 'option'
         AND NOT ${liveOptionExpirationSql("s")}
       ORDER BY a.name`
    )
    .all(securityId) as ExpiredOptionSnapshotRow[];
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
  const expiredOptionLotsAwaitingClose = getExpiredOptionLotsAwaitingCloseBySecurity(db, securityId);
  const closedSales = getClosedSalesBySecurity(db, securityId);
  const closedSalesTotal = countClosedSalesBySecurity(db, securityId);
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
  const today = todayET();
  const upcomingEvents = getUpcomingEvents(db, {
    securityId: security.id,
    startDate: today,
    limit: 10,
  });

  const totals = computePositionTotals(positions);
  const lotsWithoutPosition = computeLotsWithoutPosition(positions, openTaxLots);

  return {
    security,
    price,
    kpis,
    week52: getWeek52Range(db, securityId),
    positions,
    totalValue: totals.totalValue,
    totalCostBasis: totals.totalCostBasis,
    totalUnrealizedGain: totals.totalUnrealizedGain,
    totalGainRatio: totals.totalGainRatio,
    gainCoveredValue: totals.gainCoveredValue,
    positionsWithoutBasis: totals.positionsWithoutBasis,
    lotsWithoutPosition,
    unknownBasisLotNotes: computeUnknownBasisLotNotes(totals.positionsWithoutBasis, openTaxLots),
    expiredOptionSnapshotRows: getExpiredOptionSnapshotRows(db, securityId),
    openTaxLots,
    expiredOptionLotsAwaitingClose,
    closedSales,
    closedSalesTotal,
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
