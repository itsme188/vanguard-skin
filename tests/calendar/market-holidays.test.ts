import { describe, it, expect } from "vitest";
import {
  isMarketHoliday,
  isMarketClosed,
  nextTradingDay,
  shouldSendBriefingToday,
  NYSE_FULL_CLOSURES,
} from "@/lib/calendar/market-holidays";
import { NYSE_FULL_CLOSURES as WORKER_CLOSURES } from "../../workers/cron/src/market-holidays";

describe("Mac↔Worker holiday parity", () => {
  it("the worker mirror matches the canonical Mac list exactly", () => {
    expect([...WORKER_CLOSURES]).toEqual([...NYSE_FULL_CLOSURES]);
  });
});

describe("isMarketHoliday", () => {
  it("flags Memorial Day 2026 (Mon May 25)", () => {
    expect(isMarketHoliday("2026-05-25")).toBe(true);
  });

  it("flags Independence Day observed 2026 (Fri Jul 3, since Jul 4 is Sat)", () => {
    expect(isMarketHoliday("2026-07-03")).toBe(true);
  });

  it("does NOT flag the Jul 2 early-close day (market is open)", () => {
    expect(isMarketHoliday("2026-07-02")).toBe(false);
  });

  it("does NOT flag a normal trading day", () => {
    expect(isMarketHoliday("2026-05-26")).toBe(false);
  });

  it("flags MLK Day 2026 (Mon Jan 19) and Juneteenth (Fri Jun 19)", () => {
    expect(isMarketHoliday("2026-01-19")).toBe(true);
    expect(isMarketHoliday("2026-06-19")).toBe(true);
  });

  it("flags 2027 observed shifts (Juneteenth Fri Jun 18, Christmas Fri Dec 24)", () => {
    expect(isMarketHoliday("2027-06-18")).toBe(true);
    expect(isMarketHoliday("2027-12-24")).toBe(true);
    expect(isMarketHoliday("2027-07-05")).toBe(true); // Jul 4 is Sunday → Mon Jul 5
  });
});

describe("isMarketClosed", () => {
  it("is true on weekends", () => {
    expect(isMarketClosed("2026-05-23")).toBe(true); // Saturday
    expect(isMarketClosed("2026-05-24")).toBe(true); // Sunday
  });
  it("is true on a holiday", () => {
    expect(isMarketClosed("2026-05-25")).toBe(true); // Memorial Day Monday
  });
  it("is false on a normal weekday", () => {
    expect(isMarketClosed("2026-05-26")).toBe(false); // Tuesday
  });
});

describe("nextTradingDay", () => {
  it("skips a holiday Monday to Tuesday", () => {
    expect(nextTradingDay("2026-05-22")).toBe("2026-05-26"); // Fri → skip Sat/Sun/Memorial-Mon → Tue
  });
  it("skips a normal weekend", () => {
    expect(nextTradingDay("2026-05-29")).toBe("2026-06-01"); // Fri → Mon
  });
  it("steps to the next day on a normal weekday", () => {
    expect(nextTradingDay("2026-05-26")).toBe("2026-05-27");
  });
});

describe("shouldSendBriefingToday", () => {
  it("sends on a normal Sunday (Monday is a trading day)", () => {
    expect(shouldSendBriefingToday("2026-05-31")).toBe(true); // Sun, Mon Jun 1 trades
  });
  it("does NOT send on the Sunday before a holiday Monday (defer to Monday)", () => {
    expect(shouldSendBriefingToday("2026-05-24")).toBe(false); // Sun before Memorial Mon
  });
  it("sends on a holiday Monday (Sunday was skipped)", () => {
    expect(shouldSendBriefingToday("2026-05-25")).toBe(true); // Memorial Day Monday
  });
  it("does NOT send on a normal Monday (already sent Sunday)", () => {
    expect(shouldSendBriefingToday("2026-06-01")).toBe(false); // normal Mon
  });
  it("does NOT send on a Wednesday", () => {
    expect(shouldSendBriefingToday("2026-05-27")).toBe(false);
  });
});
