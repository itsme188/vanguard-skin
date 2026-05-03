/**
 * Unit tests for lib/calendar/release-times.ts — RELEASE_TIMES_ET map integrity,
 * earningsHourToReleaseTime conversion, and resolveReleaseTime prioritization.
 */

import { describe, it, expect } from "vitest";
import {
  RELEASE_TIMES_ET,
  SYMBOL_RELEASE_TIMES_ET,
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

  it("parses earnings BMO/AMC/DMH from event_time codes", () => {
    expect(resolveReleaseTime({
      event_type: "earnings",
      event_time: "BMO",
      raw_json: null,
    })).toBe("08:00");
    expect(resolveReleaseTime({
      event_type: "earnings",
      event_time: "AMC",
      raw_json: null,
    })).toBe("16:15");
    expect(resolveReleaseTime({
      event_type: "earnings",
      event_time: "DMH",
      raw_json: null,
    })).toBe("16:15");
  });

  it("defaults explicit unknown earnings timing to after close", () => {
    expect(resolveReleaseTime({
      event_type: "earnings",
      event_time: "UNKNOWN",
      raw_json: null,
    })).toBe("16:15");
    expect(resolveReleaseTime({
      event_type: "earnings",
      event_time: null,
      raw_json: JSON.stringify({ entry: { hour: null } }),
    })).toBe("16:15");
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

describe("SYMBOL_RELEASE_TIMES_ET", () => {
  it("includes the AAPL/AMZN/GOOGL/META/MSFT cohort with their actual release minutes", () => {
    expect(SYMBOL_RELEASE_TIMES_ET.AAPL).toBe("16:30");
    expect(SYMBOL_RELEASE_TIMES_ET.AMZN).toBe("16:01");
    expect(SYMBOL_RELEASE_TIMES_ET.GOOGL).toBe("16:01");
    expect(SYMBOL_RELEASE_TIMES_ET.GOOG).toBe("16:01"); // dual-class
    expect(SYMBOL_RELEASE_TIMES_ET.META).toBe("16:05");
    expect(SYMBOL_RELEASE_TIMES_ET.MSFT).toBe("16:05");
  });

  it("uses HH:MM format for every entry", () => {
    for (const [key, value] of Object.entries(SYMBOL_RELEASE_TIMES_ET)) {
      expect(value, `bad format for ${key}`).toMatch(/^\d{2}:\d{2}$/);
    }
  });
});

describe("earningsHourToReleaseTime — per-symbol overrides", () => {
  it("AAPL AMC release maps to 16:30, not the 16:15 default", () => {
    expect(earningsHourToReleaseTime("amc", "AAPL")).toBe("16:30");
  });

  it("symbol overrides win over BMO/AMC even when hour disagrees", () => {
    // Defensive: even if Finnhub mislabels MSFT as BMO, the symbol map wins.
    expect(earningsHourToReleaseTime("bmo", "MSFT")).toBe("16:05");
  });

  it("falls through to BMO/AMC defaults when symbol has no override", () => {
    expect(earningsHourToReleaseTime("bmo", "TSLA")).toBe("08:00");
    expect(earningsHourToReleaseTime("amc", "NVDA")).toBe("16:15");
  });

  it("symbol matching is case-insensitive", () => {
    expect(earningsHourToReleaseTime("amc", "aapl")).toBe("16:30");
    expect(earningsHourToReleaseTime("amc", "  AAPL  ")).toBe("16:30");
  });

  it("preserves null/undefined symbol fallback", () => {
    expect(earningsHourToReleaseTime("amc", null)).toBe("16:15");
    expect(earningsHourToReleaseTime("amc", undefined)).toBe("16:15");
  });
});

describe("resolveReleaseTime — per-symbol earnings overrides", () => {
  it("AAPL earnings AMC resolves to 16:30 via the symbol map", () => {
    const rt = resolveReleaseTime({
      event_type: "earnings",
      event_time: "AMC",
      raw_json: null,
      symbol: "AAPL",
    });
    expect(rt).toBe("16:30");
  });

  it("AMZN earnings via raw_json hour = amc resolves to 16:01", () => {
    const rt = resolveReleaseTime({
      event_type: "earnings",
      event_time: null,
      raw_json: JSON.stringify({ entry: { hour: "amc" } }),
      symbol: "AMZN",
    });
    expect(rt).toBe("16:01");
  });

  it("explicit HH:MM event_time still wins over the symbol map (manual override)", () => {
    const rt = resolveReleaseTime({
      event_type: "earnings",
      event_time: "17:00",
      raw_json: null,
      symbol: "AAPL",
    });
    expect(rt).toBe("17:00");
  });

  it("untouched event_type behavior is unchanged when symbol absent", () => {
    expect(resolveReleaseTime({
      event_type: "earnings",
      event_time: "AMC",
      raw_json: null,
    })).toBe("16:15");
  });
});
