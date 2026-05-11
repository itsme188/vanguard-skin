import { describe, it, expect } from "vitest";
import {
  getCurrentMonday,
  addDays,
  validateWeekOf,
  formatWeekRange,
  mondayOf,
  weekAgo,
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
