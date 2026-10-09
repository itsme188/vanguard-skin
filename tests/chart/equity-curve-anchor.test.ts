import { describe, it, expect } from "vitest";
import {
  anchorDailiesToStatements,
  equityCurveCaption,
  equityCurveRangeCaption,
  formatAnchoredTooltipValue,
  MAX_REFERENCE_LOOKBACK_DAYS,
  MIN_SEGMENT_DAILIES,
  SHORT_SEGMENT_MAX_DAYS,
  type EquityAnchor,
  type EquityDaily,
} from "@/lib/chart/equity-curve-anchor";

// Synthetic figures only — this repo is public.
const A = (date: string, value: number): EquityAnchor => ({ date, value });
const D = (date: string, value: number): EquityDaily => ({ date, value });

function interior(points: ReturnType<typeof anchorDailiesToStatements>["points"]) {
  return points.filter((p) => !p.isAnchor);
}

describe("anchorDailiesToStatements — shape-preserving anchor correction", () => {
  it("(a) rise-then-fall segment keeps the drawdown ordering and both anchors plot exactly", () => {
    const anchors = [A("2026-01-31", 1000), A("2026-02-28", 1030)];
    // Dailies run a constant 50 below the statements (e.g. missing cash),
    // rise to a peak mid-month, then fall.
    const dailies = [
      D("2026-01-31", 950),
      D("2026-02-05", 970),
      D("2026-02-10", 1010),
      D("2026-02-15", 990),
      D("2026-02-20", 960),
      D("2026-02-28", 980),
    ];
    const { points, summary } = anchorDailiesToStatements(anchors, dailies);

    const first = points.find((p) => p.date === "2026-01-31")!;
    const last = points.find((p) => p.date === "2026-02-28")!;
    expect(first).toMatchObject({ value: 1000, isAnchor: true, recordedValue: null });
    expect(last).toMatchObject({ value: 1030, isAnchor: true, recordedValue: null });
    // No duplicate point on an anchor date.
    expect(points.filter((p) => p.date === "2026-01-31")).toHaveLength(1);
    expect(points.filter((p) => p.date === "2026-02-28")).toHaveLength(1);

    const mid = interior(points);
    expect(mid.map((p) => p.date)).toEqual([
      "2026-02-05",
      "2026-02-10",
      "2026-02-15",
      "2026-02-20",
    ]);
    // Offset is a constant 50 at both ends, so every plotted day is recorded + 50.
    for (const p of mid) expect(p.value).toBeCloseTo(p.recordedValue! + 50, 9);
    // Shape: up, then down, then down — the drawdown survives.
    const v = mid.map((p) => p.value);
    expect(v[1]).toBeGreaterThan(v[0]);
    expect(v[2]).toBeLessThan(v[1]);
    expect(v[3]).toBeLessThan(v[2]);
    expect(summary).toMatchObject({ segmentsAnchored: 1, segmentsSkipped: 0 });
  });

  it("(b) daily range opposite in sign to the anchor range: the recorded low still plots as the segment low (no inversion)", () => {
    // Statements rise 1000 -> 1040 while the dailies' own end-to-end change is
    // negative (they start high and finish lower) with a deep mid-month low.
    const anchors = [A("2026-03-31", 1000), A("2026-04-30", 1040)];
    const dailies = [
      D("2026-04-02", 1000),
      D("2026-04-08", 990),
      D("2026-04-14", 930), // recorded low
      D("2026-04-20", 960),
      D("2026-04-28", 985),
    ];
    const { points, summary } = anchorDailiesToStatements(anchors, dailies);
    const mid = interior(points);
    const low = mid.reduce((m, p) => (p.value < m.value ? p : m));
    expect(low.date).toBe("2026-04-14");
    expect(low.recordedValue).toBe(930);
    // The low sits below both neighbouring anchors' line — it is a real dip.
    expect(low.value).toBeLessThan(1000);
    // Anchors exact.
    expect(points[0]).toMatchObject({ date: "2026-03-31", value: 1000, isAnchor: true });
    expect(points[points.length - 1]).toMatchObject({ date: "2026-04-30", value: 1040, isAnchor: true });
    expect(summary.segmentsSkipped).toBe(0);
  });

  it("time-spreads the offset linearly between the two anchor gaps", () => {
    const anchors = [A("2026-01-01", 1000), A("2026-01-11", 1100)];
    const dailies = [
      D("2026-01-01", 1000), // gap 0 at d0
      D("2026-01-04", 1000),
      D("2026-01-06", 1000),
      D("2026-01-08", 1000),
      D("2026-01-11", 1000), // gap 100 at d1
    ];
    const mid = interior(anchorDailiesToStatements(anchors, dailies).points);
    expect(mid.map((p) => p.value)).toEqual([1030, 1050, 1070]);
  });

  it("with no daily on the anchor date, the start offset is measured from the last recorded daily before it", () => {
    const anchors = [A("2026-01-11", 1000), A("2026-01-21", 1000)];
    const dailies = [
      D("2026-01-09", 900), // last at or before d0 (2 days earlier) -> gap0 = 100
      D("2026-01-12", 880), // a 20-point recorded drop on the first trading day
      D("2026-01-16", 900),
      D("2026-01-20", 950), // last at or before d1 -> gap1 = 50
    ];
    const mid = interior(anchorDailiesToStatements(anchors, dailies).points);
    // offset(d) = 100 + t * (50 - 100), t = days from d0 / 10
    expect(mid[0].value).toBeCloseTo(880 + 95, 9);
    expect(mid[1].value).toBeCloseTo(900 + 75, 9);
    expect(mid[2].value).toBeCloseTo(950 + 55, 9);
    // The 20-point drop survives (less the day's 5-point share of drift).
    expect(mid[0].value).toBeCloseTo(1000 - 20 + 0 - 5, 9);
  });

  it("weekend month-end: Monday's recorded 5-point drop is kept, not spread across the month", () => {
    const anchors = [A("2026-05-31", 200), A("2026-06-30", 190)];
    const dailies = [
      D("2026-05-29", 100), // Friday, the last value at or before the Sunday anchor
      D("2026-06-01", 95), // Monday: -5 recorded
      D("2026-06-02", 95),
      D("2026-06-03", 95),
      D("2026-06-04", 95),
      D("2026-06-29", 95),
    ];
    const { points } = anchorDailiesToStatements(anchors, dailies);
    // gap0 = 200 - 100 = 100; gap1 = 190 - 95 = 95 (06-29 is the last daily at or before 06-30).
    // Monday: offset = 100 - 5 * (1/30) -> 194.833...; the old behaviour gave 199.67.
    const mon = points.find((p) => p.date === "2026-06-01")!;
    expect(mon.value).toBeCloseTo(95 + 100 - 5 / 30, 9);
    // A visible drop of ~5 from the 200 anchor (to within one day's drift share).
    expect(Math.abs(200 - mon.value - 5)).toBeLessThanOrEqual(5 / 30 + 1e-9);
    // Both anchors exact, every point finite.
    expect(points[0]).toMatchObject({ date: "2026-05-31", value: 200, isAnchor: true });
    expect(points[points.length - 1]).toMatchObject({ date: "2026-06-30", value: 190, isAnchor: true });
    for (const p of points) expect(Number.isFinite(p.value)).toBe(true);
  });

  it("holiday month-end: a prior daily 3 calendar days before the anchor is the start reference", () => {
    const anchors = [A("2026-08-31", 500), A("2026-09-30", 500)];
    const dailies = [
      D("2026-08-28", 400), // 3 days before the anchor -> gap0 = 100
      D("2026-09-01", 380), // -20 recorded
      D("2026-09-10", 380),
      D("2026-09-20", 380),
      D("2026-09-30", 400), // on the end anchor -> gap1 = 100
    ];
    const mid = interior(anchorDailiesToStatements(anchors, dailies).points);
    // Constant offset 100, so every plotted day is recorded + 100 and the drop survives intact.
    expect(mid.map((p) => p.value)).toEqual([480, 480, 480]);
  });

  it(`a prior daily older than ${MAX_REFERENCE_LOOKBACK_DAYS} calendar days is not used: falls back to the first in-segment daily`, () => {
    const anchors = [A("2026-05-31", 200), A("2026-06-30", 200)];
    const dailies = [
      D("2026-05-20", 100), // 11 days before: too stale to be a reference
      D("2026-06-01", 95), // fallback reference -> gap0 = 105
      D("2026-06-10", 95),
      D("2026-06-20", 95),
      D("2026-06-30", 95), // gap1 = 105
    ];
    const mid = interior(anchorDailiesToStatements(anchors, dailies).points);
    expect(mid.map((p) => p.value)).toEqual([200, 200, 200]);
  });

  it("the lookback is inclusive at the limit", () => {
    const anchors = [A("2026-05-31", 200), A("2026-06-30", 200)];
    const limitDay = new Date(Date.UTC(2026, 4, 31) - MAX_REFERENCE_LOOKBACK_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const dailies = [
      D(limitDay, 100), // exactly at the limit -> gap0 = 100
      D("2026-06-01", 95),
      D("2026-06-10", 95),
      D("2026-06-20", 95),
      D("2026-06-30", 100), // gap1 = 100
    ];
    const mid = interior(anchorDailiesToStatements(anchors, dailies).points);
    expect(mid.map((p) => p.value)).toEqual([195, 195, 195]);
  });

  it(`(c) a segment with fewer than ${MIN_SEGMENT_DAILIES} dailies is skipped (anchors only)`, () => {
    const anchors = [A("2026-01-31", 1000), A("2026-02-28", 1050)];
    const dailies = [D("2026-02-14", 1200)];
    const { points, summary } = anchorDailiesToStatements(anchors, dailies);
    expect(points).toEqual([
      { date: "2026-01-31", value: 1000, recordedValue: null, isAnchor: true },
      { date: "2026-02-28", value: 1050, recordedValue: null, isAnchor: true },
    ]);
    expect(summary.segmentsSkipped).toBe(1);
    expect(summary.segmentsAnchored).toBe(0);
  });

  it(`a short span (<= ${SHORT_SEGMENT_MAX_DAYS} days) with one daily is plotted with the offset and not counted as skipped`, () => {
    // Two live broker snapshots three days apart, one recorded day between.
    const anchors = [A("2026-09-01", 1000), A("2026-09-04", 1030)];
    const dailies = [D("2026-09-02", 960)];
    const { points, summary } = anchorDailiesToStatements(anchors, dailies);
    // reference is the only daily for both ends: gap0 = 40, gap1 = 70; t = 1/3 -> offset 50
    expect(points).toEqual([
      { date: "2026-09-01", value: 1000, recordedValue: null, isAnchor: true },
      { date: "2026-09-02", value: 1010, recordedValue: 960, isAnchor: false },
      { date: "2026-09-04", value: 1030, recordedValue: null, isAnchor: true },
    ]);
    expect(summary.segmentsSkipped).toBe(0);
    expect(summary.segmentsAnchored).toBe(1);
  });

  it("a short span skips no consistency gate either (never counted as skipped)", () => {
    const anchors = [A("2026-09-01", 1000), A("2026-09-06", 1000)];
    const dailies = [D("2026-09-02", 1000), D("2026-09-03", 500)];
    const { summary } = anchorDailiesToStatements(anchors, dailies);
    expect(summary.segmentsSkipped).toBe(0);
  });

  it("a 30-day span with one daily is skipped", () => {
    const anchors = [A("2026-08-01", 1000), A("2026-08-31", 1030)];
    const { points, summary } = anchorDailiesToStatements(anchors, [D("2026-08-15", 990)]);
    expect(points.every((p) => p.isAnchor)).toBe(true);
    expect(summary.segmentsSkipped).toBe(1);
  });

  it("skips a segment whose dailies swing more than 30% of their mean (incomplete extraction)", () => {
    const anchors = [A("2026-01-31", 1000), A("2026-02-28", 1000)];
    const dailies = [
      D("2026-02-05", 1000),
      D("2026-02-10", 500),
      D("2026-02-15", 1000),
      D("2026-02-20", 990),
    ];
    const { points, summary } = anchorDailiesToStatements(anchors, dailies);
    expect(points.every((p) => p.isAnchor)).toBe(true);
    expect(summary.segmentsSkipped).toBe(1);
  });

  it("skips trailing dailies that swing more than 30% of their mean, and says so", () => {
    const anchors = [A("2026-05-31", 2000)];
    const dailies = [D("2026-05-31", 1000), D("2026-06-01", 1000), D("2026-06-02", 400), D("2026-06-03", 990)];
    const { points, summary } = anchorDailiesToStatements(anchors, dailies);
    expect(points.every((p) => p.isAnchor)).toBe(true);
    expect(summary.trailingDays).toBe(0);
    expect(summary.trailingSkipped).toBe(true);
  });

  it("a skipped segment is never also counted as sparse", () => {
    const anchors = [A("2026-01-31", 1000), A("2026-02-28", 1000)];
    const dailies = [D("2026-02-02", 1000), D("2026-02-03", 400), D("2026-02-04", 1000)];
    const { summary } = anchorDailiesToStatements(anchors, dailies);
    expect(summary.skippedSpans).toEqual([{ from: "2026-01-31", to: "2026-02-28" }]);
    expect(summary.sparseSpans).toEqual([]);
    expect(summary.anchoredSpans).toEqual([]);
  });

  it("a run with a gap over 7 days between plotted points is recorded as sparse", () => {
    const anchors = [A("2026-01-31", 1000), A("2026-02-28", 1000)];
    const dailies = [D("2026-02-02", 1000), D("2026-02-03", 1000), D("2026-02-04", 1000)];
    const { summary } = anchorDailiesToStatements(anchors, dailies);
    expect(summary.sparseSpans).toEqual([{ from: "2026-01-31", to: "2026-02-28" }]);
    const dense = Array.from({ length: 20 }, (_, i) => D(`2026-02-${String(i + 2).padStart(2, "0")}`, 1000));
    expect(anchorDailiesToStatements(anchors, dense).summary.sparseSpans).toEqual([]);
  });

  it("(d) trailing dailies after the last anchor carry a constant offset; the last anchor stays exact", () => {
    const anchors = [A("2026-05-31", 2000)];
    const dailies = [
      D("2026-05-31", 1900), // gap 100
      D("2026-06-01", 1910),
      D("2026-06-02", 1880),
      D("2026-06-03", 1950),
    ];
    const { points, summary } = anchorDailiesToStatements(anchors, dailies);
    expect(points[0]).toEqual({ date: "2026-05-31", value: 2000, recordedValue: null, isAnchor: true });
    expect(points.slice(1)).toEqual([
      { date: "2026-06-01", value: 2010, recordedValue: 1910, isAnchor: false },
      { date: "2026-06-02", value: 1980, recordedValue: 1880, isAnchor: false },
      { date: "2026-06-03", value: 2050, recordedValue: 1950, isAnchor: false },
    ]);
    expect(summary.trailingDays).toBe(3);
    expect(summary.trailingSkipped).toBe(false);
  });

  it("trailing with no daily on the anchor date measures the offset from the last daily before it (Monday's move survives)", () => {
    const anchors = [A("2026-05-31", 2000)]; // a Sunday
    const dailies = [D("2026-05-29", 1000), D("2026-06-01", 950), D("2026-06-02", 1100)];
    const { points } = anchorDailiesToStatements(anchors, dailies);
    // gap = 2000 - 1000 = 1000 (Friday), added: Monday shows the 50-point drop (a first-trailing
    // reference would have plotted 2000 and erased it; a x2 scale would give 2200 for the last day).
    expect(points.slice(1).map((p) => p.value)).toEqual([1950, 2100]);
  });

  it("trailing with no daily within the lookback before the anchor falls back to the first trailing daily", () => {
    const anchors = [A("2026-05-31", 2000)];
    const dailies = [D("2026-05-10", 900), D("2026-06-01", 1000), D("2026-06-02", 1100)];
    const { points } = anchorDailiesToStatements(anchors, dailies);
    expect(points.slice(1).map((p) => p.value)).toEqual([2000, 2100]);
  });

  it("(e) no dailies at all: anchors only, nothing skipped", () => {
    const anchors = [A("2026-02-28", 1050), A("2026-01-31", 1000)];
    const { points, summary } = anchorDailiesToStatements(anchors, []);
    expect(points).toEqual([
      { date: "2026-01-31", value: 1000, recordedValue: null, isAnchor: true },
      { date: "2026-02-28", value: 1050, recordedValue: null, isAnchor: true },
    ]);
    expect(summary).toEqual({
      segmentsAnchored: 0,
      segmentsSkipped: 0,
      trailingDays: 0,
      trailingSkipped: false,
      anchoredSpans: [],
      skippedSpans: [],
      sparseSpans: [],
    });
  });

  it("no anchors: no points (the chart shows its empty state)", () => {
    const { points } = anchorDailiesToStatements([], [D("2026-01-02", 1)]);
    expect(points).toEqual([]);
  });

  it("a segment with no dailies (pre-daily history) is not counted as skipped", () => {
    const anchors = [A("2025-11-30", 900), A("2025-12-31", 950), A("2026-01-31", 1000)];
    const { summary } = anchorDailiesToStatements(anchors, [D("2026-02-02", 990)]);
    expect(summary.segmentsSkipped).toBe(0);
  });
});

describe("equityCurveCaption", () => {
  const base = { segmentsAnchored: 0, segmentsSkipped: 0, trailingDays: 0, trailingSkipped: false };

  it("no daily data plotted and nothing skipped: no caption", () => {
    expect(equityCurveCaption(base)).toBeNull();
  });

  it("anchored dailies", () => {
    expect(equityCurveCaption({ ...base, segmentsAnchored: 4 })).toBe(
      "Daily values anchored to statement and broker snapshot values",
    );
    expect(equityCurveCaption({ ...base, trailingDays: 5 })).toBe(
      "Daily values anchored to statement and broker snapshot values",
    );
  });

  it("anchored dailies with skipped segments", () => {
    expect(equityCurveCaption({ ...base, segmentsAnchored: 4, segmentsSkipped: 2 })).toBe(
      "Daily values anchored to statement and broker snapshot values · 2 months plotted from statements only",
    );
    expect(equityCurveCaption({ ...base, segmentsAnchored: 4, segmentsSkipped: 1 })).toBe(
      "Daily values anchored to statement and broker snapshot values · 1 month plotted from statements only",
    );
  });

  it("every segment skipped", () => {
    expect(equityCurveCaption({ ...base, segmentsSkipped: 3 })).toBe(
      "Daily values too incomplete to plot · 3 months plotted from statements only",
    );
  });

  it("trailing dailies skipped", () => {
    expect(equityCurveCaption({ ...base, segmentsAnchored: 2, trailingSkipped: true })).toBe(
      "Daily values anchored to statement and broker snapshot values · days after the last statement not plotted",
    );
  });
});

describe("formatAnchoredTooltipValue", () => {
  const fmt = (v: number) => `$${Math.round(v)}`;

  it("shows only the value for an anchor or a point with no recorded daily", () => {
    expect(formatAnchoredTooltipValue(1000, null, fmt)).toBe("$1000");
  });

  it("shows the recorded daily alongside the plotted value when they differ", () => {
    expect(formatAnchoredTooltipValue(1050, 1000, fmt)).toBe("$1050 · recorded $1000");
  });

  it("shows only the value when the two round to the same dollar", () => {
    expect(formatAnchoredTooltipValue(1000.2, 1000.1, fmt)).toBe("$1000");
  });

  it("routes both figures through the supplied (privacy) formatter", () => {
    const mask = () => "•••";
    expect(formatAnchoredTooltipValue(1050, 1000, mask)).toBe("••• · recorded •••");
  });
});

describe("equityCurveRangeCaption", () => {
  const base = {
    segmentsAnchored: 0,
    segmentsSkipped: 0,
    trailingDays: 0,
    trailingSkipped: false,
    anchoredSpans: [],
    skippedSpans: [],
    sparseSpans: [],
  };
  const old = { from: "2025-02-01", to: "2025-02-15" };
  const recent = { from: "2026-08-31", to: "2026-09-30" };

  it("counts only spans that end inside the selected range", () => {
    const summary = {
      ...base,
      segmentsAnchored: 1,
      segmentsSkipped: 2,
      anchoredSpans: [recent],
      skippedSpans: [old, { from: "2026-07-31", to: "2026-08-31" }],
    };
    expect(equityCurveRangeCaption(summary, null)).toBe(
      "Daily values anchored to statement and broker snapshot values · 2 stretches plotted from statements only",
    );
    expect(equityCurveRangeCaption(summary, "2026-08-01")).toBe(
      "Daily values anchored to statement and broker snapshot values · 1 month plotted from statements only",
    );
  });

  it("says nothing about skipped history outside the range", () => {
    const summary = { ...base, segmentsAnchored: 1, segmentsSkipped: 1, anchoredSpans: [recent], skippedSpans: [old] };
    expect(equityCurveRangeCaption(summary, "2026-08-01")).toBe(
      "Daily values anchored to statement and broker snapshot values",
    );
  });

  it("uses stretches, not months, for a short skipped gap", () => {
    const summary = {
      ...base,
      segmentsAnchored: 1,
      segmentsSkipped: 1,
      anchoredSpans: [recent],
      skippedSpans: [{ from: "2026-09-01", to: "2026-09-12" }],
    };
    expect(equityCurveRangeCaption(summary, null)).toContain("1 stretch plotted from statements only");
  });

  it("captions sparse runs", () => {
    const summary = { ...base, segmentsAnchored: 1, anchoredSpans: [recent], sparseSpans: [recent] };
    expect(equityCurveRangeCaption(summary, null)).toBe(
      "Daily values anchored to statement and broker snapshot values · 1 stretch with gaps drawn as straight lines",
    );
  });

  it("null when nothing in range is plotted or skipped", () => {
    expect(equityCurveRangeCaption({ ...base, skippedSpans: [old], segmentsSkipped: 1 }, "2026-08-01")).toBeNull();
  });
});

describe("anchorDailiesToStatements — spread check is net of deposits and withdrawals", () => {
  // Dailies sit at 1000 until a deposit of 500 lands on 02-15, then at 1500:
  // a 40% swing of the mean that is entirely money movement.
  const anchors = [A("2026-01-31", 1000), A("2026-02-28", 1500)];
  const dailies = [
    D("2026-01-31", 1000),
    D("2026-02-05", 1000),
    D("2026-02-10", 1000),
    D("2026-02-15", 1500),
    D("2026-02-20", 1500),
    D("2026-02-28", 1500),
  ];

  it("a jump that is only a deposit is plotted", () => {
    const flows = [{ date: "2026-02-15", netFlow: 500 }];
    const { points, summary } = anchorDailiesToStatements(anchors, dailies, flows);
    expect(summary.segmentsSkipped).toBe(0);
    expect(summary.segmentsAnchored).toBe(1);
    expect(interior(points).length).toBeGreaterThan(0);
    // The plotted values are NOT flow-adjusted.
    expect(interior(points).find((p) => p.date === "2026-02-20")!.recordedValue).toBe(1500);
  });

  it("the same jump with no flow is still refused", () => {
    for (const flows of [undefined, []]) {
      const { points, summary } = anchorDailiesToStatements(anchors, dailies, flows);
      expect(summary.segmentsSkipped).toBe(1);
      expect(interior(points)).toHaveLength(0);
    }
  });

  it("a withdrawal (negative flow) explains a drop", () => {
    const a = [A("2026-01-31", 1500), A("2026-02-28", 1000)];
    const d = [
      D("2026-01-31", 1500),
      D("2026-02-05", 1500),
      D("2026-02-10", 1500),
      D("2026-02-15", 1000),
      D("2026-02-20", 1000),
      D("2026-02-28", 1000),
    ];
    const flows = [{ date: "2026-02-15", netFlow: -500 }];
    expect(anchorDailiesToStatements(a, d, flows).summary.segmentsSkipped).toBe(0);
    // A deposit of the wrong sign does not help.
    expect(anchorDailiesToStatements(a, d, [{ date: "2026-02-15", netFlow: 500 }]).summary.segmentsSkipped).toBe(1);
  });

  it("flows outside the segment do not help", () => {
    const flows = [
      { date: "2026-01-31", netFlow: 500 }, // on the start anchor: before the segment
      { date: "2026-03-05", netFlow: 500 }, // after the segment
    ];
    expect(anchorDailiesToStatements(anchors, dailies, flows).summary.segmentsSkipped).toBe(1);
  });

  it("a flow that does not explain the swing does not hide it", () => {
    const flows = [{ date: "2026-02-15", netFlow: 100 }];
    expect(anchorDailiesToStatements(anchors, dailies, flows).summary.segmentsSkipped).toBe(1);
  });

  it("trailing segment: a deposit-only jump after the last anchor is plotted", () => {
    const a = [A("2026-01-31", 1000)];
    const d = [
      D("2026-01-31", 1000),
      D("2026-02-05", 1000),
      D("2026-02-10", 1000),
      D("2026-02-15", 1500),
      D("2026-02-20", 1500),
    ];
    const noFlow = anchorDailiesToStatements(a, d);
    expect(noFlow.summary.trailingSkipped).toBe(true);
    const withFlow = anchorDailiesToStatements(a, d, [{ date: "2026-02-15", netFlow: 500 }]);
    expect(withFlow.summary.trailingSkipped).toBe(false);
    expect(withFlow.summary.trailingDays).toBe(4);
  });
});
