import type Database from "better-sqlite3";
import { adjustedMarketValueSQL } from "../valuation";
import { resolveTradingDayPair, type TradingDayPair } from "../digest/anomalies";
import { latestHoldingsPredicate } from "./latest-holdings";
import { liveOptionExpirationSql } from "../compute/option-expiry";
import { todayET } from "../calendar/date-utils";
import { computePositionDayMove, type DayMoveBasis } from "../compute/day-move";

export interface TodayHolding {
  security_id: number;
  symbol: string;
  security_name: string | null;
  quantity: number;
  current_price: number | null;
  current_value: number | null;
  prior_close: number | null;
  today_gain: number | null;
  today_pct: number | null;
  price_date: string | null;
  price_source: string | null;
  /**
   * No quantity of this sign was in the book as of the prior pair date, and
   * the book was seen at that date. Measured from cost ("cost"), or left out
   * of the move when the row has no usable cost ("excluded").
   */
  opened_today: boolean;
  /** Signed quantity opened or added since the prior pair date (0 if none). */
  added_today_qty: number;
  /**
   * The position was added to and the added shares' cost could not be
   * derived: only the quantity held at the prior date is in `today_gain`.
   */
  added_cost_unknown: boolean;
  /**
   * The quantity differs from the last book on record, but no holdings
   * snapshot exists at the prior pair date, so the change cannot be dated to
   * this session. The new quantity is left out: measuring it from cost could
   * print a multi-day gain as this session's move.
   */
  change_undated: boolean;
  /**
   * Set (true) only when the row is dated AFTER the measured session and its
   * quantity differs from the book as of that session: the difference was
   * traded in a LATER session, so it is not measured against this one's
   * closes. `change_undated` is also true for such a row. Absent otherwise.
   */
  changed_after_session?: boolean;
  /** How `today_gain` was measured. See lib/compute/day-move.ts. */
  day_move_basis: DayMoveBasis;
  /**
   * What `today_gain` is a return on, in dollars, never negative: the
   * prior-close value of the quantity held through the session plus the cost
   * of the quantity opened today. null when `today_gain` is null.
   */
  day_move_base: number | null;
}

/**
 * An option's stored pair-date close can be a stale pre-move intraday quote
 * stamped on the same date as the underlying's true (post-move) close — the
 * pair dates are consecutive, so the trading-day pair can't catch it, and
 * magnitude thresholds are off the table (premiums legitimately double).
 * The tell is an arbitrage violation: an option close sitting far below its
 * intrinsic value at the SAME date's underlying close. Differencing against
 * such a row books the underlying's whole gap as "today" (the APP $390 put
 * showed +208% while APP itself moved +0.43%). The 10% margin tolerates the
 * small legitimate below-intrinsic discount deep-ITM American options carry.
 */
const INTRINSIC_VIOLATION_FRACTION = 0.9;

function violatesIntrinsic(
  optionClose: number | null,
  optionType: string | null,
  strike: number | null,
  underlyingClose: number | null,
): boolean {
  if (
    optionClose == null ||
    underlyingClose == null ||
    strike == null ||
    !optionType
  ) {
    return false;
  }
  const type = optionType.toLowerCase();
  const intrinsic =
    type === "put"
      ? strike - underlyingClose
      : type === "call"
        ? underlyingClose - strike
        : 0;
  if (intrinsic <= 0) return false;
  return optionClose < intrinsic * INTRINSIC_VIOLATION_FRACTION;
}

interface TodayHoldingRow extends TodayHolding {
  option_type: string | null;
  strike_price: number | null;
  pair_latest_close: number | null;
  pair_prior_close: number | null;
  underlying_pair_close: number | null;
  underlying_prior_close: number | null;
  cost_basis_native: number | null;
  prior_quantity: number | null;
  prior_cost_basis_native: number | null;
  value_per_point: number | null;
  fx_usd_per_unit: number | null;
  holding_as_of_date: string;
  session_quantity: number | null;
  session_cost_basis_native: number | null;
}

/**
 * IBKR holdings for the Today view, with "today's move" computed on ONE
 * consecutive trading-day pair resolved from SPY (resolveTradingDayPair —
 * the anomaly-engine convention), never on a bare rn=1/rn=2 row pairing.
 *
 * Why: quote enrichment historically wrote weekend/Monday-before-open
 * `prices` rows carrying a stale last price, so the two most-recent rows per
 * security could be byte-identical non-trading-day phantoms — every position
 * then read exactly $0 / 0.00% while real ±2-3% moves were hidden. Pinning
 * the pair to trading days makes phantom rows harmless; a security missing a
 * close on either pair date gets a null move (honest), not a fake zero.
 *
 * Current price/value deliberately still use the FRESHEST price row (rn=1):
 * a weekend row carrying Friday's true close is the best value estimate even
 * though it must never form a move pair.
 *
 * Regression pin for
 * qa:today-ibkr-snapshot--expired-option-counted-in-names-and-day-move.
 * Options never carry `maturity_date` (that column is bond-only; an option's
 * expiry lives in `securities.expiration_date`, migration 004), so the
 * maturity_date guard above silently let an expired option contract sail
 * through: it stayed in the name count, the day-move sum, and the exposure
 * denominator even after real expiration. The TWS-connect purge
 * (`purgeExpiredOptionHoldings`) usually cleans this up, but the app also
 * supports a no-TWS import path where nothing purges, so the READ side must
 * independently guard — same rule `lib/compute/hedging.ts` and
 * `lib/compute/scenarios.ts` already apply via the shared, ET-anchored
 * `liveOptionExpirationSql` helper (`lib/compute/option-expiry.ts`). Reused
 * here rather than re-implemented, so there is exactly one definition of
 * "is this option still live" for every held-universe query to adopt.
 *
 * Quantity opened today (owner ruling 2026-10-08): the move used to be CURRENT
 * quantity x (latest close - prior close), which credited a position bought
 * today with the whole move since yesterday's close. Each row is now compared
 * with the book as of the prior pair date (`latestHoldingsPredicate` bound by
 * `asOfDate`; a zero-quantity tombstone there means "not held"), and the rule
 * in `lib/compute/day-move.ts` decides: quantity held through the session
 * keeps the SQL's close-to-close figure untouched; quantity opened or added is
 * measured from its own cost, or left out when the cost is unknown. A row
 * whose quantity did not grow is byte-for-byte what it was before the ruling.
 *
 * A row dated AFTER the measured session (2026-10-08): the current row is
 * the newest on record, and it can be newer than the pair's later date (a
 * live row written today while the last full session is yesterday's). A
 * quantity that changed after the session was traded against a later price,
 * so it is not measured here: the move is taken on the book as of the pair's
 * later date (read the same way as the prior book), a name not held then is
 * left out, and the row is flagged `change_undated`. A row dated on or before
 * the pair's later date, or a later row with the same quantity, is untouched.
 */
export function getIbkrTodayHoldings(
  db: Database.Database,
  accountId: number,
  // A caller that also LABELS the move (the Today heading names the session)
  // resolves the pair once and passes it, so label and figure cannot come
  // from two different reads. Omitted: resolved here, as before.
  movePair?: TradingDayPair | null,
): TodayHolding[] {
  const pair = movePair === undefined ? resolveTradingDayPair(db) : movePair;
  // Sentinel dates match no rows → move columns fall through to null.
  const pairLatest = pair?.latest ?? "";
  const pairPrior = pair?.prior ?? "";
  const today = todayET();

  // The book as of the prior pair date, one row per security still held then.
  // With no pair there is no prior date: an empty set, and no row is compared.
  const priorBookSql = pair
    ? `SELECT h.security_id, h.quantity, h.cost_basis
         FROM holdings h
        WHERE h.account_id = ?
          AND ${latestHoldingsPredicate({ accountFilter: "", asOfDate: pair.prior })}`
    : `SELECT NULL AS security_id, NULL AS quantity, NULL AS cost_basis WHERE ? IS NULL AND 0`;

  // The book as of the pair's LATER date: what was held when the measured
  // session closed. Equal to the current row unless that row is dated later.
  const sessionBookSql = pair
    ? `SELECT h.security_id, h.quantity, h.cost_basis
         FROM holdings h
        WHERE h.account_id = ?
          AND ${latestHoldingsPredicate({ accountFilter: "", asOfDate: pair.latest })}`
    : `SELECT NULL AS security_id, NULL AS quantity, NULL AS cost_basis WHERE ? IS NULL AND 0`;

  // Was the book SEEN at the prior close? Any holdings row for the account
  // dated from the prior pair date up to (not including) the later one is a
  // snapshot taken after the prior session opened and before this one did.
  // Without one, a quantity that differs from the last book on record may
  // have changed on any day in the gap, so it cannot be called "opened today".
  const priorBookObserved =
    pair !== null &&
    db
      .prepare(
        `SELECT 1 FROM holdings
          WHERE account_id = ? AND as_of_date >= ? AND as_of_date < ?
          LIMIT 1`,
      )
      .get(accountId, pair.prior, pair.latest) !== undefined;

  const marketValueCurrent = adjustedMarketValueSQL(
    "h.quantity",
    "p_today.close_price",
    "s.security_type",
    "COALESCE(s.multiplier, 1)",
    "COALESCE(fx.usd_per_unit, 1)",
  );
  const marketValuePairLatest = adjustedMarketValueSQL(
    "h.quantity",
    "p_pair.close_price",
    "s.security_type",
    "COALESCE(s.multiplier, 1)",
    "COALESCE(fx.usd_per_unit, 1)",
  );
  const marketValuePairPrior = adjustedMarketValueSQL(
    "h.quantity",
    "p_prior.close_price",
    "s.security_type",
    "COALESCE(s.multiplier, 1)",
    "COALESCE(fx.usd_per_unit, 1)",
  );
  // Native value of ONE unit of quantity at a price of 1: the multiplier for
  // an option, 0.01 for a bond, 1 otherwise. Taken from the same expression
  // as the market values above so the two cannot drift apart.
  const valuePerPoint = adjustedMarketValueSQL(
    "1",
    "1",
    "s.security_type",
    "COALESCE(s.multiplier, 1)",
    "1",
  );

  // includeShorts defaults to true (h.quantity != 0) here deliberately: the
  // market-value expressions below are quantity-signed, so a short position
  // already gets the right P/L sign (price drop -> positive today_gain) for
  // free. Filtering to h.quantity > 0 dropped every short from the row set,
  // so the Today snapshot's name count silently undercounted the Accounts
  // page by exactly the short-position count. See
  // qa:today-ibkr-snapshot--name-count-and-day-pl-drop-short-positions.
  const rows = db
    .prepare(
      `WITH ranked_prices AS (
         SELECT security_id, date, close_price, source,
                ROW_NUMBER() OVER (PARTITION BY security_id ORDER BY date DESC) AS rn
         FROM prices
       )
       SELECT
         h.security_id,
         s.symbol,
         s.name AS security_name,
         h.quantity,
         s.option_type,
         s.strike_price,
         p_today.close_price * COALESCE(fx.usd_per_unit, 1) AS current_price,
         p_today.date AS price_date,
         p_today.source AS price_source,
         p_prior.close_price * COALESCE(fx.usd_per_unit, 1) AS prior_close,
         p_pair.close_price AS pair_latest_close,
         p_prior.close_price AS pair_prior_close,
         pu_pair.close_price AS underlying_pair_close,
         pu_prior.close_price AS underlying_prior_close,
         h.cost_basis AS cost_basis_native,
         hp.quantity AS prior_quantity,
         hp.cost_basis AS prior_cost_basis_native,
         h.as_of_date AS holding_as_of_date,
         hs.quantity AS session_quantity,
         hs.cost_basis AS session_cost_basis_native,
         ${valuePerPoint} AS value_per_point,
         COALESCE(fx.usd_per_unit, 1) AS fx_usd_per_unit,
         CASE WHEN p_today.close_price IS NOT NULL THEN ${marketValueCurrent} ELSE NULL END AS current_value,
         CASE WHEN p_pair.close_price IS NOT NULL AND p_prior.close_price IS NOT NULL
           THEN ${marketValuePairLatest} - ${marketValuePairPrior} ELSE NULL END AS today_gain,
         CASE WHEN p_pair.close_price IS NOT NULL AND p_prior.close_price IS NOT NULL
                AND p_prior.close_price != 0
           THEN (p_pair.close_price - p_prior.close_price) / p_prior.close_price
                * CASE WHEN h.quantity < 0 THEN -1.0 ELSE 1.0 END
           ELSE NULL END AS today_pct
       FROM holdings h
       JOIN securities s ON s.id = h.security_id
       LEFT JOIN ranked_prices p_today ON p_today.security_id = h.security_id AND p_today.rn = 1
       LEFT JOIN prices p_pair ON p_pair.security_id = h.security_id AND p_pair.date = ?
       LEFT JOIN prices p_prior ON p_prior.security_id = h.security_id AND p_prior.date = ?
       LEFT JOIN securities s_u ON LOWER(s.security_type) = 'option' AND s_u.symbol = s.underlying_symbol
       LEFT JOIN prices pu_pair ON pu_pair.security_id = s_u.id AND pu_pair.date = ?
       LEFT JOIN prices pu_prior ON pu_prior.security_id = s_u.id AND pu_prior.date = ?
       LEFT JOIN fx_rates fx ON fx.currency = s.currency
       LEFT JOIN (${priorBookSql}) hp ON hp.security_id = h.security_id
       LEFT JOIN (${sessionBookSql}) hs ON hs.security_id = h.security_id
       WHERE h.account_id = ?
         AND ${latestHoldingsPredicate({ accountFilter: "" })}
         AND (s.maturity_date IS NULL OR s.maturity_date >= date('now')
              OR LOWER(s.security_type) = 'bond')
         AND ${liveOptionExpirationSql("s", today)}
       ORDER BY ABS(COALESCE(today_gain, 0)) DESC`,
    )
    .all(
      pairLatest,
      pairPrior,
      pairLatest,
      pairPrior,
      pair ? accountId : null,
      pair ? accountId : null,
      accountId,
    ) as TodayHoldingRow[];

  const cleaned = rows.map((row): TodayHolding => {
    const {
      option_type,
      strike_price,
      pair_latest_close,
      pair_prior_close,
      underlying_pair_close,
      underlying_prior_close,
      cost_basis_native,
      prior_quantity,
      prior_cost_basis_native,
      value_per_point,
      fx_usd_per_unit,
      holding_as_of_date,
      session_quantity,
      session_cost_basis_native,
      ...sqlHolding
    } = row;
    const holding: TodayHolding = {
      ...sqlHolding,
      opened_today: false,
      added_today_qty: 0,
      added_cost_unknown: false,
      change_undated: false,
      day_move_basis: sqlHolding.today_gain === null ? "unpriced" : "prior_close",
      day_move_base: null,
    };

    if (pair) {
      const fx = fx_usd_per_unit ?? 1;
      // The row is dated after the measured session and its quantity is not
      // what the book held when that session closed: measure the session's
      // own book, never the quantity traded afterwards.
      const sessionQty = session_quantity ?? 0;
      const changedAfterSession =
        holding_as_of_date > pair.latest && sessionQty !== row.quantity;
      const input = {
        priorQty: prior_quantity,
        currentQty: changedAfterSession ? sessionQty : row.quantity,
        priorClose: pair_prior_close,
        latestClose: pair_latest_close,
        priorCostBasis: prior_cost_basis_native,
        currentCostBasis: changedAfterSession ? session_cost_basis_native : cost_basis_native,
        multiplier: value_per_point ?? 1,
      };
      let move = computePositionDayMove(input);
      const grew = move.openedToday || move.addedQty !== 0;

      if (changedAfterSession) {
        holding.change_undated = true;
        holding.changed_after_session = true;
      }

      if (changedAfterSession && sessionQty === 0) {
        // Not held when the session closed: opened afterwards. Nothing of it
        // belongs to this session, so it is left out, not priced from cost.
        move = {
          gain: null, base: null, basis: "excluded",
          openedToday: false, addedQty: 0, addedCostUnknown: false,
        };
      } else if (grew && !priorBookObserved) {
        // The change cannot be dated to this session: leave the new quantity
        // out. A brand-new name has nothing left to measure; a grown one keeps
        // the close-to-close move on the quantity last seen (costs withheld so
        // the rule cannot price the rest).
        holding.change_undated = true;
        move = move.openedToday
          ? { ...move, gain: null, base: null, basis: "excluded" }
          : computePositionDayMove({ ...input, priorCostBasis: null, currentCostBasis: null });
      } else {
        holding.opened_today = move.openedToday;
        holding.added_today_qty = move.addedQty;
        holding.added_cost_unknown = move.addedCostUnknown;
      }

      if (grew || changedAfterSession) {
        // Only a row whose quantity grew, or whose current quantity is not the
        // session's (the SQL figures are on the current quantity), is
        // re-measured. Everything else keeps the SQL figures above, exactly as
        // before the ruling.
        holding.today_gain = move.gain === null ? null : move.gain * fx;
        holding.today_pct =
          move.gain !== null && move.base !== null && move.base > 0
            ? move.gain / move.base
            : null;
        holding.day_move_basis = move.basis;
      }
      holding.day_move_base =
        holding.today_gain !== null && move.base !== null ? move.base * fx : null;
    }

    // A stale quote spoils only a measurement that reads it: a position
    // opened today is measured from cost and never reads the prior close.
    const readsPriorClose =
      holding.day_move_basis === "prior_close" || holding.day_move_basis === "mixed";
    const staleQuote =
      violatesIntrinsic(pair_latest_close, option_type, strike_price, underlying_pair_close) ||
      (readsPriorClose &&
        violatesIntrinsic(pair_prior_close, option_type, strike_price, underlying_prior_close));
    if (staleQuote && holding.today_gain !== null) {
      holding.today_gain = null;
      holding.today_pct = null;
      holding.day_move_base = null;
      holding.day_move_basis = "unpriced";
    }
    return holding;
  });

  // Re-sort: a suppressed move must not keep its pre-suppression rank.
  return cleaned.sort(
    (a, b) => Math.abs(b.today_gain ?? 0) - Math.abs(a.today_gain ?? 0),
  );
}

export interface IbkrDayMoveSummary {
  /** Rows with a measured move. */
  count: number;
  todayGain: number | null;
  priorGross: number;
  todayPct: number | null;
  /** Rows opened today, measured or not. */
  openedTodayCount: number;
  /** Of those, rows with no usable cost: left out of the move. */
  excludedCount: number;
  /** Rows added to today, measured or not. */
  addedTodayCount: number;
  /** Of those, rows whose added shares are left out (cost unknown). */
  addedCostUnknownCount: number;
  /** Rows whose quantity changed across a gap in holdings snapshots. */
  undatedChangeCount: number;
  /** Rows with no move because a close is missing. */
  unpricedCount: number;
}

/**
 * The dollars a row's gain is a return on. A row measured close-to-close on
 * its full current quantity keeps the ratified 2026-09-13 figure,
 * |current_value - today_gain|. A row any part of which is NOT measured that
 * way (opened today, added to, or changed across a snapshot gap) cannot: its
 * current value includes shares whose prior-close value it never had, so it
 * carries its own base (prior value of the held quantity plus cost of the
 * quantity opened today).
 */
function dayMoveBase(h: TodayHolding): number {
  const fullCloseToClose =
    h.day_move_basis === "prior_close" && !h.added_cost_unknown && !h.change_undated;
  if (fullCloseToClose || h.day_move_base == null) {
    return Math.abs((h.current_value ?? 0) - (h.today_gain ?? 0));
  }
  return Math.abs(h.day_move_base);
}

/**
 * Aggregates the one-line Today IBKR snapshot's day move across a set of
 * holdings rows. Ratified 2026-09-13: with shorts included in the row set
 * (see includeShorts note above getIbkrTodayHoldings), a hedged book can make
 * NET prior-close exposure (Σcurrent_value − ΣtodayGain) tiny or negative —
 * the denominator either renders "—" beside a real dollar figure or blows up
 * the percent. The percent denominator is GROSS prior-close exposure instead:
 * Σ|current_value_i − today_gain_i| per row, which is always ≥ each row's
 * true prior-close magnitude and only hits 0 when there is truly no priced
 * exposure.
 *
 * 2026-10-08: "prior value = current value − gain" is false for quantity
 * opened today, whose base is its cost. The denominator is now the sum of
 * prior values of held quantities plus the cost of quantities opened today
 * (see dayMoveBase); it is unchanged for a book nobody traded.
 */
export function summarizeIbkrDayMove(
  rows: TodayHolding[],
): IbkrDayMoveSummary {
  const notes = {
    openedTodayCount: rows.filter((h) => h.opened_today).length,
    excludedCount: rows.filter((h) => h.opened_today && h.day_move_basis === "excluded").length,
    addedTodayCount: rows.filter((h) => !h.opened_today && h.added_today_qty !== 0).length,
    addedCostUnknownCount: rows.filter((h) => h.added_cost_unknown).length,
    undatedChangeCount: rows.filter((h) => h.change_undated).length,
    unpricedCount: rows.filter((h) => h.day_move_basis === "unpriced").length,
  };
  const moved = rows.filter((h) => h.today_gain !== null);
  if (moved.length === 0) {
    return { count: 0, todayGain: null, priorGross: 0, todayPct: null, ...notes };
  }
  const todayGain = moved.reduce((sum, h) => sum + (h.today_gain ?? 0), 0);
  const priorGross = moved.reduce((sum, h) => sum + dayMoveBase(h), 0);
  const todayPct = priorGross === 0 ? null : todayGain / priorGross;
  return { count: moved.length, todayGain, priorGross, todayPct, ...notes };
}
