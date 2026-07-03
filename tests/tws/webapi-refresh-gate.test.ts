/**
 * Gate for the disconnected-path (TWS down) background refresh — R1
 * auto-cadence (spec: docs/superpowers/specs/2026-07-03-away-from-home-
 * auto-refresh-design.md). Market-hours ET wall-clock + holiday + debounce.
 * All times injected; ET anchoring pinned across both DST regimes because
 * the Mac travels (never gate on the local clock).
 */

import { describe, it, expect } from "vitest";
import { shouldFireDisconnectedRefresh } from "@/lib/tws/webapi-refresh-gate";

// 2026-07-06 is a regular Monday; EDT (UTC-4).
const MONDAY_10AM_ET = new Date("2026-07-06T14:00:00Z");

function gate(overrides: Partial<Parameters<typeof shouldFireDisconnectedRefresh>[0]> = {}) {
  return shouldFireDisconnectedRefresh({
    now: MONDAY_10AM_ET,
    lastRefreshMs: 0,
    intervalMinutes: 30,
    ...overrides,
  });
}

describe("shouldFireDisconnectedRefresh", () => {
  it("fires on a weekday inside market hours when never refreshed", () => {
    expect(gate()).toBe(true);
  });

  it("skips before the 9:30 ET open and at/after the 16:00 ET close", () => {
    expect(gate({ now: new Date("2026-07-06T13:00:00Z") })).toBe(false); // 9:00 ET
    expect(gate({ now: new Date("2026-07-06T13:29:00Z") })).toBe(false); // 9:29 ET
    expect(gate({ now: new Date("2026-07-06T13:30:00Z") })).toBe(true); // 9:30 ET exactly
    expect(gate({ now: new Date("2026-07-06T20:00:00Z") })).toBe(false); // 16:00 ET
  });

  it("is ET-anchored, not UTC or local — winter (EST) boundary holds", () => {
    // 2026-01-05 is a Monday; EST (UTC-5): 14:30 UTC = 9:30 ET → fires,
    // 14:00 UTC = 9:00 ET → skips (would fire if the gate read UTC hours).
    expect(gate({ now: new Date("2026-01-05T14:30:00Z") })).toBe(true);
    expect(gate({ now: new Date("2026-01-05T14:00:00Z") })).toBe(false);
  });

  it("skips weekends", () => {
    expect(gate({ now: new Date("2026-07-05T14:00:00Z") })).toBe(false); // Sunday
  });

  it("skips NYSE holidays (2026-07-03 is the observed July-4th closure)", () => {
    expect(gate({ now: new Date("2026-07-03T14:00:00Z") })).toBe(false); // Friday, holiday
  });

  it("debounces against the last refresh timestamp", () => {
    const twentyMinAgo = MONDAY_10AM_ET.getTime() - 20 * 60_000;
    const fortyMinAgo = MONDAY_10AM_ET.getTime() - 40 * 60_000;
    expect(gate({ lastRefreshMs: twentyMinAgo })).toBe(false);
    expect(gate({ lastRefreshMs: fortyMinAgo })).toBe(true);
  });

  it("interval 0 disables entirely", () => {
    expect(gate({ intervalMinutes: 0 })).toBe(false);
  });
});
