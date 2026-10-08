/**
 * C04 -- the equity curve's horizontal axis is elapsed time.
 *
 * Pure conversions behind the three Recharts time axes: date -> epoch at UTC
 * midnight, date-ordered rows, calendar ticks stepped by range length, and
 * UTC labels. Every fixture is synthetic.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MAX_YEAR_TICKS,
  anchorDailiesToStatements,
  epochMsToIsoDate,
  equityCurveTimeTicks,
  equityCurveTooltipDate,
  formatEquityCurveDate,
  formatEquityCurveTick,
  isoDateToEpochMs,
  toTimeSeries,
} from "@/lib/chart/equity-curve-anchor";

const DAY = 86_400_000;
const ms = isoDateToEpochMs;
const iso = (ticks: number[]) => ticks.map(epochMsToIsoDate);

describe("isoDateToEpochMs / epochMsToIsoDate", () => {
  it("is UTC midnight of the calendar date", () => {
    expect(ms("2026-01-01")).toBe(Date.UTC(2026, 0, 1));
    expect(ms("2024-02-29")).toBe(Date.UTC(2024, 1, 29));
    expect(ms("2026-03-09") - ms("2026-03-08")).toBe(DAY); // no daylight-saving hour
  });

  it("round-trips", () => {
    for (const d of ["2022-01-31", "2024-02-29", "2026-10-07", "2026-12-31"]) {
      expect(epochMsToIsoDate(ms(d))).toBe(d);
    }
  });

  it("is NaN for anything that is not YYYY-MM-DD", () => {
    for (const bad of ["", "2026-1-5", "2026-01-05T00:00:00", "Jan 5", "1767225600000"]) {
      expect(Number.isNaN(ms(bad))).toBe(true);
    }
  });
});

describe("toTimeSeries", () => {
  it("orders rows by real date and keeps every field", () => {
    const rows = [
      { date: "2026-03-02", total: 30 },
      { date: "2025-12-31", total: 10 },
      { date: "2026-01-31", total: 20 },
    ];
    const out = toTimeSeries(rows);
    expect(out.map((r) => r.date)).toEqual(["2025-12-31", "2026-01-31", "2026-03-02"]);
    expect(out.map((r) => r.total)).toEqual([10, 20, 30]);
    expect(out.map((r) => r.t)).toEqual(out.map((r) => ms(r.date)));
    expect(rows[0].date).toBe("2026-03-02"); // input not mutated
  });

  it("adds no point: a gap stays one segment between its two neighbours", () => {
    const out = toTimeSeries([
      { date: "2026-01-31", total: 100 },
      { date: "2026-04-30", total: 130 },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1].t - out[0].t).toBe(89 * DAY);
  });

  it("positions are proportional to elapsed days: a month is ~30x a day", () => {
    const out = toTimeSeries([
      { date: "2026-05-31" },
      { date: "2026-06-30" },
      { date: "2026-07-01" },
    ]);
    expect((out[1].t - out[0].t) / (out[2].t - out[1].t)).toBe(30);
  });

  it("leaves out a row with no usable date", () => {
    expect(toTimeSeries([{ date: "2026-01-31" }, { date: "n/a" }])).toHaveLength(1);
  });

  it("keeps the anchored curve's values and dates untouched", () => {
    const { points } = anchorDailiesToStatements(
      [
        { date: "2026-01-31", value: 1000 },
        { date: "2026-02-28", value: 1100 },
      ],
      [
        { date: "2026-02-10", value: 1010 },
        { date: "2026-02-11", value: 1020 },
        { date: "2026-02-12", value: 1030 },
        { date: "2026-02-18", value: 1040 },
        { date: "2026-02-24", value: 1050 },
      ],
    );
    const out = toTimeSeries(points);
    expect(out.map((p) => [p.date, p.value, p.recordedValue])).toEqual(
      points.map((p) => [p.date, p.value, p.recordedValue]),
    );
  });
});

describe("equityCurveTimeTicks", () => {
  it("up to 45 days: days 1, 8, 15, 22 of each month", () => {
    const r = equityCurveTimeTicks(ms("2026-09-07"), ms("2026-10-07"));
    expect(r.unit).toBe("week");
    expect(iso(r.ticks)).toEqual(["2026-09-08", "2026-09-15", "2026-09-22", "2026-10-01"]);
  });

  it("up to 200 days: the 1st and the 15th", () => {
    const r = equityCurveTimeTicks(ms("2026-07-09"), ms("2026-10-07"));
    expect(r.unit).toBe("half-month");
    expect(iso(r.ticks)).toEqual([
      "2026-07-15", "2026-08-01", "2026-08-15", "2026-09-01", "2026-09-15", "2026-10-01",
    ]);
    expect(equityCurveTimeTicks(ms("2026-04-10"), ms("2026-10-07")).unit).toBe("half-month"); // 6M
  });

  it("up to about 18 months: month starts", () => {
    const r = equityCurveTimeTicks(ms("2025-10-07"), ms("2026-10-07")); // 1Y
    expect(r.unit).toBe("month");
    expect(r.ticks).toHaveLength(12);
    expect(iso(r.ticks)[0]).toBe("2025-11-01");
    expect(iso(r.ticks)[11]).toBe("2026-10-01");
    expect(equityCurveTimeTicks(ms("2026-01-01"), ms("2026-10-07")).unit).toBe("month"); // YTD
    expect(equityCurveTimeTicks(ms("2025-04-07"), ms("2026-10-07")).unit).toBe("month"); // 18 months
  });

  it("up to about 5 years: quarter starts", () => {
    const r = equityCurveTimeTicks(ms("2022-05-31"), ms("2026-10-07"));
    expect(r.unit).toBe("quarter");
    expect(r.ticks).toHaveLength(18);
    expect(iso(r.ticks).slice(0, 3)).toEqual(["2022-07-01", "2022-10-01", "2023-01-01"]);
    expect(iso(r.ticks).every((d) => /-(01|04|07|10)-01$/.test(d))).toBe(true);
    expect(equityCurveTimeTicks(ms("2025-03-01"), ms("2026-10-07")).unit).toBe("quarter"); // 19 months
  });

  it("beyond: 1 January, one per year", () => {
    const r = equityCurveTimeTicks(ms("2019-03-31"), ms("2026-10-07"));
    expect(r.unit).toBe("year");
    expect(iso(r.ticks)).toEqual([
      "2020-01-01", "2021-01-01", "2022-01-01", "2023-01-01", "2024-01-01", "2025-01-01", "2026-01-01",
    ]);
  });

  it("a very long history steps by whole years and stays bounded", () => {
    const r = equityCurveTimeTicks(ms("1990-06-30"), ms("2026-10-07"));
    expect(r.unit).toBe("year");
    expect(r.ticks.length).toBeLessThanOrEqual(MAX_YEAR_TICKS + 1);
    const years = iso(r.ticks).map((d) => Number(d.slice(0, 4)));
    expect(new Set(years.slice(1).map((y, i) => y - years[i])).size).toBe(1); // even step
  });

  it("no band prints more ticks than its step allows, and labels never repeat", () => {
    const end = ms("2026-10-07");
    for (const days of [1, 7, 30, 45, 46, 90, 180, 200, 201, 365, 550, 551, 1000, 1830, 1831, 4000, 15000]) {
      const r = equityCurveTimeTicks(end - days * DAY, end);
      expect(r.ticks.length, `${days} days`).toBeLessThanOrEqual(21);
      expect(r.ticks.length, `${days} days`).toBeGreaterThan(0);
      const sorted = [...r.ticks].sort((a, b) => a - b);
      expect(r.ticks).toEqual(sorted);
      expect(r.ticks.every((t) => t >= end - days * DAY && t <= end)).toBe(true);
      const labels = r.ticks.map((t) => formatEquityCurveTick(t, r.unit));
      expect(new Set(labels).size, `${days} days: ${labels.join("|")}`).toBe(labels.length);
    }
  });

  it("years of monthly points plus months of daily points get one tick per quarter, not per point", () => {
    // 50 month-ends then 110 consecutive days: tick count follows the range, not the point count.
    const r = equityCurveTimeTicks(ms("2022-01-31"), ms("2026-07-20"));
    expect(r.unit).toBe("quarter");
    expect(r.ticks.length).toBe(18);
  });

  it("a range holding no calendar tick uses its two ends; a single day uses one", () => {
    expect(iso(equityCurveTimeTicks(ms("2026-10-03"), ms("2026-10-06")).ticks)).toEqual(["2026-10-03", "2026-10-06"]);
    expect(iso(equityCurveTimeTicks(ms("2026-10-03"), ms("2026-10-03")).ticks)).toEqual(["2026-10-03"]);
  });

  it("no data: no ticks", () => {
    expect(equityCurveTimeTicks(Number.NaN, Number.NaN).ticks).toEqual([]);
    expect(equityCurveTimeTicks(undefined as unknown as number, undefined as unknown as number).ticks).toEqual([]);
  });
});

describe("labels", () => {
  it("formatEquityCurveDate styles", () => {
    const t = ms("2026-06-05");
    expect(formatEquityCurveDate(t, "day")).toBe("Jun 5");
    expect(formatEquityCurveDate(t, "month-year")).toBe("Jun 26");
    expect(formatEquityCurveDate(t, "full")).toBe("Jun 5, 2026");
    expect(formatEquityCurveDate(t, "year")).toBe("2026");
    expect(formatEquityCurveDate(Number.NaN, "full")).toBe("");
  });

  it("formatEquityCurveTick follows the tick step", () => {
    const t = ms("2026-01-01");
    expect(formatEquityCurveTick(t, "week")).toBe("Jan 1");
    expect(formatEquityCurveTick(t, "half-month")).toBe("Jan 1");
    expect(formatEquityCurveTick(t, "month")).toBe("Jan 26");
    expect(formatEquityCurveTick(t, "quarter")).toBe("Jan 26");
    expect(formatEquityCurveTick(t, "year")).toBe("2026");
  });
});

describe("equityCurveTooltipDate", () => {
  it("reads the hovered point's own date", () => {
    const payload = [{ payload: { date: "2026-06-05", t: ms("2026-06-05"), total: 100 } }];
    expect(equityCurveTooltipDate(ms("2026-06-05"), payload)).toBe("2026-06-05");
    // the point's date wins even if the axis label disagreed
    expect(equityCurveTooltipDate(ms("2026-06-09"), payload)).toBe("2026-06-05");
  });

  it("falls back to the axis label: epoch, Date, or a date string", () => {
    expect(equityCurveTooltipDate(ms("2026-06-05"), [])).toBe("2026-06-05");
    expect(equityCurveTooltipDate(ms("2026-06-05"))).toBe("2026-06-05");
    expect(equityCurveTooltipDate(new Date(ms("2026-06-05")), undefined)).toBe("2026-06-05");
    expect(equityCurveTooltipDate("2026-06-05", [{ payload: {} }])).toBe("2026-06-05");
  });

  it("null when nothing yields a date", () => {
    expect(equityCurveTooltipDate(undefined, undefined)).toBeNull();
    expect(equityCurveTooltipDate("abc", [null])).toBeNull();
  });

  it("every point of a series shows the date and value it was stored with", () => {
    const rows = [
      { date: "2025-12-31", total: 100 },
      { date: "2026-01-02", total: 101 },
      { date: "2026-03-08", total: 102 },
      { date: "2026-11-01", total: 103 },
    ];
    for (const p of toTimeSeries(rows)) {
      const shown = equityCurveTooltipDate(p.t, [{ payload: p, value: p.total }]);
      expect(shown).toBe(p.date);
      expect(equityCurveTooltipDate(p.t, [])).toBe(p.date); // label alone agrees
      expect(rows.find((r) => r.date === shown)?.total).toBe(p.total);
    }
  });
});

// A date must never move a day with the viewer's time zone.
describe.each(["America/Los_Angeles", "Asia/Tokyo", "UTC"])("under TZ=%s", (tz) => {
  const before = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = tz;
  });
  afterAll(() => {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  });

  it("the zone is really in effect", () => {
    const offset = new Date(Date.UTC(2026, 0, 15)).getTimezoneOffset();
    expect(offset).toBe(tz === "America/Los_Angeles" ? 480 : tz === "Asia/Tokyo" ? -540 : 0);
  });

  it("epoch, round-trip and every label keep the calendar date", () => {
    for (const d of ["2026-01-01", "2026-03-08", "2026-06-05", "2026-11-01", "2026-12-31"]) {
      const t = ms(d);
      const [y, m, day] = d.split("-").map(Number);
      expect(t).toBe(Date.UTC(y, m - 1, day));
      expect(epochMsToIsoDate(t)).toBe(d);
      expect(equityCurveTooltipDate(t)).toBe(d);
      expect(formatEquityCurveDate(t, "day").endsWith(` ${day}`)).toBe(true);
      expect(formatEquityCurveDate(t, "full")).toContain(` ${day}, ${y}`);
      expect(formatEquityCurveDate(t, "year")).toBe(String(y));
    }
    expect(formatEquityCurveDate(ms("2026-01-01"), "day")).toBe("Jan 1");
    expect(formatEquityCurveDate(ms("2026-01-01"), "month-year")).toBe("Jan 26");
    expect(formatEquityCurveDate(ms("2026-01-01"), "full")).toBe("Jan 1, 2026");
    expect(formatEquityCurveDate(ms("2026-12-31"), "month-year")).toBe("Dec 26");
  });

  it("ticks are the same calendar dates", () => {
    const r = equityCurveTimeTicks(ms("2025-10-07"), ms("2026-10-07"));
    expect(iso(r.ticks)[0]).toBe("2025-11-01");
    expect(r.ticks.map((t) => formatEquityCurveTick(t, r.unit))[2]).toBe("Jan 26");
  });
});
