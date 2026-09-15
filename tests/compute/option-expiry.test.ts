import { describe, it, expect } from "vitest";
import { liveOptionExpirationSql, isOptionLive, daysToExpiry } from "@/lib/compute/option-expiry";

describe("liveOptionExpirationSql", () => {
  it("produces an IS-NULL-or->=today literal-substituted fragment for the default alias", () => {
    const sql = liveOptionExpirationSql("s", "2026-08-21");
    expect(sql).toBe("(s.expiration_date IS NULL OR s.expiration_date >= '2026-08-21')");
  });

  it("respects a custom table alias", () => {
    const sql = liveOptionExpirationSql("su", "2026-08-21");
    expect(sql).toContain("su.expiration_date IS NULL");
    expect(sql).toContain("su.expiration_date >= '2026-08-21'");
  });

  it("never leaves a positional ? behind — it's a literal-substituted date, like latestHoldingsPredicate's asOfDate", () => {
    const sql = liveOptionExpirationSql("s", "2026-08-21");
    expect(sql).not.toContain("?");
  });

  it("throws on a malformed date instead of silently building bad SQL", () => {
    expect(() => liveOptionExpirationSql("s", "08/21/2026")).toThrow(/YYYY-MM-DD/);
    expect(() => liveOptionExpirationSql("s", "not-a-date")).toThrow();
  });

  it("defaults `today` to todayET() when omitted (no crash, valid literal shape)", () => {
    const sql = liveOptionExpirationSql();
    expect(sql).toMatch(/^\(s\.expiration_date IS NULL OR s\.expiration_date >= '\d{4}-\d{2}-\d{2}'\)$/);
  });
});

describe("isOptionLive", () => {
  const today = "2026-08-21";

  it("an option expiring TODAY is live", () => {
    expect(isOptionLive(today, today)).toBe(true);
  });

  it("an option expiring in the future is live", () => {
    expect(isOptionLive("2026-08-22", today)).toBe(true);
  });

  it("an option that expired YESTERDAY is not live", () => {
    expect(isOptionLive("2026-08-20", today)).toBe(false);
  });

  it("a null/undefined expiration (non-option, or unknown) is treated as live — never guessed as expired", () => {
    expect(isOptionLive(null, today)).toBe(true);
    expect(isOptionLive(undefined, today)).toBe(true);
  });
});

describe("daysToExpiry", () => {
  it("returns 0 on the expiration day itself — the contract the Greeks card still shows as live", () => {
    expect(daysToExpiry("2026-09-15", "2026-09-15")).toBe(0);
  });

  it("returns a positive count before expiration", () => {
    expect(daysToExpiry("2026-09-20", "2026-09-15")).toBe(5);
    expect(daysToExpiry("2026-09-16", "2026-09-15")).toBe(1);
  });

  it("returns a negative count after expiration", () => {
    expect(daysToExpiry("2026-09-10", "2026-09-15")).toBe(-5);
    expect(daysToExpiry("2026-09-14", "2026-09-15")).toBe(-1);
  });

  it("agrees with isOptionLive's cutoff: live iff daysToExpiry >= 0", () => {
    const today = "2026-08-21";
    for (const expiration of ["2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22", "2026-08-25"]) {
      expect(daysToExpiry(expiration, today) >= 0).toBe(isOptionLive(expiration, today));
    }
  });

  it("is exact across a spring-forward DST boundary (US DST starts 2026-03-08) — no wall-clock offset leaks in", () => {
    // 2026-03-01 -> 2026-03-15 is 14 calendar days, DST transition included.
    expect(daysToExpiry("2026-03-15", "2026-03-01")).toBe(14);
  });

  it("is exact across a fall-back DST boundary (US DST ends 2026-11-01)", () => {
    expect(daysToExpiry("2026-11-15", "2026-10-25")).toBe(21);
  });

  it("is exact across a leap day (2028-02-29)", () => {
    // Feb 27 -> Feb 28 -> Feb 29 -> Mar 1 = 3 calendar days.
    expect(daysToExpiry("2028-03-01", "2028-02-27")).toBe(3);
  });

  it("would NOT be exact across a non-leap Feb 29 (2026 isn't a leap year) — sanity check the calendar, not just the arithmetic", () => {
    // Feb 27 -> Feb 28 -> Mar 1 = 2 calendar days (no Feb 29 in 2026).
    expect(daysToExpiry("2026-03-01", "2026-02-27")).toBe(2);
  });

  it("defaults `today` to todayET() when omitted (no crash, finite integer result)", () => {
    const dte = daysToExpiry("2030-01-01");
    expect(Number.isInteger(dte)).toBe(true);
  });

  it("throws on a malformed expirationDate or today instead of silently miscomputing", () => {
    expect(() => daysToExpiry("09/15/2026", "2026-09-15")).toThrow(/YYYY-MM-DD/);
    expect(() => daysToExpiry("2026-09-15", "not-a-date")).toThrow(/YYYY-MM-DD/);
  });
});
