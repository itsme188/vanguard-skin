import { describe, it, expect } from "vitest";
import { liveOptionExpirationSql, isOptionLive } from "@/lib/compute/option-expiry";

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
