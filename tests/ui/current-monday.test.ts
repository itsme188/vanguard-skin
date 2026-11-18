import { describe, it, expect } from "vitest";
import { currentMondayET } from "@/lib/ui/current-monday";

describe("currentMondayET", () => {
  it("current_monday_on_sunday_evening_eastern", () => {
    // 2026-11-22 is a Sunday; 23:30 ET = 04:30 UTC on the 23rd (a Monday in UTC).
    expect(currentMondayET(new Date("2026-11-23T04:30:00Z"))).toBe("2026-11-16");
  });
  it("current_monday_on_monday", () => {
    expect(currentMondayET(new Date("2026-11-16T15:00:00Z"))).toBe("2026-11-16");
  });
  it("uses the Eastern day at a UTC-midnight edge", () => {
    // 00:30 UTC Tuesday 2026-11-17 is still Monday evening in New York.
    expect(currentMondayET(new Date("2026-11-17T00:30:00Z"))).toBe("2026-11-16");
  });
  it("midweek and across a month boundary", () => {
    expect(currentMondayET(new Date("2026-12-02T17:00:00Z"))).toBe("2026-11-30");
  });
});
