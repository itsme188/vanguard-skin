/**
 * Trading-session dates for test fixtures.
 *
 * computeRiskMetrics measures volatility and Sharpe over trading days only
 * (weekend and holiday valuation rows are dropped, 2026-11-15). A fixture
 * that seeds one valuation per CALENDAR day would lose about two in seven of
 * its points, so return-series fixtures seed one per trading session.
 */
import { addDays } from "@/lib/calendar/date-utils";
import { isMarketClosed } from "@/lib/calendar/market-holidays";

const cache = new Map<string, string[]>();

/** The n-th trading session (0-based) on or after `start` (YYYY-MM-DD). */
export function nthTradingDay(start: string, n: number): string {
  let list = cache.get(start);
  if (!list) {
    list = [];
    cache.set(start, list);
  }
  let d = list.length > 0 ? addDays(list[list.length - 1], 1) : start;
  while (list.length <= n) {
    if (!isMarketClosed(d)) list.push(d);
    d = addDays(d, 1);
  }
  return list[n];
}
