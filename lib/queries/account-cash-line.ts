import type Database from "better-sqlite3";
import { onlyLiveSnapshotsSql } from "@/lib/db/live-sources";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { isCashEquivalentSecurity } from "@/lib/compute/cash-equivalents";

/**
 * The single-account Holdings footer: a positions total, a Cash line and
 * the account total, all read from ONE row — the account's latest
 * `daily_valuations` row — so the three figures tie by construction
 * (`total_value = holdings_value + cash_balance` is how
 * lib/compute/daily-valuation.ts writes every row).
 *
 * Cash and the total are only returned when a snapshot on or before that
 * day owns the cash (`cashAnchored`). Otherwise the stored cash is the
 * engine's placeholder zero or a value back-stepped from a later snapshot,
 * and stating it would be a guess.
 *
 * Three things a reader of that footer has to be told, and that this query
 * supplies:
 *
 * 1. Which day the figures are for (`valuationDate`).
 * 2. Whether the cash figure is a live-snapshot residual. On a day anchored
 *    to a live broker snapshot (Plaid or TWS) cash is the broker's intraday
 *    total minus close-priced holdings, not a literal cash balance (see
 *    lib/compute/cash-flow-audit.ts, `live-anchor-residual`). The caption
 *    reuses the Data Confidence detail line's wording rather than coining a
 *    second one.
 * 3. Which holdings rows are already inside the cash figure. Daily
 *    valuations count money-market sweep funds as CASH, not positions
 *    (`isCashEquivalentSecurity`), yet a statement-fed account still lists
 *    them as holdings rows. Naming them stops a reader adding the sweep fund
 *    on top of the Cash line.
 *
 * No FX factor is applied here on purpose: the valuation engine converts
 * each holding to US dollars when it writes `holdings_value`, and cash is
 * the broker total (US dollars) minus that. Converting again would
 * double-convert.
 */

/** The wording lib/queries/data-confidence.ts uses for a live-snapshot day's
 *  cash figure. tests/queries/account-cash-line.test.ts fails if that file
 *  stops containing it, so the two surfaces cannot drift apart. */
export const LIVE_SNAPSHOT_TIMING_RESIDUAL_PHRASE =
  "live-snapshot timing residual (intraday broker total vs close-priced holdings)";

/** Caption shown under the Cash line when the cash figure comes from a live
 *  (Plaid/TWS) anchor. */
export const LIVE_SNAPSHOT_CASH_CAPTION = `This is a ${LIVE_SNAPSHOT_TIMING_RESIDUAL_PHRASE}, not a literal cash balance.`;

/** Caption shown under the Cash line instead of `LIVE_SNAPSHOT_CASH_CAPTION`
 *  when the live broker total is from the anchor day but the positions were
 *  priced at an older close (owner ruling 2026-10-12): the gap is a
 *  price-date mismatch, not an intraday timing residual. */
export function priceDateMismatchCaption(anchorDate: string, priceDate: string): string {
  return `The broker total is from ${anchorDate} but the positions are priced at the ${priceDate} close, so this cash figure is a price-date mismatch, not a literal cash balance.`;
}

export interface AccountCashLine {
  accountId: number;
  /** Date of the latest daily valuation — the as-of date of all three figures. */
  valuationDate: string;
  /** Positions at market value, US dollars. Excludes money-market sweep funds. */
  holdingsValue: number;
  /** True when a snapshot on or before `valuationDate` owns the day's cash
   *  (`anchorDate` is set). False means the stored cash is not a figure for
   *  this date: it is the engine's placeholder zero, or a value back-stepped
   *  from a LATER snapshot. `cashBalance` and `totalValue` are then null so
   *  no surface can print them as fact. */
  cashAnchored: boolean;
  /** Cash, US dollars. Includes money-market sweep funds. Null when
   *  `cashAnchored` is false. */
  cashBalance: number | null;
  /** holdingsValue + cashBalance, as stored. Null when `cashAnchored` is
   *  false. */
  totalValue: number | null;
  /** Positions the engine tried to value that day (null on a legacy row). */
  holdingsCount: number | null;
  /** How many of those had a price (null on a legacy row). */
  pricedCount: number | null;
  /** The snapshot the cash figure is anchored to: the newest
   *  `monthly_snapshots` row on or before `valuationDate`, provided the
   *  valuation engine could resolve it. Null when there is no such row or
   *  it did not resolve. */
  anchorDate: string | null;
  /** True when that anchor is a live broker snapshot (Plaid or TWS). */
  isLiveSource: boolean;
  /** `LIVE_SNAPSHOT_CASH_CAPTION` when `isLiveSource`, replaced by
   *  `priceDateMismatchCaption(anchorDate, positionsPriceDate)` when
   *  `priceDateMismatch`; null when not `isLiveSource`. */
  liveSourceCaption: string | null;
  /** The latest row's `data_quality` ('live' / 'recent' / 'estimated', or
   *  'computed' / null on a legacy row). */
  dataQuality: string | null;
  /** The day the figures were actually measured: the newest valuation date
   *  on or before `valuationDate` whose row is not 'estimated'. Equals
   *  `valuationDate` when the latest row is measured; null when every row is
   *  'estimated'. */
  measuredDate: string | null;
  /** True when the latest row is 'estimated' and carries the figures of an
   *  earlier measured day (`measuredDate`). The surface then dates the
   *  figures by `measuredDate`, not by the row (owner ruling 2026-10-12). */
  carried: boolean;
  /** Newest close-price date on or before `valuationDate` across the
   *  account's currently held non-cash-equivalent securities. Null when
   *  none of them has a price. */
  positionsPriceDate: string | null;
  /** True when the live anchor is ON `valuationDate` but the positions were
   *  priced at an older close (`positionsPriceDate < anchorDate`): the cash
   *  residual is a price-date mismatch, not an intraday timing residual. */
  priceDateMismatch: boolean;
  /** Symbols of the account's currently held money-market sweep funds,
   *  sorted. Their value is inside `cashBalance`, not `holdingsValue`. */
  cashEquivalentSymbols: string[];
}

interface ValuationRow {
  valuation_date: string;
  cash_balance: number;
  holdings_value: number;
  total_value: number;
  holdings_count: number | null;
  priced_count: number | null;
  data_quality: string | null;
}

interface AnchorRow {
  month_end_date: string;
  is_live: number;
}

interface HeldSecurityRow {
  symbol: string;
  price_date: string | null;
  security_type: string | null;
  fund_category: string | null;
}

export function getAccountCashLine(
  db: Database.Database,
  accountId: number,
): AccountCashLine | null {
  const valuation = db
    .prepare(
      `SELECT valuation_date, cash_balance, holdings_value, total_value,
              holdings_count, priced_count, data_quality
       FROM daily_valuations
       WHERE account_id = ?
       ORDER BY valuation_date DESC
       LIMIT 1`,
    )
    .get(accountId) as ValuationRow | undefined;
  if (!valuation) return null;

  // The anchor that owns this day's cash is the NEWEST snapshot on or before
  // the valuation date, and only if the valuation engine could resolve it.
  // This mirrors lib/compute/daily-valuation.ts exactly:
  //  - an anchor's cash is carried forward until the next snapshot's date,
  //    so a day AFTER a live anchor still holds that anchor's residual;
  //  - an anchor resolves through a priced day in its five-day lookback, or
  //    through broker-reported cash (getCashAnchors + anchorCashResidual);
  //  - an anchor that does NOT resolve still ends the previous anchor's
  //    window, and the rows from its date on keep the placeholder cash of 0.
  //    So the previous anchor does not keep owning those days: nothing does.
  // tests/queries/account-cash-line-engine.test.ts runs the real engine and
  // fails if the two stop agreeing.
  const newest = db
    .prepare(
      `SELECT ms.month_end_date,
              CASE WHEN ${onlyLiveSnapshotsSql("ms.source")} THEN 1 ELSE 0 END AS is_live,
              CASE WHEN ms.cash_value IS NOT NULL
                     OR EXISTS (
                       SELECT 1 FROM daily_valuations dv
                       WHERE dv.account_id = ms.account_id
                         AND dv.valuation_date <= ms.month_end_date
                         AND dv.valuation_date >= date(ms.month_end_date, '-5 days')
                     )
                   THEN 1 ELSE 0 END AS resolved
       FROM monthly_snapshots ms
       WHERE ms.account_id = ?
         AND ms.month_end_date <= ?
       ORDER BY ms.month_end_date DESC
       LIMIT 1`,
    )
    .get(accountId, valuation.valuation_date) as (AnchorRow & { resolved: number }) | undefined;
  const anchor = newest?.resolved === 1 ? newest : undefined;

  // Date the measurement, not the row (owner ruling 2026-10-12). The
  // valuation engine writes 'estimated' on a day whose holdings snapshot is
  // older than the day (a weekend or holiday carrying the last measured
  // figures), so the figures belong to the newest non-estimated row.
  // 'computed' and NULL are legacy rows and count as measured.
  const measured =
    valuation.data_quality === "estimated"
      ? (db
          .prepare(
            `SELECT valuation_date
             FROM daily_valuations
             WHERE account_id = ?
               AND valuation_date <= ?
               AND (data_quality IS NULL OR data_quality != 'estimated')
             ORDER BY valuation_date DESC
             LIMIT 1`,
          )
          .get(accountId, valuation.valuation_date) as { valuation_date: string } | undefined)
      : { valuation_date: valuation.valuation_date };
  const measuredDate = measured?.valuation_date ?? null;
  const carried =
    valuation.data_quality === "estimated" &&
    measuredDate !== null &&
    measuredDate !== valuation.valuation_date;

  // Each held security with its newest close on or before the valuation
  // date. The valuation date is bound as a parameter: never SQLite
  // date('now'), which is the UTC day.
  const held = db
    .prepare(
      `SELECT s.symbol, s.security_type, s.fund_category,
              (SELECT MAX(p.date) FROM prices p
               WHERE p.security_id = s.id AND p.date <= ?) AS price_date
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE h.account_id = ?
         AND ${latestHoldingsPredicate({ accountFilter: "" })}
       ORDER BY s.symbol`,
    )
    .all(valuation.valuation_date, accountId) as HeldSecurityRow[];

  const cashAnchored = anchor !== undefined;
  const isLiveSource = anchor?.is_live === 1;
  const anchorDate = anchor?.month_end_date ?? null;

  // Sweep funds are cash to the valuation engine, so their prices do not
  // date the positions figure.
  let positionsPriceDate: string | null = null;
  for (const h of held) {
    if (isCashEquivalentSecurity(h) || h.price_date === null) continue;
    if (positionsPriceDate === null || h.price_date > positionsPriceDate) {
      positionsPriceDate = h.price_date;
    }
  }
  // The broker total is from the anchor day; when the positions it is
  // netted against were priced at an older close, the residual is a
  // price-date mismatch, not an intraday timing residual.
  const priceDateMismatch =
    isLiveSource &&
    anchorDate === valuation.valuation_date &&
    positionsPriceDate !== null &&
    positionsPriceDate < anchorDate;

  return {
    accountId,
    valuationDate: valuation.valuation_date,
    holdingsValue: valuation.holdings_value,
    cashAnchored,
    cashBalance: cashAnchored ? valuation.cash_balance : null,
    totalValue: cashAnchored ? valuation.total_value : null,
    holdingsCount: valuation.holdings_count,
    pricedCount: valuation.priced_count,
    anchorDate,
    isLiveSource,
    liveSourceCaption: !isLiveSource
      ? null
      : priceDateMismatch && anchorDate !== null && positionsPriceDate !== null
        ? priceDateMismatchCaption(anchorDate, positionsPriceDate)
        : LIVE_SNAPSHOT_CASH_CAPTION,
    dataQuality: valuation.data_quality,
    measuredDate,
    carried,
    positionsPriceDate,
    priceDateMismatch,
    cashEquivalentSymbols: held.filter((h) => isCashEquivalentSecurity(h)).map((h) => h.symbol),
  };
}
