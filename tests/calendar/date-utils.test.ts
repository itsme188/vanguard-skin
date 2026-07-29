import { describe, it, expect } from "vitest";
import {
  getCurrentMonday,
  addDays,
  calendarDaysBetween,
  validateWeekOf,
  formatWeekRange,
  mondayOf,
  weekAgo,
  todayET,
  resolveWeekOfParam,
} from "@/lib/calendar/date-utils";

// ── getCurrentMonday ─────────────────────────────────────────────

describe("getCurrentMonday", () => {
  it("returns this Monday on a Monday", () => {
    const mon = new Date("2026-04-13T10:00:00"); // Monday
    expect(getCurrentMonday(mon)).toBe("2026-04-13");
  });

  it("returns this Monday on a Wednesday", () => {
    const wed = new Date("2026-04-15T10:00:00"); // Wednesday
    expect(getCurrentMonday(wed)).toBe("2026-04-13");
  });

  it("returns this Monday on a Friday", () => {
    const fri = new Date("2026-04-17T10:00:00"); // Friday
    expect(getCurrentMonday(fri)).toBe("2026-04-13");
  });

  it("returns NEXT Monday on a Saturday", () => {
    const sat = new Date("2026-04-18T10:00:00"); // Saturday
    expect(getCurrentMonday(sat)).toBe("2026-04-20");
  });

  it("returns NEXT Monday on a Sunday", () => {
    const sun = new Date("2026-04-19T10:00:00"); // Sunday
    expect(getCurrentMonday(sun)).toBe("2026-04-20");
  });

  it("handles year boundary (Saturday Dec 28 → Monday Dec 30)", () => {
    const sat = new Date("2024-12-28T10:00:00"); // Saturday
    expect(getCurrentMonday(sat)).toBe("2024-12-30");
  });

  it("handles year boundary (Sunday Dec 29 → Monday Dec 30)", () => {
    const sun = new Date("2024-12-29T10:00:00"); // Sunday
    expect(getCurrentMonday(sun)).toBe("2024-12-30");
  });

  // ── ET-anchoring: the instant must be interpreted in America/New_York,
  //    NOT the runtime's local zone or UTC. This is the regression guard for
  //    the traveling-Mac / UTC-Worker week-targeting bug (Earnings Hub showing
  //    last week). 2026-04-18T02:00:00Z is Saturday in UTC but still FRIDAY
  //    Apr 17 in ET (EDT = UTC-4 → 22:00 Fri), so the ET Monday is Apr 13.
  it("interprets the instant in ET, not UTC (Sat-UTC that is still Fri-ET)", () => {
    const instant = new Date("2026-04-18T02:00:00Z");
    expect(getCurrentMonday(instant)).toBe("2026-04-13");
  });

  it("interprets the instant in ET for a Sun-UTC that is still Sat-ET", () => {
    // 2026-04-19T02:00:00Z = Sat Apr 18 22:00 ET → Saturday → NEXT Monday Apr 20
    const instant = new Date("2026-04-19T02:00:00Z");
    expect(getCurrentMonday(instant)).toBe("2026-04-20");
  });
});

// ── todayET ──────────────────────────────────────────────────────

describe("todayET", () => {
  it("returns the ET calendar date for a late-UTC instant that is the prior ET day", () => {
    // 2026-05-26T02:00:00Z = May 25 22:00 ET → ET date is 2026-05-25
    expect(todayET(new Date("2026-05-26T02:00:00Z"))).toBe("2026-05-25");
  });

  it("returns YYYY-MM-DD format", () => {
    expect(todayET(new Date("2026-05-25T16:00:00Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ── addDays ──────────────────────────────────────────────────────

describe("addDays", () => {
  it("adds days forward", () => {
    expect(addDays("2026-04-13", 6)).toBe("2026-04-19");
  });

  it("subtracts days backward", () => {
    expect(addDays("2026-04-13", -7)).toBe("2026-04-06");
  });

  it("handles month boundary", () => {
    expect(addDays("2026-04-28", 5)).toBe("2026-05-03");
  });
});

// ── calendarDaysBetween ──────────────────────────────────────────

describe("calendarDaysBetween", () => {
  it("returns 1 for consecutive days", () => {
    expect(calendarDaysBetween("2026-04-13", "2026-04-14")).toBe(1);
  });

  it("returns 3 across a weekend (Fri→Mon)", () => {
    expect(calendarDaysBetween("2026-04-10", "2026-04-13")).toBe(3);
  });

  it("is symmetric (absolute value)", () => {
    expect(calendarDaysBetween("2026-04-14", "2026-04-13")).toBe(1);
  });

  it("measures the multi-month statement-anchor gap", () => {
    // The exact NFLX gap that produced β=−14.
    expect(calendarDaysBetween("2025-06-30", "2026-03-27")).toBe(270);
  });

  it("handles year boundary", () => {
    expect(addDays("2025-12-29", 6)).toBe("2026-01-04");
  });
});

// ── validateWeekOf ───────────────────────────────────────────────

describe("validateWeekOf", () => {
  it("accepts a valid Monday", () => {
    expect(validateWeekOf("2026-04-13")).toBeNull();
  });

  it("rejects a Wednesday", () => {
    const err = validateWeekOf("2026-04-15");
    expect(err).toContain("must be a Monday");
    expect(err).toContain("Wednesday");
  });

  it("rejects bad format", () => {
    expect(validateWeekOf("not-a-date")).toContain("YYYY-MM-DD");
  });

  it("rejects invalid date", () => {
    expect(validateWeekOf("2026-13-45")).toContain("not a valid date");
  });

  it("rejects a Sunday", () => {
    const err = validateWeekOf("2026-04-12");
    expect(err).toContain("Sunday");
  });
});

// ── formatWeekRange ──────────────────────────────────────────────

describe("formatWeekRange", () => {
  it("formats a normal week", () => {
    const result = formatWeekRange("2026-04-13");
    expect(result).toContain("Apr 13");
    expect(result).toContain("Apr 19");
    expect(result).toContain("2026");
  });

  it("handles year boundary correctly", () => {
    const result = formatWeekRange("2025-12-29");
    // Should show both years: "Dec 29, 2025 – Jan 4, 2026"
    expect(result).toContain("2025");
    expect(result).toContain("2026");
    expect(result).toContain("Dec 29");
    expect(result).toContain("Jan 4");
  });

  it("does not duplicate year for same-year range", () => {
    const result = formatWeekRange("2026-04-13");
    // "Apr 13 – Apr 19, 2026" — only one "2026"
    const yearMatches = result.match(/2026/g);
    expect(yearMatches).toHaveLength(1);
  });
});

// ── mondayOf ─────────────────────────────────────────────────────

describe("mondayOf", () => {
  it("returns same date when input is already a Monday", () => {
    expect(mondayOf("2026-05-04")).toBe("2026-05-04"); // Mon
  });

  it("rolls back from Sunday to the prior Monday", () => {
    expect(mondayOf("2026-05-10")).toBe("2026-05-04"); // Sun → prior Mon
  });

  it("rolls back from Wednesday to Monday", () => {
    expect(mondayOf("2026-05-06")).toBe("2026-05-04"); // Wed
  });

  it("handles year boundaries", () => {
    expect(mondayOf("2026-01-01")).toBe("2025-12-29"); // Thu → prior Mon in prev year
  });
});

// ── weekAgo ──────────────────────────────────────────────────────

describe("weekAgo", () => {
  it("subtracts exactly 7 days", () => {
    expect(weekAgo("2026-05-10")).toBe("2026-05-03");
  });

  it("crosses month boundary correctly", () => {
    expect(weekAgo("2026-05-03")).toBe("2026-04-26");
  });
});

describe("resolveWeekOfParam", () => {
  // qa: today-week-ahead--no-week-navigation-weekof-ignored — the week-ahead
  // surface must honor ?weekOf= so past enriched weeks (and future conflict
  // weeks) are browsable. Forgiving: any valid date snaps to its Monday;
  // garbage falls back to the current week rather than erroring.
  it("returns the current Monday when the param is absent", () => {
    expect(resolveWeekOfParam(undefined)).toBe(getCurrentMonday());
  });

  it("passes a valid Monday through", () => {
    expect(resolveWeekOfParam("2026-07-20")).toBe("2026-07-20");
  });

  it("snaps a mid-week date to its Monday", () => {
    expect(resolveWeekOfParam("2026-07-23")).toBe("2026-07-20"); // Thursday
    expect(resolveWeekOfParam("2026-07-26")).toBe("2026-07-20"); // Sunday
  });

  it("falls back to the current Monday on garbage", () => {
    expect(resolveWeekOfParam("not-a-date")).toBe(getCurrentMonday());
    expect(resolveWeekOfParam("2026-13-99")).toBe(getCurrentMonday());
    expect(resolveWeekOfParam("")).toBe(getCurrentMonday());
  });
});
