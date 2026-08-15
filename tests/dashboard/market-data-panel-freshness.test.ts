import { describe, it, expect } from "vitest";
import { isBarsStaleVsPrice } from "@/app/dashboard/components/MarketDataPanel";

// Context: security-detail-quotestats--open-dayrange-volume-stale-no-asof-caption-regression-3.
// The KPI strip (Open / Day Range / Volume / ATR 14) is derived from the
// latest cached ohlcv_bars row, which can lag the hero price's own as-of
// date (prices table, live-sync sources) by months. This pure comparison
// decides whether the strip needs an "as of <bar date>" caption — mirrors
// the week52AsOf freshness arbitration already in getKpisForSecurity.

describe("isBarsStaleVsPrice", () => {
  it("flags stale when the bar date is older than the hero price's as-of date (HOOD repro)", () => {
    expect(isBarsStaleVsPrice("2026-04-23", "2026-08-15")).toBe(true);
  });

  it("does not flag when the bar IS the same trading day as the price", () => {
    expect(isBarsStaleVsPrice("2026-08-15", "2026-08-15")).toBe(false);
  });

  it("does not flag when the bar is newer than the price as-of (should not happen, but never over-warn)", () => {
    expect(isBarsStaleVsPrice("2026-08-15", "2026-08-14")).toBe(false);
  });

  it("does not flag when there is no price as-of date to compare against (keep the strip uncluttered)", () => {
    expect(isBarsStaleVsPrice("2026-04-23", null)).toBe(false);
  });
});
