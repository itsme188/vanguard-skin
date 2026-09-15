import { todayET } from "@/lib/calendar/date-utils";

/**
 * Single source of truth for "is this option still counted as a live
 * position" — a SQL-fragment generator and a JS-side twin so every surface
 * that reads option holdings agrees on the same cutoff.
 *
 * The rule: an option counts as live through the END of its expiration day
 * (ET) and is excluded starting the next ET calendar day. The Options Greeks
 * engine applies a finer cut on expiry day itself — live until the 16:00 ET
 * close, then `expired` (lib/compute/options-greeks.ts::isExpiredAsOf) — so
 * between the close and ET midnight a same-day contract still LISTS here but
 * carries no Greeks. This also matches the strategy detector's cutoff
 * (lib/compute/options-strategy.ts::detectStrategies, QA
 * analysis-detected-strategies--expired-option-rendered-live-protective-put).
 *
 * Two traps this module exists to prevent — both shipped as real bugs before
 * this helper existed, and both are why the "expired option still counts as
 * a live hedge / still gets scenario P&L" finding kept recurring even after
 * the Greeks-derived DISPLAY label ("expired" / DTE) was already correct:
 *
 *  1. SQLite's `date('now')` is UTC-anchored, not ET. This portfolio is
 *     ET-centric (see repo CLAUDE.md "ET-anchor every user-facing today") —
 *     in the ~4-5 hour window after UTC midnight but before ET midnight,
 *     `date('now')` reports TOMORROW relative to ET. Every option-expiry
 *     filter must bind an ET-computed literal instead of trusting SQLite's
 *     own clock.
 *
 *  2. `purgeExpiredOptionHoldings` (lib/mutations/expired-options.ts) keeps a
 *     1-day grace period before physically DELETING a `holdings` row, so a
 *     contract that expired YESTERDAY can still be sitting in the table when
 *     a read runs before the next purge sweep. A read-time filter that
 *     copies that grace-day slip (`expiration_date >= today - 1`) instead of
 *     the strict `>= today` cutoff reintroduces the exact bug the purge's
 *     grace period was designed not to cause elsewhere — this is what let a
 *     QQQ put that expired yesterday still render "Runway -1d" / an
 *     "expiring" badge in the Defense hedge book and still collect P&L in
 *     the Rate-shock scenario. The purge's grace period is about WHEN to
 *     delete; every reader must independently apply the stricter cutoff
 *     regardless of purge state.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * SQL fragment for a `WHERE`/`AND` clause against a `securities` row aliased
 * `alias`: true for non-options (`expiration_date IS NULL`) and for options
 * whose expiration is today (ET) or later.
 *
 * `today` is validated and inlined as a string literal — the same pattern
 * `latestHoldingsPredicate`'s `asOfDate` uses (lib/queries/latest-holdings.ts)
 * — rather than a bound `?` placeholder, so call sites with their own
 * positional param arrays don't have to thread an extra param through in the
 * right order.
 *
 * @example
 *   `... WHERE ${liveOptionExpirationSql("s")} AND ...`
 */
export function liveOptionExpirationSql(alias = "s", today: string = todayET()): string {
  if (!DATE_PATTERN.test(today)) {
    throw new Error(`liveOptionExpirationSql: today must match YYYY-MM-DD, got ${JSON.stringify(today)}`);
  }
  return `(${alias}.expiration_date IS NULL OR ${alias}.expiration_date >= '${today}')`;
}

/**
 * JS-side twin of {@link liveOptionExpirationSql}, for post-query filtering
 * and tests. A missing/unparseable expiration is treated as "unknown, keep
 * it" — never as expired — mirroring options-strategy.ts's
 * `normalizeExpiration` convention.
 */
export function isOptionLive(
  expirationDate: string | null | undefined,
  today: string = todayET()
): boolean {
  if (!expirationDate) return true;
  return expirationDate >= today;
}

/**
 * Whole calendar days from `today` (ET) to `expirationDate`: 0 on the
 * expiration day itself, positive before it, negative after it — agreeing
 * with {@link isOptionLive}'s cutoff (`expirationDate >= today` is live,
 * i.e. `daysToExpiry(...) >= 0`).
 *
 * Both arguments are date-only `YYYY-MM-DD` strings. `new Date(dateOnly)`
 * parses a date-only ISO string as UTC MIDNIGHT per the ECMAScript Date
 * Time String Format spec — so this is pure calendar-date subtraction, not
 * an elapsed-time calculation. That is what keeps a DST-crossing span (or a
 * leap day) exact: there is no local time zone or wall-clock offset in the
 * arithmetic, only two UTC-midnight instants a whole number of days apart.
 *
 * The bug this replaces:
 * `Math.floor((new Date(expirationDate).getTime() - Date.now()) / 86400000)`
 * subtracted a UTC-midnight instant from the current INSTANT (`Date.now()`,
 * i.e. "right now" in the machine's clock, effectively UTC) instead of from
 * an ET calendar day — on the expiry day itself, any time after UTC
 * midnight but before the ET day rolls over, this floors to -1 and prints
 * "(expired)" for a contract the Greeks card (16:00-ET-close rule,
 * `isOptionLive`) still shows as live.
 */
export function daysToExpiry(expirationDate: string, today: string = todayET()): number {
  if (!DATE_PATTERN.test(expirationDate)) {
    throw new Error(`daysToExpiry: expirationDate must match YYYY-MM-DD, got ${JSON.stringify(expirationDate)}`);
  }
  if (!DATE_PATTERN.test(today)) {
    throw new Error(`daysToExpiry: today must match YYYY-MM-DD, got ${JSON.stringify(today)}`);
  }
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((new Date(expirationDate).getTime() - new Date(today).getTime()) / MS_PER_DAY);
}
