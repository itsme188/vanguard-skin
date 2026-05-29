import { describe, it, expect } from "vitest";
import {
  isMarketHoliday,
  isMarketClosed,
  shouldSendBriefingToday,
} from "../src/market-holidays";
// Mac↔Worker parity is asserted on the Mac side (tests/calendar/market-holidays
// .test.ts), which can resolve both the `@/`-aliased Mac copy and this pure
// worker module via relative import. The worker module imports no app code so
// importing the Mac copy HERE would pull in the unresolvable `@/` alias.

describe("worker market-holidays", () => {
  it("flags Memorial Day + Independence-observed 2026", () => {
    expect(isMarketHoliday("2026-05-25")).toBe(true);
    expect(isMarketHoliday("2026-07-03")).toBe(true);
    expect(isMarketHoliday("2026-07-02")).toBe(false); // early close, not a holiday
  });

  it("isMarketClosed covers weekends + holidays", () => {
    expect(isMarketClosed("2026-05-24")).toBe(true); // Sunday
    expect(isMarketClosed("2026-05-25")).toBe(true); // Memorial Mon
    expect(isMarketClosed("2026-05-26")).toBe(false); // Tue
  });

  it("shouldSendBriefingToday defers Sunday→Monday across a holiday", () => {
    expect(shouldSendBriefingToday("2026-05-24")).toBe(false); // Sun before Memorial
    expect(shouldSendBriefingToday("2026-05-25")).toBe(true); // Memorial Mon
    expect(shouldSendBriefingToday("2026-05-31")).toBe(true); // normal Sun
    expect(shouldSendBriefingToday("2026-06-01")).toBe(false); // normal Mon
  });
});
