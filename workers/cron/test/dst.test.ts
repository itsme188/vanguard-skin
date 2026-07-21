/**
 * Tests for DST-aware wall-clock helpers in src/dst.ts.
 * Uses vi.setSystemTime to freeze the clock at a known UTC moment, then
 * checks that the ET-mapped values are correct under both EDT and EST.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getCurrentETHour,
  getCurrentETMinute,
  getCurrentETDayOfWeek,
  todayET,
  formatEtTimestamp,
} from "../src/dst";

afterEach(() => vi.useRealTimers());

describe("getCurrentETMinute", () => {
  it("returns 0 for a whole-hour UTC time (EDT, :30 offset → minute still 0)", () => {
    // 2026-05-08 21:00 UTC = 2026-05-08 17:00 EDT
    vi.setSystemTime(new Date("2026-05-08T21:00:00Z"));
    expect(getCurrentETMinute()).toBe(0);
  });

  it("returns 30 for :30 UTC (EDT, :30 minute preserved)", () => {
    // 2026-05-08 21:30 UTC = 2026-05-08 17:30 EDT
    vi.setSystemTime(new Date("2026-05-08T21:30:00Z"));
    expect(getCurrentETMinute()).toBe(30);
  });

  it("returns 45 for :45 UTC (EDT)", () => {
    // 2026-05-11 12:45 UTC = 2026-05-11 08:45 EDT
    vi.setSystemTime(new Date("2026-05-11T12:45:00Z"));
    expect(getCurrentETMinute()).toBe(45);
  });

  it("returns 0 for 23:00 UTC on a winter Monday (EST)", () => {
    // 2026-01-05 23:00 UTC = 2026-01-05 18:00 EST
    vi.setSystemTime(new Date("2026-01-05T23:00:00Z"));
    expect(getCurrentETMinute()).toBe(0);
  });

  it("returns 30 for 22:30 UTC on a winter Friday (EST)", () => {
    // 2026-01-09 22:30 UTC = 2026-01-09 17:30 EST
    vi.setSystemTime(new Date("2026-01-09T22:30:00Z"));
    expect(getCurrentETMinute()).toBe(30);
  });
});

describe("getCurrentETHour", () => {
  it("returns correct ET hour under EDT (UTC-4)", () => {
    // 2026-05-08 21:00 UTC = 17:00 EDT
    vi.setSystemTime(new Date("2026-05-08T21:00:00Z"));
    expect(getCurrentETHour()).toBe(17);
  });

  it("returns correct ET hour under EST (UTC-5)", () => {
    // 2026-01-09 22:00 UTC = 17:00 EST
    vi.setSystemTime(new Date("2026-01-09T22:00:00Z"));
    expect(getCurrentETHour()).toBe(17);
  });

  it("returns 0 for midnight ET (summer)", () => {
    // 2026-05-08 04:00 UTC = 00:00 EDT
    vi.setSystemTime(new Date("2026-05-08T04:00:00Z"));
    expect(getCurrentETHour()).toBe(0);
  });
});

describe("getCurrentETDayOfWeek", () => {
  it("Mon 19:00 EST (Tue 00:00 UTC) → 1 (Monday)", () => {
    // The dispatcher day-shift case: Mon 19:00 ET winter = Tue 00:00 UTC
    vi.setSystemTime(new Date("2026-01-06T00:00:00Z")); // UTC Tuesday
    // ET date is still Monday 2026-01-05
    expect(getCurrentETDayOfWeek()).toBe(1); // Monday
  });

  it("Thu 19:00 EST (Fri 00:00 UTC) → 4 (Thursday)", () => {
    vi.setSystemTime(new Date("2026-01-09T00:00:00Z")); // UTC Friday
    // ET date is still Thursday 2026-01-08
    expect(getCurrentETDayOfWeek()).toBe(4); // Thursday
  });

  it("Sunday = 0", () => {
    // Sun 2026-05-10 19:00 EDT = Sun 2026-05-10 23:00 UTC
    vi.setSystemTime(new Date("2026-05-10T23:00:00Z"));
    expect(getCurrentETDayOfWeek()).toBe(0);
  });

  it("Friday = 5", () => {
    // Fri 2026-05-08 17:30 EDT = Fri 2026-05-08 21:30 UTC
    vi.setSystemTime(new Date("2026-05-08T21:30:00Z"));
    expect(getCurrentETDayOfWeek()).toBe(5);
  });
});

describe("todayET", () => {
  it("returns Monday date when UTC is Tuesday 00:00 (winter day-shift case)", () => {
    // Mon 2026-01-05 19:00 EST = Tue 2026-01-06 00:00 UTC
    vi.setSystemTime(new Date("2026-01-06T00:00:00Z"));
    expect(todayET()).toBe("2026-01-05"); // still Monday in ET
  });
});

describe("formatEtTimestamp", () => {
  it("maps a stored UTC space-separated timestamp to ET under EDT (UTC-4)", () => {
    expect(formatEtTimestamp("2026-07-15 20:00:00")).toBe("Jul 15 16:00 ET");
  });

  it("maps to ET under EST (UTC-5)", () => {
    expect(formatEtTimestamp("2026-01-15 21:00:00")).toBe("Jan 15 16:00 ET");
  });

  it("normalizes the Intl hour-24 midnight edge to 00, with the ET day (not UTC's)", () => {
    // 04:00 UTC in July = 00:00 EDT the PREVIOUS-looking UTC day boundary: Jul 15 04:00Z → Jul 15 00:00 ET
    expect(formatEtTimestamp("2026-07-15 04:00:00")).toBe("Jul 15 00:00 ET");
    // Winter: Jan 15 05:00Z → Jan 15 00:00 ET
    expect(formatEtTimestamp("2026-01-15 05:00:00")).toBe("Jan 15 00:00 ET");
  });

  it("accepts ISO-with-Z input identically", () => {
    expect(formatEtTimestamp("2026-07-15T20:00:00Z")).toBe("Jul 15 16:00 ET");
  });

  it("returns unparseable input unchanged", () => {
    expect(formatEtTimestamp("not a timestamp")).toBe("not a timestamp");
  });
});
