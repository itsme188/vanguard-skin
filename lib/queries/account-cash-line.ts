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

export interface AccountCashLine {
  accountId: number;
  /** Date of the latest daily valuation — the as-of date of all three figures. */
  valuationDate: string;
  /** Positions at market value, US dollars. Excludes money-market sweep funds. */
  holdingsValue: number;
  /** Cash, US dollars. Includes money-market sweep funds. */
  cashBalance: number;
  /** holdingsValue + cashBalance, as stored. */
  totalValue: number;
  /** Positions the engine tried to value that day (null on a legacy row). */
  holdingsCount: number | null;
  /** How many of those had a price (null on a legacy row). */
  pricedCount: number | null;
  /** The snapshot the cash figure is anchored to: the newest
   *  `monthly_snapshots` row on or before `valuationDate` that the valuation
   *  engine could resolve. Null when there is none. */
  anchorDate: string | null;
  /** True when that anchor is a live broker snapshot (Plaid or TWS). */
  isLiveSource: boolean;
  /** `LIVE_SNAPSHOT_CASH_CAPTION` when `isLiveSource`, else null. */
  liveSourceCaption: string | null;
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
}

interface AnchorRow {
  month_end_date: string;
  is_live: number;
}

interface HeldSecurityRow {
  symbol: string;
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
              holdings_count, priced_count
       FROM daily_valuations
       WHERE account_id = ?
       ORDER BY valuation_date DESC
       LIMIT 1`,
    )
    .get(accountId) as ValuationRow | undefined;
  if (!valuation) return null;

  // The anchor that owns this day's cash: the newest snapshot on or before
  // the valuation date. The valuation engine carries an anchor's cash
  // forward until the next anchor, so a day AFTER a live anchor still holds
  // that anchor's residual. The EXISTS / cash_value clause mirrors the
  // engine's own skip rule (getCashAnchors in lib/compute/daily-valuation.ts:
  // an anchor with no priced day in its five-day lookback and no
  // broker-reported cash is skipped, and the previous anchor keeps owning
  // the cash).
  const anchor = db
    .prepare(
      `SELECT ms.month_end_date,
              CASE WHEN ${onlyLiveSnapshotsSql("ms.source")} THEN 1 ELSE 0 END AS is_live
       FROM monthly_snapshots ms
       WHERE ms.account_id = ?
         AND ms.month_end_date <= ?
         AND (
           ms.cash_value IS NOT NULL
           OR EXISTS (
             SELECT 1 FROM daily_valuations dv
             WHERE dv.account_id = ms.account_id
               AND dv.valuation_date <= ms.month_end_date
               AND dv.valuation_date >= date(ms.month_end_date, '-5 days')
           )
         )
       ORDER BY ms.month_end_date DESC
       LIMIT 1`,
    )
    .get(accountId, valuation.valuation_date) as AnchorRow | undefined;

  const held = db
    .prepare(
      `SELECT s.symbol, s.security_type, s.fund_category
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       WHERE h.account_id = ?
         AND ${latestHoldingsPredicate({ accountFilter: "" })}
       ORDER BY s.symbol`,
    )
    .all(accountId) as HeldSecurityRow[];

  const isLiveSource = anchor?.is_live === 1;

  return {
    accountId,
    valuationDate: valuation.valuation_date,
    holdingsValue: valuation.holdings_value,
    cashBalance: valuation.cash_balance,
    totalValue: valuation.total_value,
    holdingsCount: valuation.holdings_count,
    pricedCount: valuation.priced_count,
    anchorDate: anchor?.month_end_date ?? null,
    isLiveSource,
    liveSourceCaption: isLiveSource ? LIVE_SNAPSHOT_CASH_CAPTION : null,
    cashEquivalentSymbols: held.filter((h) => isCashEquivalentSecurity(h)).map((h) => h.symbol),
  };
}
