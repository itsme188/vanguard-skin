/**
 * QA B48: Today's releases — time-aware pending label, slot-aware manual
 * earnings title, and a title that wraps on a phone.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { pendingOrReleasedText } from "@/app/dashboard/components/TodayReleases";
// Unit 16: the rule moved to a plain lib module shared with the week view.
import { slotAwareTitle } from "@/lib/calendar/manual-row-display";
import { anchorIndex } from "@/tests/helpers/source-anchor";

// 2026-03-10 10:00 ET (EDT, UTC-4)
const NOW = new Date("2026-03-10T14:00:00Z");

describe("pendingOrReleasedText", () => {
  it("keeps Pending release for a future time", () => {
    expect(pendingOrReleasedText({ event_date: "2026-03-10", release_time: "10:00:01" }, null, "stored", new Date("2026-03-10T13:00:00Z"))).toBe("Pending release");
  });
  it("names the time once it has passed and nothing arrived", () => {
    expect(pendingOrReleasedText({ event_date: "2026-03-10", release_time: "08:30" }, null, undefined, NOW)).toBe("Released 8:30 AM · awaiting data");
  });
  it("never claims a release for an estimated or unknown time", () => {
    expect(pendingOrReleasedText({ event_date: "2026-03-10", release_time: "08:30" }, null, "usual", NOW)).toBe("Pending release");
    expect(pendingOrReleasedText({ event_date: "2026-03-10", release_time: "08:30" }, null, "unknown", NOW)).toBe("Pending release");
  });
  it("a row with no clock time stays pending", () => {
    expect(pendingOrReleasedText({ event_date: "2026-03-10", release_time: null }, null, undefined, NOW)).toBe("Pending release");
  });
  it("a consensus estimate wins over the time check", () => {
    expect(pendingOrReleasedText({ event_date: "2026-03-10", release_time: "08:30" }, "EPS 1.25", undefined, NOW)).toMatch(/^Est:/);
  });
});

describe("slotAwareTitle", () => {
  const base = { event_type: "earnings" as const, raw_json: null };
  it("replaces (Manual entry) with the slot label", () => {
    expect(slotAwareTitle({ ...base, title: "AAA earnings (Manual entry)", event_time: "BMO" })).toBe("AAA earnings (Before Market Open)");
    expect(slotAwareTitle({ ...base, title: "AAA earnings (Manual entry)", event_time: "AMC" })).toBe("AAA earnings (After Market Close)");
  });
  it("leaves the title alone with no derivable slot", () => {
    expect(slotAwareTitle({ ...base, title: "AAA earnings (Manual entry)", event_time: null })).toBe("AAA earnings (Manual entry)");
  });
  it("only touches earnings titles that carry the token", () => {
    expect(slotAwareTitle({ ...base, title: "AAA earnings (After Market Close)", event_time: "BMO" })).toBe("AAA earnings (After Market Close)");
    expect(slotAwareTitle({ event_type: "cpi", raw_json: null, title: "CPI (Manual entry)", event_time: "BMO" })).toBe("CPI (Manual entry)");
  });
});

describe("source pin", () => {
  it("title span wraps below md and truncates from md up", () => {
    const src = readFileSync("app/dashboard/components/TodayReleases.tsx", "utf8");
    const i = anchorIndex(src, "text-[14px] text-ink font-medium");
    expect(src.slice(i, i + 140)).toContain("md:truncate");
  });
});
