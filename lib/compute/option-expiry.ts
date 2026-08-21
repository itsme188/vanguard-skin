import { todayET } from "@/lib/calendar/date-utils";

/**
 * Single source of truth for "is this option still counted as a live
 * position" — a SQL-fragment generator and a JS-side twin so every surface
 * that reads option holdings agrees on the same cutoff.
 *
 * The rule: an option counts as live through the END of its expiration day
 * (ET) and is excluded starting the next ET calendar day. This matches the
 * Options Greeks engine's `daysToExpiry <= 0` → "expired" diagnostic
 * (lib/compute/options-greeks.ts) and the strategy detector's cutoff
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
