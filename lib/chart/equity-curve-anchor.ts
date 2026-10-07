/**
 * Equity curve: tie recorded daily valuations to the monthly statement values.
 *
 * Statement values (month-end snapshots) are authoritative. Daily valuations
 * are computed and can run a steady amount off the statements (cash or a
 * holding missing from the daily computation). The chart keeps the SHAPE of
 * the recorded days and closes the gap to the statements with an additive
 * correction (owner ruling 2026-10-06, Option 1):
 *
 *   between anchors A0 (d0, v0) and A1 (d1, v1):
 *     gap0 = v0 - recorded(d0), gap1 = v1 - recorded(d1)
 *     plotted(d) = recorded(d) + lerp_over_time(gap0 at d0, gap1 at d1)
 *
 *   after the last anchor: plotted(d) = recorded(d) + (v_last - recorded(d_last))
 *
 * recorded(dX) is the daily on the anchor date. When none falls on it (a
 * month-end on a weekend or holiday), the START reference is the last recorded
 * daily before the anchor, found in the full daily list and no more than
 * MAX_REFERENCE_LOOKBACK_DAYS earlier: measuring the offset against the first
 * trading day AFTER the anchor would bake that day's move into the offset and
 * smear it across the month. Only when no such daily exists is the nearest
 * in-segment daily used. (The END reference needs no lookup: every in-segment
 * daily is on or before the end anchor, so the nearest one is already the last
 * recorded daily at or before it.) Because the correction is
 * additive and moves linearly, a recorded dip is still a dip (no inversion of
 * the month's shape, no multiplicative rescale) and both anchors plot exactly.
 *
 * Anchors are the monthly_snapshots rows: month-end statements AND dense live
 * TWS/Plaid snapshots. A segment longer than SHORT_SEGMENT_MAX_DAYS whose
 * dailies are too sparse (fewer than MIN_SEGMENT_DAILIES days
 * strictly between the anchors) or internally inconsistent (max-min spread
 * above MAX_SEGMENT_SPREAD of their mean, a sign of incomplete holdings that
 * month) is plotted from the statements only, and counted in the summary so
 * the chart can say so.
 */

export interface EquityAnchor {
  /** YYYY-MM-DD statement (month-end) date. */
  date: string;
  value: number;
}

export interface EquityDaily {
  /** YYYY-MM-DD valuation date. */
  date: string;
  value: number;
}

export interface AnchoredPoint {
  date: string;
  /** The value plotted on the chart. */
  value: number;
  /** The recorded daily valuation behind this point; null for an anchor. */
  recordedValue: number | null;
  isAnchor: boolean;
}

export interface AnchoredCurveSummary {
  /** Anchor-to-anchor segments plotted from corrected daily values. */
  segmentsAnchored: number;
  /** Long segments (> SHORT_SEGMENT_MAX_DAYS) that HAD dailies but too few / too inconsistent to use. */
  segmentsSkipped: number;
  /** Daily points plotted after the last anchor. */
  trailingDays: number;
  /** True when dailies after the last anchor existed but failed the consistency gate. */
  trailingSkipped: boolean;
}

export interface AnchoredCurve {
  points: AnchoredPoint[];
  summary: AnchoredCurveSummary;
}

/** Fewer recorded days than this strictly between two anchors → statements only. */
export const MIN_SEGMENT_DAILIES = 3;
/** (max - min) / mean above this → the dailies are too inconsistent to use. */
export const MAX_SEGMENT_SPREAD = 0.3;
/**
 * Anchor spans of this many days or fewer (typically two live TWS/Plaid
 * snapshots a few days apart) are never skipped: any dailies inside are
 * plotted with the correction, however few.
 */
export const SHORT_SEGMENT_MAX_DAYS = 7;

/**
 * How far before an anchor date the last recorded daily may sit and still be
 * its start reference. 5 calendar days covers a weekend plus a market holiday
 * (a Sunday month-end after a Friday holiday sits 3 days from Thursday's
 * close; 5 leaves margin for a holiday adjoining the weekend). Older than this the daily is stale and
 * says nothing about the anchor day, so the in-segment fallback applies.
 */
export const MAX_REFERENCE_LOOKBACK_DAYS = 5;

const DAY_MS = 86_400_000;

function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

function tooInconsistent(values: number[]): boolean {
  if (values.length === 0) return false;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (!(mean > 0)) return true;
  return (max - min) / mean > MAX_SEGMENT_SPREAD;
}

/**
 * Last recorded daily on or before `date` in the full sorted list, provided it
 * is within MAX_REFERENCE_LOOKBACK_DAYS of it.
 */
function lastDailyAtOrBefore(date: string, sortedDailies: EquityDaily[]): EquityDaily | undefined {
  let found: EquityDaily | undefined;
  for (const d of sortedDailies) {
    if (d.date > date) break;
    found = d;
  }
  if (!found) return undefined;
  return dayNumber(date) - dayNumber(found.date) <= MAX_REFERENCE_LOOKBACK_DAYS ? found : undefined;
}

/**
 * Start reference: the last recorded daily at or before `date` (within the
 * lookback), else the in-segment daily nearest to it.
 */
function referenceDaily(
  date: string,
  sortedDailies: EquityDaily[],
  segment: EquityDaily[],
): EquityDaily | undefined {
  const prior = lastDailyAtOrBefore(date, sortedDailies);
  if (prior) return prior;
  const target = dayNumber(date);
  let best: EquityDaily | undefined;
  let bestDist = Infinity;
  for (const d of segment) {
    const dist = Math.abs(dayNumber(d.date) - target);
    if (dist < bestDist) {
      best = d;
      bestDist = dist;
    }
  }
  return best;
}

export function anchorDailiesToStatements(
  anchors: EquityAnchor[],
  dailies: EquityDaily[],
): AnchoredCurve {
  const sortedAnchors = [...anchors].sort((a, b) => a.date.localeCompare(b.date));
  const sortedDailies = dailies
    .filter((d) => Number.isFinite(d.value))
    .sort((a, b) => a.date.localeCompare(b.date));
  const dailyByDate = new Map(sortedDailies.map((d) => [d.date, d]));

  const summary: AnchoredCurveSummary = {
    segmentsAnchored: 0,
    segmentsSkipped: 0,
    trailingDays: 0,
    trailingSkipped: false,
  };
  const points: AnchoredPoint[] = [];

  for (let i = 0; i < sortedAnchors.length; i++) {
    const a0 = sortedAnchors[i];
    points.push({ date: a0.date, value: a0.value, recordedValue: null, isAnchor: true });

    const a1 = sortedAnchors[i + 1];
    if (!a1) {
      appendTrailing(points, summary, a0, sortedDailies, dailyByDate.get(a0.date));
      continue;
    }

    const between = sortedDailies.filter((d) => d.date > a0.date && d.date < a1.date);
    const onD0 = dailyByDate.get(a0.date);
    const onD1 = dailyByDate.get(a1.date);
    if (between.length === 0) continue; // no daily history here (e.g. pre-daily era)

    const t0 = dayNumber(a0.date);
    const span = dayNumber(a1.date) - t0;

    if (span > SHORT_SEGMENT_MAX_DAYS) {
      const consistencySet = [...(onD0 ? [onD0] : []), ...between, ...(onD1 ? [onD1] : [])];
      if (between.length < MIN_SEGMENT_DAILIES || tooInconsistent(consistencySet.map((d) => d.value))) {
        summary.segmentsSkipped++;
        continue;
      }
    }

    const ref0 = referenceDaily(a0.date, sortedDailies, between)!;
    // End reference: every daily in `between` is before a1, so the nearest one
    // is the last at or before it -- same rule, no lookup needed.
    const ref1 = onD1 ?? between[between.length - 1];
    const gap0 = a0.value - ref0.value;
    const gap1 = a1.value - ref1.value;

    for (const d of between) {
      const t = span > 0 ? (dayNumber(d.date) - t0) / span : 0;
      const offset = gap0 + t * (gap1 - gap0);
      points.push({ date: d.date, value: d.value + offset, recordedValue: d.value, isAnchor: false });
    }
    summary.segmentsAnchored++;
  }

  points.sort((a, b) => a.date.localeCompare(b.date));
  return { points, summary };
}

function appendTrailing(
  points: AnchoredPoint[],
  summary: AnchoredCurveSummary,
  last: EquityAnchor,
  sortedDailies: EquityDaily[],
  onLast: EquityDaily | undefined,
): void {
  const trailing = sortedDailies.filter((d) => d.date > last.date);
  if (trailing.length === 0) return;
  const consistencySet = [...(onLast ? [onLast] : []), ...trailing];
  if (tooInconsistent(consistencySet.map((d) => d.value))) {
    summary.trailingSkipped = true;
    return;
  }
  const ref = onLast ?? lastDailyAtOrBefore(last.date, sortedDailies) ?? trailing[0];
  const gap = last.value - ref.value;
  for (const d of trailing) {
    points.push({ date: d.date, value: d.value + gap, recordedValue: d.value, isAnchor: false });
  }
  summary.trailingDays = trailing.length;
}

/** The small caption under the chart; null when no daily data is in play. */
export function equityCurveCaption(summary: AnchoredCurveSummary): string | null {
  const anchoredAny = summary.segmentsAnchored > 0 || summary.trailingDays > 0;
  const parts: string[] = [];
  if (anchoredAny) {
    parts.push("Daily values anchored to statement and broker snapshot values");
  } else if (summary.segmentsSkipped > 0 || summary.trailingSkipped) {
    parts.push("Daily values too incomplete to plot");
  } else {
    return null;
  }
  if (summary.segmentsSkipped > 0) {
    const n = summary.segmentsSkipped;
    parts.push(`${n} ${n === 1 ? "month" : "months"} plotted from statements only`);
  }
  if (summary.trailingSkipped) {
    parts.push("days after the last statement not plotted");
  }
  return parts.join(" · ");
}

/**
 * Tooltip text for a plotted point: the plotted value, plus the recorded daily
 * value when the two differ at whole-dollar precision. `fmt` is the caller's
 * privacy-aware formatter, so both figures mask together.
 */
export function formatAnchoredTooltipValue(
  value: number,
  recordedValue: number | null | undefined,
  fmt: (v: number) => string,
): string {
  if (recordedValue == null || Math.round(recordedValue) === Math.round(value)) {
    return fmt(value);
  }
  return `${fmt(value)} · recorded ${fmt(recordedValue)}`;
}
