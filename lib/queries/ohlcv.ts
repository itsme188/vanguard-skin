import type Database from "better-sqlite3";
import type { OhlcvBar } from "@/lib/tws/types";
import { adjustedMarketValueSQL } from "@/lib/valuation";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";

/**
 * Shared read-side corrupt-bar guard — the SQL counterpart of `isSaneBar` in
 * `lib/mutations/ohlcv.ts::upsertOhlcvBars`. That write guard has only
 * rejected NEW bars since 2026-09-06, so bars stored before that date can
 * still carry the defect (real open/high, low = 0 AND close = 0; six such
 * rows are known to exist for one security as of 2026-09-06).
 *
 * NOT an exact mirror, and cannot be: `isSaneBar` also demands
 * `Number.isFinite` on each leg, which SQL has no way to express (SQLite
 * stores an IEEE Infinity/NaN as a REAL that compares `> 0` or as NULL
 * respectively). This predicate covers the positive-OHLC + `high >= low`
 * half — the only half the legacy zero-priced defect class needs. A
 * hypothetical stored `+Infinity` high would still pass here; nothing has
 * ever been observed to write one, and the write guard now blocks it.
 * It is the strictly stronger form of `get52WeekRange`'s own inline
 * predicate (`low > 0 AND high > 0`) — `get52WeekRange` deliberately keeps
 * its own shipped, tested aggregate form; do not replace it with this
 * constant.
 *
 * Applied to the three readers here that hand bars straight to a consumer
 * (candlestick series, "most recent bar" displays, recent-window slices):
 * `getOhlcvBars`, `getRecentOhlcvBars`, `getLatestDailyBar`. Deliberately
 * NOT applied to `getLatestOhlcvDate` — see the comment there.
 *
 * Exported (2026-09-11) because two readers OUTSIDE this module read
 * `ohlcv_bars` and feed the result into a number the desk acts on:
 * `lib/alerts/resolve-level-price.ts::computeMovingAverage` (a zero close
 * drags an SMA/EMA level and changes whether an alert fires) and
 * `lib/trade-review/market-context.ts` (a zero low becomes `periodLow: 0`
 * in the AI's prompt). Assumes an `ohlcv_bars` row in the enclosing query's
 * scope, unaliased or aliased so the bare column names resolve.
 */
export const PRICED_BAR_SQL =
  "(open > 0 AND high > 0 AND low > 0 AND close > 0 AND high >= low)";

/**
 * Get stored OHLCV bars for a security, ordered by date ascending.
 * Returns data shaped for LightweightCharts CandlestickData.
 */
export function getOhlcvBars(
  db: Database.Database,
  securityId: number,
  barSize: string = "1 day",
  options?: { startDate?: string; endDate?: string; limit?: number },
): OhlcvBar[] {
  let sql = `
    SELECT bar_date as date, open, high, low, close, volume
    FROM ohlcv_bars
    WHERE security_id = ? AND bar_size = ? AND ${PRICED_BAR_SQL}
  `;
  const params: (number | string)[] = [securityId, barSize];

  if (options?.startDate) {
    sql += " AND bar_date >= ?";
    params.push(options.startDate);
  }
  if (options?.endDate) {
    sql += " AND bar_date <= ?";
    params.push(options.endDate);
  }

  sql += " ORDER BY bar_date ASC";

  if (options?.limit) {
    sql += " LIMIT ?";
    params.push(options.limit);
  }

  return db.prepare(sql).all(...params) as OhlcvBar[];
}

/**
 * Get the NEWEST `limit` bars for a security, still returned oldest-first
 * (ascending `bar_date`) — the shape every pivot detector / narrator
 * consumer expects. `getOhlcvBars({ limit })` above sorts ASC and THEN
 * limits, which takes the OLDEST rows; that's correct for its other callers
 * (a bounded-from-a-start-date read), but wrong for "give me a recent
 * lookback window" — a security with more stored bars than `limit` would
 * have its most recent months silently dropped. Implemented as an inner
 * DESC-LIMIT subquery re-sorted ASC in SQL so both the trim and the final
 * order happen in one prepared statement.
 *
 * The priced-bar guard (`PRICED_BAR_SQL`) is applied INSIDE the DESC-LIMIT
 * subquery, not on the outer query — filtering after the LIMIT would leave
 * a caller with fewer than `limit` bars whenever a corrupt bar fell in the
 * window; filtering before it means a corrupt bar simply doesn't consume
 * one of the `limit` slots, so callers still get the newest `limit` REAL
 * bars.
 */
export function getRecentOhlcvBars(
  db: Database.Database,
  securityId: number,
  barSize: string = "1 day",
  limit: number = 500,
): OhlcvBar[] {
  return db
    .prepare(
      `SELECT date, open, high, low, close, volume FROM (
         SELECT bar_date as date, open, high, low, close, volume
         FROM ohlcv_bars
         WHERE security_id = ? AND bar_size = ? AND ${PRICED_BAR_SQL}
         ORDER BY bar_date DESC
         LIMIT ?
       ) ORDER BY date ASC`,
    )
    .all(securityId, barSize, limit) as OhlcvBar[];
}

/**
 * Get the latest bar date for a security+bar_size combo.
 * Used for incremental fetching (only fetch the gap).
 *
 * Deliberately NOT filtered by `PRICED_BAR_SQL`. This is the incremental-
 * fetch anchor (`lib/tws/ohlcv.ts::fetchOhlcvBars`, and the freshness check
 * in `app/api/tws/chart/route.ts`) — `upsertOhlcvBars` has rejected corrupt
 * bars on write since 2026-09-06, so a corrupt trailing bar can never be
 * re-stored. If this read were filtered too, the anchor could never advance
 * past a pre-existing trailing corrupt bar, and every chart open would
 * re-request the same already-fetched window from TWS forever. Raw
 * MAX(bar_date) is correct here even though it's wrong for display readers.
 */
export function getLatestOhlcvDate(
  db: Database.Database,
  securityId: number,
  barSize: string = "1 day",
): string | null {
  const row = db
    .prepare(
      "SELECT MAX(bar_date) as latest FROM ohlcv_bars WHERE security_id = ? AND bar_size = ?",
    )
    .get(securityId, barSize) as { latest: string | null } | undefined;
  return row?.latest ?? null;
}

/** Security metadata for the chart security picker. */
export interface ChartableSecurity {
  id: number;
  symbol: string;
  name: string | null;
  security_type: string | null;
  currency: string | null;
}

/**
 * Shared "is this security chartable via TWS" predicate — has an IB
 * contract id, and isn't a mutual fund (no TWS trade data). Single source
 * for both getChartableSecurities and getDefaultChartSecurityId below so
 * the two lists never disagree about what counts as chartable. Assumes a
 * `securities` row aliased `s` in the enclosing query.
 */
const CHARTABLE_PREDICATE_SQL = `s.ib_con_id IS NOT NULL
    AND (s.security_type IS NULL OR LOWER(s.security_type) NOT IN ('mutual_fund', 'mutual fund'))`;

/**
 * Get all securities that have an IB contract ID (chartable via TWS).
 * Excludes mutual funds (no TWS trade data).
 */
export function getChartableSecurities(
  db: Database.Database,
): ChartableSecurity[] {
  return db
    .prepare(
      `SELECT id, symbol, name, security_type, currency
       FROM securities s
       WHERE ${CHARTABLE_PREDICATE_SQL}
       ORDER BY symbol`,
    )
    .all() as ChartableSecurity[];
}

/**
 * Default security for a bare /dashboard/charts visit: the largest
 * CURRENTLY-HELD chartable position, valued in USD.
 *
 * QA finding (charts-landing--defaults-to-closed-foreign-symbol...): the
 * page used to default to `getChartableSecurities()[0]` — alphabetically
 * first — which could land on a closed position (a quantity-0 reconciler
 * tombstone) with no bars at all. "Currently held" is therefore gated by
 * `latestHoldingsPredicate` (per-(account, security) latest row, never a
 * hand-rolled MAX(as_of_date) — see tests/repo/no-handrolled-latest-holdings
 * .test.ts), which already excludes tombstones via its quantity != 0 clause.
 *
 * Valuation mirrors lib/queries/holdings.ts: latest close price per
 * security, FX-converted to USD via fx_rates (native-currency positions
 * are compared on a like-for-like USD basis, not native magnitude), summed
 * across every account that holds the security. A security priced but not
 * chartable (or chartable but unpriced) never wins — only rows that clear
 * BOTH the chartable predicate and have a resolvable price participate.
 *
 * "Largest" means GROSS exposure (ABS per row before summing): a big short
 * position is the position with the most money at stake and wins over a
 * smaller long one — the chart should open on it, not rank it last.
 *
 * OPTIONS ARE EXCLUDED from the ranking (2026-09-11), and only from the
 * ranking: `adjustedMarketValueSQL` multiplies an option row by its ×100
 * contract multiplier, so a handful of contracts can out-notional every
 * equity in the book and make an OCC symbol the surprise landing chart.
 * A landing default should be a name the desk recognises, not the largest
 * notional. Options stay fully chartable on request — the exclusion is
 * added HERE only, never to `CHARTABLE_PREDICATE_SQL`, so
 * `getChartableSecurities` (the picker) still lists them.
 *
 * BAR COVERAGE OUTRANKS VALUE (2026-09-12, QA finding
 * charts-landing--default-rank-ignores-bar-coverage-opens-empty-chart;
 * tightened 2026-09-13 by the landing review of PR #78): ranking by value alone can land on a held position
 * with ZERO cached bars in `ohlcv_bars`, opening the chart on an empty "No
 * cached price history — connect TWS to load bars" screen even when a
 * smaller held position already has bars ready to render. `has_bars` is
 * therefore the PRIMARY sort key and value the tiebreaker: `ORDER BY
 * has_bars DESC, value DESC`. This is a preference, not an exclusion — when
 * no held candidate has bars, ranking degrades to the old value-only order
 * rather than returning null, so the landing still shows something the
 * picker can display.
 *
 * `has_bars` applies the SAME two filters as the chart reader
 * (`getOhlcvBars`, always called with `bar_size = '1 day'` for the landing
 * request — see app/api/tws/chart/route.ts): `bar_size = '1 day'` AND
 * `PRICED_BAR_SQL`. A row that fails either filter is exactly a row
 * `getOhlcvBars` would omit, so counting it as "coverage" here would land
 * the chart on a security that then renders "No cached price history" —
 * the opposite of what this gate exists to prevent. A security whose only
 * bars are intraday (`'1 hour'`, etc.) or legacy zero-priced rows is
 * therefore treated the same as a security with no bars at all.
 *
 * Returns null when nothing is held (or nothing held is chartable/priced)
 * — callers fall back to the old alphabetical-first behavior.
 */
export function getDefaultChartSecurityId(
  db: Database.Database,
): number | null {
  const marketValueExpr = adjustedMarketValueSQL(
    "h.quantity",
    "p.close_price",
    "s.security_type",
    "COALESCE(s.multiplier, 1)",
    "COALESCE(fx.usd_per_unit, 1)",
  );

  const row = db
    .prepare(
      `SELECT h.security_id AS id,
              SUM(ABS(${marketValueExpr})) AS value,
              MAX(CASE WHEN EXISTS (
                SELECT 1 FROM ohlcv_bars b
                WHERE b.security_id = h.security_id
                  AND b.bar_size = '1 day'
                  AND ${PRICED_BAR_SQL}
              ) THEN 1 ELSE 0 END) AS has_bars
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       LEFT JOIN prices p ON p.security_id = h.security_id
         AND p.date = (SELECT MAX(p2.date) FROM prices p2 WHERE p2.security_id = h.security_id)
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       WHERE ${latestHoldingsPredicate({ keyBy: "account_security" })}
         AND ${CHARTABLE_PREDICATE_SQL}
         AND LOWER(COALESCE(s.security_type, '')) != 'option'
         AND p.close_price IS NOT NULL
       GROUP BY h.security_id
       ORDER BY has_bars DESC, value DESC
       LIMIT 1`,
    )
    .get() as { id: number; value: number; has_bars: number } | undefined;

  return row?.id ?? null;
}

/**
 * Get the latest price for a security (from any source).
 */
export function getLatestPrice(
  db: Database.Database,
  securityId: number,
): { close_price: number; date: string } | null {
  return (
    db
      .prepare(
        `SELECT p.close_price * COALESCE(fx.usd_per_unit, 1) AS close_price, p.date
         FROM prices p
         JOIN securities s ON s.id = p.security_id
         LEFT JOIN fx_rates fx ON fx.currency = s.currency
         WHERE p.security_id = ?
         ORDER BY p.date DESC LIMIT 1`,
      )
      .get(securityId) as { close_price: number; date: string } | undefined
  ) ?? null;
}

/**
 * NATIVE-frame sibling of getLatestPrice — no FX conversion. prices rows are
 * stored in the security's native currency, so this is the frame ohlcv_bars
 * live in. Use it whenever the price feeds math AGAINST bars (pivot levels,
 * ATR, distance %) per the chart-adjacent display pattern: compute native,
 * convert only at dollar-text render sites via usdPerUnit.
 */
export function getLatestPriceNative(
  db: Database.Database,
  securityId: number,
): { close_price: number; date: string } | null {
  return (
    db
      .prepare(
        `SELECT close_price, date FROM prices
         WHERE security_id = ?
         ORDER BY date DESC LIMIT 1`,
      )
      .get(securityId) as { close_price: number; date: string } | undefined
  ) ?? null;
}

/**
 * Get the most recent daily bar for a security. "Today" here means "the
 * freshest bar we have" — the table usually lags by one close, and on
 * weekends/holidays it may lag by several days. Callers should show the
 * returned date as the "as of" label.
 */
export function getLatestDailyBar(
  db: Database.Database,
  securityId: number,
): { date: string; open: number; high: number; low: number; close: number; volume: number | null } | null {
  return (
    db
      .prepare(
        `SELECT bar_date as date, open, high, low, close, volume
         FROM ohlcv_bars
         WHERE security_id = ? AND bar_size = '1 day' AND ${PRICED_BAR_SQL}
         ORDER BY bar_date DESC
         LIMIT 1`,
      )
      .get(securityId) as
      | { date: string; open: number; high: number; low: number; close: number; volume: number | null }
      | undefined
  ) ?? null;
}

/**
 * 52-week high/low from ohlcv_bars. Trailing window based on the DB's most
 * recent bar date, not calendar today — otherwise a 3-day weekend drops us
 * out of range. Returns null when fewer than 10 bars exist (arbitrary floor
 * — below that, "range" is just noise).
 *
 * Corrupt-bar consumer guard: some stored bars have real open/high but a
 * zero-priced low/close (a TWS data defect, not a genuine price). A
 * zero-priced bar is never a real 52-week extreme, so `high`/`low` only
 * aggregate over positive values (`CASE WHEN ... > 0`), and the `n >= 10`
 * floor only counts bars with a positive low — a security with a pile of
 * zero-low bars and few real ones should read as thin history, not padded
 * out by corrupt rows.
 *
 * `startDate`/`endDate` use the same priced-bar predicate (`low > 0 AND
 * high > 0`) rather than a plain MIN/MAX(bar_date) over every row — a raw
 * MAX(bar_date) can name a trailing corrupt bar that contributed nothing to
 * either aggregate. `endDate` feeds `week52AsOf` and the bars-vs-quote
 * freshness arbitration in `lib/queries/security-detail.ts`, so it must
 * always name a bar that actually contributed a real price.
 */
export function get52WeekRange(
  db: Database.Database,
  securityId: number,
): { high: number; low: number; startDate: string; endDate: string } | null {
  const row = db
    .prepare(
      `SELECT
        MAX(CASE WHEN high > 0 THEN high END) AS high,
        MIN(CASE WHEN low > 0 THEN low END) AS low,
        MIN(CASE WHEN low > 0 AND high > 0 THEN bar_date END) AS startDate,
        MAX(CASE WHEN low > 0 AND high > 0 THEN bar_date END) AS endDate,
        SUM(CASE WHEN low > 0 THEN 1 ELSE 0 END) AS n
       FROM ohlcv_bars
       WHERE security_id = ?
         AND bar_size = '1 day'
         AND bar_date >= date(
           (SELECT MAX(bar_date) FROM ohlcv_bars WHERE security_id = ? AND bar_size = '1 day'),
           '-365 days'
         )`,
    )
    .get(securityId, securityId) as
    | { high: number | null; low: number | null; startDate: string | null; endDate: string | null; n: number }
    | undefined;

  if (
    !row ||
    row.high == null ||
    row.low == null ||
    row.startDate == null ||
    row.endDate == null ||
    row.n < 10
  )
    return null;
  return {
    high: row.high,
    low: row.low,
    startDate: row.startDate,
    endDate: row.endDate,
  };
}
