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
 * above MAX_SEGMENT_SPREAD of their mean, measured net of the segment's
 * deposits and withdrawals so real money movement does not trip it; a sign of incomplete holdings that
 * month) is plotted from the statements only, and counted in the summary so
 * the chart can say so. A segment that passes both tests but has a gap longer
 * than SHORT_SEGMENT_MAX_DAYS between its plotted points is still drawn, and
 * captioned as a straight-line stretch.
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

export interface EquityFlow {
  /** YYYY-MM-DD the money moved. */
  date: string;
  /** Net external flow that day: deposits positive, withdrawals negative. */
  netFlow: number;
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
  /** Anchor-to-anchor spans behind the counts above, so a caption can scope to a date range. */
  anchoredSpans?: DateSpan[];
  skippedSpans?: DateSpan[];
  /** Anchored spans with a gap longer than SHORT_SEGMENT_MAX_DAYS between points. */
  sparseSpans?: DateSpan[];
}

export interface DateSpan {
  from: string;
  to: string;
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

/**
 * Each daily's value net of the external flows since `segmentStart` (flows
 * dated in (segmentStart, daily date]): a deposit on day k lowers every
 * adjusted value from day k on. Used ONLY by the spread check; the plotted
 * values are never adjusted. With no flows the values come back unchanged.
 */
function netOfFlows(set: EquityDaily[], segmentStart: string, flows: EquityFlow[]): number[] {
  if (flows.length === 0) return set.map((d) => d.value);
  return set.map((d) => {
    let cum = 0;
    for (const f of flows) {
      if (f.date > segmentStart && f.date <= d.date && Number.isFinite(f.netFlow)) cum += f.netFlow;
    }
    return d.value - cum;
  });
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
  flows: EquityFlow[] = [],
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
    anchoredSpans: [],
    skippedSpans: [],
    sparseSpans: [],
  };
  const points: AnchoredPoint[] = [];

  for (let i = 0; i < sortedAnchors.length; i++) {
    const a0 = sortedAnchors[i];
    points.push({ date: a0.date, value: a0.value, recordedValue: null, isAnchor: true });

    const a1 = sortedAnchors[i + 1];
    if (!a1) {
      appendTrailing(points, summary, a0, sortedDailies, dailyByDate.get(a0.date), flows);
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
      if (between.length < MIN_SEGMENT_DAILIES || tooInconsistent(netOfFlows(consistencySet, a0.date, flows))) {
        summary.segmentsSkipped++;
        summary.skippedSpans!.push({ from: a0.date, to: a1.date });
        continue;
      }
      // Gaps between the points that are actually plotted (the anchors plus the dailies).
      const days = [a0.date, ...between.map((d) => d.date), a1.date].map(dayNumber);
      let widest = 0;
      for (let k = 1; k < days.length; k++) widest = Math.max(widest, days[k] - days[k - 1]);
      if (widest > SHORT_SEGMENT_MAX_DAYS) summary.sparseSpans!.push({ from: a0.date, to: a1.date });
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
    summary.anchoredSpans!.push({ from: a0.date, to: a1.date });
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
  flows: EquityFlow[],
): void {
  const trailing = sortedDailies.filter((d) => d.date > last.date);
  if (trailing.length === 0) return;
  const consistencySet = [...(onLast ? [onLast] : []), ...trailing];
  if (tooInconsistent(netOfFlows(consistencySet, last.date, flows))) {
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
export function equityCurveCaption(
  summary: AnchoredCurveSummary,
  opts: { skippedUnit?: "month" | "stretch"; sparseStretches?: number } = {},
): string | null {
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
    const unit = opts.skippedUnit ?? "month";
    const noun = unit === "month" ? (n === 1 ? "month" : "months") : n === 1 ? "stretch" : "stretches";
    parts.push(`${n} ${noun} plotted from statements only`);
  }
  const sparse = opts.sparseStretches ?? 0;
  if (sparse > 0) {
    parts.push(`${sparse} ${sparse === 1 ? "stretch" : "stretches"} with gaps drawn as straight lines`);
  }
  if (summary.trailingSkipped) {
    parts.push("days after the last statement not plotted");
  }
  return parts.join(" · ");
}

function spanDays(s: DateSpan): number {
  return dayNumber(s.to) - dayNumber(s.from);
}

/**
 * The caption scoped to the selected chart range. `rangeStart` is the first
 * date the chart shows (null = all history); a span counts when it ends on or
 * after it. A skipped span is called a "month" only when every one is about a
 * month long, otherwise a "stretch". Summaries without span detail fall back
 * to the whole-history counts.
 */
export function equityCurveRangeCaption(
  summary: AnchoredCurveSummary,
  rangeStart: string | null,
): string | null {
  if (!summary.anchoredSpans || !summary.skippedSpans) return equityCurveCaption(summary);
  const inRange = (s: DateSpan) => rangeStart === null || s.to >= rangeStart;
  const anchored = summary.anchoredSpans.filter(inRange);
  const skipped = summary.skippedSpans.filter(inRange);
  const sparse = (summary.sparseSpans ?? []).filter(inRange);
  const allMonthLong = skipped.length > 0 && skipped.every((s) => spanDays(s) >= 28 && spanDays(s) <= 31);
  return equityCurveCaption(
    {
      ...summary,
      segmentsAnchored: anchored.length,
      segmentsSkipped: skipped.length,
      trailingDays: summary.trailingDays,
    },
    { skippedUnit: allMonthLong ? "month" : "stretch", sparseStretches: sparse.length },
  );
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

export interface EquityCurveYAxis {
  domain: [number, number];
  ticks: number[];
}

function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

/**
 * Value axis that frames the plotted window: the data's own low and high with
 * a tenth of the range as padding on each side, widened to round tick values.
 * An axis that starts at zero squeezes a month's move into a few pixels.
 *
 * The step is never finer than the axis label can state exactly (two decimals
 * of a million or of a thousand), so no gridline is mislabelled. A series
 * that is never negative is never padded below zero. Null when there is no
 * finite value (the caller leaves the chart's default axis in place).
 */
export function equityCurveYAxis(values: number[], targetTicks = 5): EquityCurveYAxis | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const range = max - min;
  const pad = range > 0 ? range * 0.1 : Math.abs(max) * 0.05 || 1;
  const lo0 = min >= 0 ? Math.max(0, min - pad) : min - pad;
  const hi0 = max + pad;

  const top = Math.max(Math.abs(min), Math.abs(max));
  const finest = top >= 1_000_000 ? 10_000 : top >= 1_000 ? 10 : 1;
  const step = Math.max(niceStep((hi0 - lo0) / Math.max(1, targetTicks - 1)), finest);

  const loSteps = Math.floor(lo0 / step);
  let hiSteps = Math.ceil(hi0 / step);
  if (hiSteps === loSteps) hiSteps++;
  const ticks: number[] = [];
  for (let k = loSteps; k <= hiSteps; k++) ticks.push(k * step);
  return { domain: [ticks[0], ticks[ticks.length - 1]], ticks };
}

export type EquityCurveGranularity = "daily" | "monthly" | "mixed";

/**
 * What the plotted window is made of, from the spacing of its points: every
 * point within SHORT_SEGMENT_MAX_DAYS of the one before it is "daily", none is
 * "monthly" (statement dates only), a blend is "mixed". `dates` must be
 * sorted ascending. Null with fewer than two points.
 */
export function equityCurveGranularity(dates: string[]): EquityCurveGranularity | null {
  if (dates.length < 2) return null;
  let close = 0;
  let far = 0;
  for (let i = 1; i < dates.length; i++) {
    if (dayNumber(dates[i]) - dayNumber(dates[i - 1]) <= SHORT_SEGMENT_MAX_DAYS) close++;
    else far++;
  }
  if (far === 0) return "daily";
  if (close === 0) return "monthly";
  return "mixed";
}

// ─── Time axis ──────────────────────────────────────────────────
//
// The chart's horizontal axis is elapsed time, not point index: a series that
// is monthly for years and daily for months would otherwise give each recent
// day the width of a whole early month. Dates are plain YYYY-MM-DD, so every
// conversion and every label is done at UTC midnight -- a browser west of UTC
// must never show the previous day.

/** YYYY-MM-DD → epoch milliseconds at UTC midnight. NaN for anything else. */
export function isoDateToEpochMs(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** Epoch milliseconds → the YYYY-MM-DD it falls on in UTC. */
export function epochMsToIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Chart rows with their horizontal position `t` (epoch ms), ordered by real
 * date. A numeric axis draws the line in row order, so the order is set here
 * and not left to the caller. No row is added: a stretch with no stored point
 * stays the straight segment between its two neighbours. A row whose date is
 * not YYYY-MM-DD has no position and is left out.
 */
export function toTimeSeries<T extends { date: string }>(rows: T[]): (T & { t: number })[] {
  return rows
    .map((r) => ({ ...r, t: isoDateToEpochMs(r.date) }))
    .filter((r) => Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t);
}

export type EquityCurveTickUnit = "week" | "half-month" | "month" | "quarter" | "year";

export interface EquityCurveTimeTicks {
  /** Epoch ms, ascending, all inside [start, end]. */
  ticks: number[];
  unit: EquityCurveTickUnit;
}

/** Longest range (in days) each tick step serves; beyond the last, yearly. */
export const TICK_BAND_MAX_DAYS = {
  week: 45,
  "half-month": 200,
  month: 550, // about 18 months
  quarter: 1830, // about 5 years
} as const;

/** Most yearly ticks drawn; a longer history steps by whole years. */
export const MAX_YEAR_TICKS = 12;

/**
 * Calendar-aligned axis ticks for the plotted range, with the step chosen from
 * the range length so labels never overprint: fixed days of the month (1, 8,
 * 15, 22) up to 45 days, the 1st and 15th up to 200 days, month starts up to
 * about 18 months, quarter starts up to about 5 years, 1 January beyond (every
 * Nth year past MAX_YEAR_TICKS). Ticks are calendar dates, not data points, so
 * they do not slide as the window moves. When no calendar tick falls inside
 * the range, its two ends are the ticks.
 */
export function equityCurveTimeTicks(startMs: number, endMs: number): EquityCurveTimeTicks {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return { ticks: [], unit: "month" };
  }
  const days = (endMs - startMs) / DAY_MS;
  const unit: EquityCurveTickUnit =
    days <= TICK_BAND_MAX_DAYS.week
      ? "week"
      : days <= TICK_BAND_MAX_DAYS["half-month"]
        ? "half-month"
        : days <= TICK_BAND_MAX_DAYS.month
          ? "month"
          : days <= TICK_BAND_MAX_DAYS.quarter
            ? "quarter"
            : "year";

  const start = new Date(startMs);
  const end = new Date(endMs);
  const y0 = start.getUTCFullYear();
  const y1 = end.getUTCFullYear();
  const yearStep = unit === "year" ? Math.max(1, Math.ceil((y1 - y0 + 1) / MAX_YEAR_TICKS)) : 1;
  const monthsOfYear =
    unit === "year" ? [0] : unit === "quarter" ? [0, 3, 6, 9] : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const daysOfMonth = unit === "week" ? [1, 8, 15, 22] : unit === "half-month" ? [1, 15] : [1];

  const ticks: number[] = [];
  for (let y = y0; y <= y1; y++) {
    if (unit === "year" && y % yearStep !== 0) continue;
    for (const m of monthsOfYear) {
      for (const d of daysOfMonth) {
        const t = Date.UTC(y, m, d);
        if (t >= startMs && t <= endMs) ticks.push(t);
      }
    }
  }
  if (ticks.length === 0) return { ticks: startMs === endMs ? [startMs] : [startMs, endMs], unit };
  return { ticks, unit };
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type EquityCurveDateStyle = "day" | "month-year" | "full" | "year";

/**
 * A plotted date as text, always read in UTC: "Jun 5" (day), "Jun '26"
 * (month-year), "Jun 5, 2026" (full), "2026" (year).
 *
 * The month-year form carries an apostrophe before the two-digit year: a
 * bare "Jun 26" reads as the 26th of June, the same text the day form
 * prints for that date.
 */
export function formatEquityCurveDate(ms: number, style: EquityCurveDateStyle): string {
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms);
  if (style === "year") return String(d.getUTCFullYear());
  if (style === "day") return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  if (style === "month-year") {
    const yy = String(d.getUTCFullYear() % 100).padStart(2, "0");
    return `${SHORT_MONTHS[d.getUTCMonth()]} '${yy}`;
  }
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Axis tick label for a tick step: a day of the month below monthly steps,
 * month and apostrophe two-digit year ("Jun '26") for month and quarter
 * starts, the year for yearly.
 */
export function formatEquityCurveTick(ms: number, unit: EquityCurveTickUnit): string {
  return formatEquityCurveDate(
    ms,
    unit === "year" ? "year" : unit === "month" || unit === "quarter" ? "month-year" : "day",
  );
}

/**
 * The date (YYYY-MM-DD) a tooltip is showing. The hovered point's own `date`
 * is the key, so the tooltip names the same date as the stored row whatever
 * the axis does; the axis label (epoch ms, or a Date from a time scale) is the
 * fallback. Null when neither yields a date.
 */
export function equityCurveTooltipDate(label: unknown, payload?: unknown): string | null {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const date = (item as { payload?: { date?: unknown } } | null | undefined)?.payload?.date;
      if (typeof date === "string" && Number.isFinite(isoDateToEpochMs(date))) return date;
    }
  }
  if (typeof label === "string" && Number.isFinite(isoDateToEpochMs(label))) return label;
  const ms = label instanceof Date ? label.getTime() : typeof label === "number" ? label : Number.NaN;
  return Number.isFinite(ms) ? epochMsToIsoDate(ms) : null;
}
