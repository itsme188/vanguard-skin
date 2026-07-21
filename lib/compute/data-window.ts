import { addDays } from "@/lib/calendar/date-utils";

// A series starting within this many days of the requested start still
// honestly covers the period (weekends, holidays, a missed valuation day).
const COVERAGE_GRACE_DAYS = 7;

function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Honest-labeling notice for metrics computed from a data series shorter
 * than the user-selected period (daily_valuations history starts 2026-03,
 * so 3Y/All drawdown/Sharpe compute over months, not years).
 *
 * Returns a sentence naming the actual window when the series starts more
 * than COVERAGE_GRACE_DAYS after the requested start (or when no start was
 * requested at all, i.e. the "All" period); null when the series covers the
 * request or there is no series.
 */
export function dataWindowNotice(
  requestedStart: string | undefined,
  seriesStart: string | null,
  seriesEnd: string | null,
): string | null {
  if (!seriesStart || !seriesEnd) return null;
  if (requestedStart && seriesStart <= addDays(requestedStart, COVERAGE_GRACE_DAYS)) {
    return null;
  }
  return `Computed from daily data ${formatDay(seriesStart)} – ${formatDay(seriesEnd)} (daily history is shorter than the selected period)`;
}
