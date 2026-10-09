/**
 * The Performance caption, naming the date the return is actually measured
 * from.
 *
 * `performanceWindowCaption` (performance-window.ts) is written before any
 * return is computed, so it can only promise the window's opening date "or
 * the start of this scope's history if that is later". Once the return is
 * computed the real start is known (`measurementStartDate`, the date the
 * "Period window" card prints), and the caption should print that same date:
 * two different start dates for one window on one page is the defect this
 * fixes. Caption only; no return computation is touched.
 */

import {
  performanceWindowCaption,
  type PerformancePeriod,
  type PerformanceWindow,
} from "@/lib/compute/performance-window";

function formatDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[m - 1]} ${d}, ${y}`;
}

function nextDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/**
 * The window caption with its start replaced by `measuredFrom`, the date the
 * computed return opens on. Falls back to the plain caption when there is no
 * computed start, and for every window that is not statement-anchored (YTD,
 * All, a scope with no statement).
 *
 * - The return opens on the opening statement, or on the day after it (a
 *   chain of stored monthly returns opens on the first day of its first
 *   month): the caption prints that one date.
 * - It opens anywhere else (the scope's history starts later, or a leading
 *   month could not be used): the caption prints the real date and names the
 *   date the period opens.
 */
export function performanceCaptionMeasuredFrom(
  period: PerformancePeriod,
  window: PerformanceWindow,
  measuredFrom: string | null | undefined,
): string | null {
  const base = performanceWindowCaption(period, window);
  if (base === null || !measuredFrom || !window.endsAtStatement || !window.startDate) return base;

  // The clause performanceWindowCaption writes for a statement-anchored
  // window. If its wording ever changes, this no longer matches and the plain
  // caption is returned unchanged (tests/dashboard/performance-caption-u13
  // pins the wording so that is noticed).
  const promised = `measured from ${formatDay(window.startDate)}, or from the start of this scope's history if that is later.`;
  if (!base.includes(promised)) return base;

  const opensOnWindow = measuredFrom === window.startDate || measuredFrom === nextDay(window.startDate);
  const actual = opensOnWindow
    ? `measured from ${formatDay(measuredFrom)}.`
    : `measured from ${formatDay(measuredFrom)}, the nearest date this scope's return can start from (the period opens ${formatDay(window.startDate)}).`;
  return base.replace(promised, actual);
}

/**
 * The equity-curve caption's clause for a curve that runs past the Period
 * window card's End (the last month-end anchor the TWR chain reaches).
 *
 * Every form of the caption names the first and last day of the daily data
 * the curve is computed from. When the shorter-history notice precedes this
 * clause (`afterNotice`), that notice has already named both, so only the
 * overshoot sentence is added. When it does not (the daily history covers the
 * selected period), this clause opens the caption and names them itself: it
 * used to print the end date alone. Caption only.
 */
export function equityCurveOvershootClause(input: {
  afterNotice: boolean;
  curveStart: string;
  curveEnd: string;
  windowEnd: string;
}): string {
  const { afterNotice, curveStart, curveEnd, windowEnd } = input;
  const overshoot = `The daily history runs to ${formatDay(curveEnd)}, past the Period window’s ${formatDay(windowEnd)} month-end anchor — the TWR above stops at that anchor`;
  return afterNotice
    ? `. ${overshoot}`
    : `Equity curve: computed from daily data ${formatDay(curveStart)} – ${formatDay(curveEnd)}. ${overshoot}`;
}
