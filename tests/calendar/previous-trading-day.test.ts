import { describe, it, expect } from "vitest";
import { isMarketClosed, nextTradingDay, previousTradingDay } from "@/lib/calendar/market-holidays";

describe("previousTradingDay", () => {
  it("an ordinary weekday steps back one day", () => {
    expect(previousTradingDay("2026-07-09")).toBe("2026-07-08"); // Thu → Wed
  });

  it("a Monday steps back to the Friday", () => {
    expect(previousTradingDay("2026-07-13")).toBe("2026-07-10");
  });

  it("a weekend day steps back to the Friday", () => {
    expect(previousTradingDay("2026-07-11")).toBe("2026-07-10"); // Sat
    expect(previousTradingDay("2026-07-12")).toBe("2026-07-10"); // Sun
  });

  it("the day after a holiday skips the holiday", () => {
    // Juneteenth 2026 is Fri 06-19 (closed): Mon 06-22 → Thu 06-18.
    expect(previousTradingDay("2026-06-22")).toBe("2026-06-18");
    // Thanksgiving 2026 is Thu 11-26: Fri 11-27 → Wed 11-25.
    expect(previousTradingDay("2026-11-27")).toBe("2026-11-25");
  });

  it("a Tuesday after a Monday holiday skips the long weekend", () => {
    // Labor Day 2026 is Mon 09-07: Tue 09-08 → Fri 09-04.
    expect(previousTradingDay("2026-09-08")).toBe("2026-09-04");
  });

  it("a holiday itself steps back to the prior session", () => {
    expect(previousTradingDay("2026-12-25")).toBe("2026-12-24");
  });

  it("never returns a closed day, and is the inverse of nextTradingDay on open days", () => {
    let d = "2026-01-02";
    for (let i = 0; i < 400; i++) {
      const p = previousTradingDay(d);
      expect(isMarketClosed(p)).toBe(false);
      expect(p < d).toBe(true);
      if (!isMarketClosed(d)) expect(nextTradingDay(p)).toBe(d);
      d = nextTradingDay(d);
    }
  });
});
