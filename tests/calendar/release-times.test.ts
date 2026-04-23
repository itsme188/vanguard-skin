/**
 * Unit tests for lib/calendar/release-times.ts — RELEASE_TIMES_ET map integrity,
 * earningsHourToReleaseTime conversion, and resolveReleaseTime prioritization.
 */

import { describe, it, expect } from "vitest";
import {
  RELEASE_TIMES_ET,
  earningsHourToReleaseTime,
  resolveReleaseTime,
} from "@/lib/calendar/release-times";

describe("RELEASE_TIMES_ET", () => {
  it("covers all event_types that show up in production DB", () => {
    // Event types found in data/vanguard.db 2026-04-24:
    // earnings, other_macro, jobs, cpi, gdp, retail_sales, pmi, housing, fomc
    // Macro event_types (non-earnings, non-other) must have a mapping.
    const prodEventTypes = ["cpi", "gdp", "fomc", "jobs", "pmi", "housing", "retail_sales"];
    for (const type of prodEventTypes) {
      expect(RELEASE_TIMES_ET[type], `missing release time for ${type}`).toMatch(
        /^\d{2}:\d{2}$/,
      );
    }
  });

  it("uses HH:MM format for every entry", () => {
    for (const [key, value] of Object.entries(RELEASE_TIMES_ET)) {
      expect(value, `bad format for ${key}`).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it("bins release times into 08:30 / 10:00 / 14:00", () => {
    const allowed = new Set(["08:30", "10:00", "14:00"]);
    for (const value of Object.values(RELEASE_TIMES_ET)) {
      expect(allowed.has(value), `unexpected release time ${value}`).toBe(true);
    }
  });
});

describe("earningsHourToReleaseTime", () => {
  it("maps BMO to 08:00", () => {
    expect(earningsHourToReleaseTime("bmo")).toBe("08:00");
  });

  it("maps AMC to 16:15", () => {
    expect(earningsHourToReleaseTime("amc")).toBe("16:15");
  });

  it("maps DMH to 16:15 (default-to-after-close)", () => {
    expect(earningsHourToReleaseTime("dmh")).toBe("16:15");
  });

  it("defaults null / undefined to 16:15", () => {
    expect(earningsHourToReleaseTime(null)).toBe("16:15");
    expect(earningsHourToReleaseTime(undefined)).toBe("16:15");
  });
});

describe("resolveReleaseTime", () => {
  it("prefers existing HH:MM event_time", () => {
    const rt = resolveReleaseTime({
      event_type: "cpi",
      event_time: "07:00",      // unusual, but caller wins
      raw_json: null,
    });
    expect(rt).toBe("07:00");
  });

  it("falls back to RELEASE_TIMES_ET when event_time is null", () => {
    const rt = resolveReleaseTime({
      event_type: "cpi",
      event_time: null,
      raw_json: null,
    });
    expect(rt).toBe("08:30");
  });

  it("ignores non-HH:MM event_time and falls through to lookup", () => {
    const rt = resolveReleaseTime({
      event_type: "fomc",
      event_time: "BMO",       // should be ignored
      raw_json: null,
    });
    expect(rt).toBe("14:00");
  });

  it("parses earnings BMO/AMC from raw_json", () => {
    const bmo = resolveReleaseTime({
      event_type: "earnings",
      event_time: null,
      raw_json: JSON.stringify({ entry: { hour: "bmo" } }),
    });
    expect(bmo).toBe("08:00");

    const amc = resolveReleaseTime({
      event_type: "earnings",
      event_time: null,
      raw_json: JSON.stringify({ entry: { hour: "amc" } }),
    });
    expect(amc).toBe("16:15");
  });

  it("returns null for unmapped event_type with no clues", () => {
    const rt = resolveReleaseTime({
      event_type: "other_macro",
      event_time: null,
      raw_json: null,
    });
    expect(rt).toBeNull();
  });

  it("handles malformed raw_json gracefully", () => {
    const rt = resolveReleaseTime({
      event_type: "earnings",
      event_time: null,
      raw_json: "{not valid json",
    });
    expect(rt).toBeNull();
  });
});
