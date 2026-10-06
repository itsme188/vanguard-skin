/**
 * "time unknown" for an earnings row whose stored time is NULL (user ruling
 * 2026-10-05, the part that shipped).
 *
 * What gets STORED for a slot-less vendor row is unchanged from before the
 * ruling (review 2026-10-05: both "no history → NULL" and the last-print
 * history rung move time-gated pipeline readers, so they wait for a separate
 * ruling). This file covers only the rendering helper and that the two
 * converted surfaces use it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  UNKNOWN_RELEASE_TIME_LABEL,
  earningsTimeLabel,
  resolveReleaseTime,
} from "@/lib/calendar/release-times";

describe("earningsTimeLabel", () => {
  it("a clock time formats, an unknown earnings time says so, macro stays blank", () => {
    expect(UNKNOWN_RELEASE_TIME_LABEL).toBe("time unknown");
    expect(earningsTimeLabel({ event_type: "earnings", release_time: "16:05" })).toBe("4:05 PM");
    expect(earningsTimeLabel({ event_type: "earnings", release_time: "08:00" })).toBe("8:00 AM");
    expect(earningsTimeLabel({ event_type: "earnings", release_time: null })).toBe("time unknown");
    // A BMO/AMC marker is not a clock time.
    expect(
      earningsTimeLabel({ event_type: "earnings", release_time: null, event_time: "BMO" }),
    ).toBe("time unknown");
    // An explicit HH:MM event_time is one.
    expect(
      earningsTimeLabel({ event_type: "earnings", release_time: null, event_time: "07:30" }),
    ).toBe("7:30 AM");
    expect(earningsTimeLabel({ event_type: "cpi", release_time: null })).toBeNull();
    expect(earningsTimeLabel({ event_type: "cpi", release_time: "08:30" })).toBe("8:30 AM");
  });

  it("the week-ahead card and the Today list both render through it (source pin)", () => {
    const week = readFileSync("app/dashboard/today/WeekAheadView.tsx", "utf8");
    const today = readFileSync("app/dashboard/components/TodayReleases.tsx", "utf8");
    expect(week).toMatch(/earningsTimeLabel\(event\)/);
    expect(today).toMatch(/earningsTimeLabel\(event\)/);
  });
});

describe("stored time for a slot-less vendor row is unchanged", () => {
  it("still resolves the legacy 16:15 default", () => {
    for (const hour of [null, "dmh"]) {
      expect(
        resolveReleaseTime({
          event_type: "earnings",
          event_time: null,
          raw_json: JSON.stringify({ entry: { hour } }),
        }),
      ).toBe("16:15");
    }
  });
});
