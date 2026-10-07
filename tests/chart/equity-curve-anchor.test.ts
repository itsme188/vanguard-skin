import { describe, it, expect } from "vitest";
import {
  anchorDailiesToStatements,
  equityCurveCaption,
  formatAnchoredTooltipValue,
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

  it("uses the nearest recorded daily inside the segment when no daily falls on an anchor date", () => {
    const anchors = [A("2026-01-01", 1000), A("2026-01-11", 1000)];
    const dailies = [
      D("2026-01-02", 900), // nearest to d0 -> gap 100
      D("2026-01-06", 920),
      D("2026-01-10", 950), // nearest to d1 -> gap 50
    ];
    const mid = interior(anchorDailiesToStatements(anchors, dailies).points);
    // offset(d) = 100 + t * (50 - 100), t = days from d0 / 10
    expect(mid[0].value).toBeCloseTo(900 + 95, 9);
    expect(mid[1].value).toBeCloseTo(920 + 75, 9);
    expect(mid[2].value).toBeCloseTo(950 + 55, 9);
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

  it("trailing with no daily on the anchor date references the first trailing daily (no multiplicative rescale)", () => {
    const anchors = [A("2026-05-31", 2000)];
    const dailies = [D("2026-06-01", 1000), D("2026-06-02", 1100)];
    const { points } = anchorDailiesToStatements(anchors, dailies);
    // gap = 2000 - 1000 = 1000, added (a ×2 scale would give 2200 for the second day)
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
