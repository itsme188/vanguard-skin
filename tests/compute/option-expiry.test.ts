import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { liveOptionExpirationSql, isOptionLive, daysToExpiry } from "@/lib/compute/option-expiry";

describe("liveOptionExpirationSql", () => {
  it("produces an IS-NULL-or->=today literal-substituted fragment for the default alias", () => {
    const sql = liveOptionExpirationSql("s", "2026-08-21");
    expect(sql).toMatch(/^\(s\.expiration_date IS NULL OR \(CASE WHEN s\.expiration_date GLOB .* END\) >= '2026-08-21'\)$/);
  });

  it("respects a custom table alias", () => {
    const sql = liveOptionExpirationSql("su", "2026-08-21");
    expect(sql).toContain("su.expiration_date IS NULL");
    expect(sql).toContain("ELSE su.expiration_date END) >= '2026-08-21'");
    expect(sql).not.toMatch(/\bs\.expiration_date/);
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
    expect(sql).toMatch(/^\(s\.expiration_date IS NULL OR \(CASE .* END\) >= '\d{4}-\d{2}-\d{2}'\)$/);
  });

  // Legacy rows store the expiration as compact YYYYMMDD. A raw string compare
  // of '20261004' >= '2026-10-06' is TRUE ('1' > '-'), which kept an expired
  // legacy-format option live.
  it("compares legacy YYYYMMDD and dashed expirations on the same footing", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE securities (id INTEGER PRIMARY KEY, symbol TEXT, expiration_date TEXT)");
    const ins = db.prepare("INSERT INTO securities (symbol, expiration_date) VALUES (?, ?)");
    ins.run("LEGACY_EXPIRED", "20261004");
    ins.run("LEGACY_TODAY", "20261006");
    ins.run("LEGACY_FUTURE", "20261007");
    ins.run("DASHED_EXPIRED", "2026-10-04");
    ins.run("DASHED_TODAY", "2026-10-06");
    ins.run("DASHED_FUTURE", "2026-10-07");
    ins.run("STOCK", null);
    const live = (
      db
        .prepare(`SELECT symbol FROM securities s WHERE ${liveOptionExpirationSql("s", "2026-10-06")} ORDER BY id`)
        .all() as { symbol: string }[]
    ).map((r) => r.symbol);
    expect(live).toEqual(["LEGACY_TODAY", "LEGACY_FUTURE", "DASHED_TODAY", "DASHED_FUTURE", "STOCK"]);
    db.close();
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

  it("handles the legacy YYYYMMDD spelling identically to the SQL fragment", () => {
    expect(isOptionLive("20261004", "2026-10-06")).toBe(false);
    expect(isOptionLive("20261006", "2026-10-06")).toBe(true);
    expect(isOptionLive("20261007", "2026-10-06")).toBe(true);
    expect(isOptionLive("2026-10-04", "2026-10-06")).toBe(false);
    expect(isOptionLive("2026-10-07", "2026-10-06")).toBe(true);
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
      expect((daysToExpiry(expiration, today) as number) >= 0).toBe(isOptionLive(expiration, today));
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

  it("still throws on a malformed `today` (a caller bug, never stored data)", () => {
    expect(() => daysToExpiry("2026-09-15", "not-a-date")).toThrow(/YYYY-MM-DD/);
  });

  it("reads the legacy compact YYYYMMDD spelling exactly as the dashed one", () => {
    for (const today of ["2026-09-10", "2026-09-15", "2026-09-20"]) {
      expect(daysToExpiry("20260915", today)).toBe(daysToExpiry("2026-09-15", today));
    }
    expect(daysToExpiry("20260915", "2026-09-15")).toBe(0);
    expect(daysToExpiry("20260920", "2026-09-15")).toBe(5);
    expect(daysToExpiry("20260914", "2026-09-15")).toBe(-1);
    expect(daysToExpiry("20260915", "2026-09-15")! >= 0).toBe(isOptionLive("20260915", "2026-09-15"));
  });

  it("returns null, never throws, for a missing or unreadable stored expiration (it runs during a page render)", () => {
    for (const bad of [null, undefined, "", "   ", "09/15/2026", "garbage", "2026-9-5", "202609", "2026-13-45", "20261345", "2026-02-30", "2026-09-15T00:00:00Z"]) {
      expect(() => daysToExpiry(bad, "2026-09-15"), String(bad)).not.toThrow();
      expect(daysToExpiry(bad, "2026-09-15"), String(bad)).toBeNull();
    }
  });
});

describe("daysToExpiry with the default today, at 21:00 Eastern (already tomorrow in UTC)", () => {
  // 2026-09-16T01:00Z is 21:00 EDT on 2026-09-15.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-16T01:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["expiring today", "2026-09-15", "20260915", 0],
    ["expired yesterday", "2026-09-14", "20260914", -1],
    ["expiring tomorrow", "2026-09-16", "20260916", 1],
  ])("%s: dashed and compact agree", (_label, dashed, compact, expected) => {
    expect(daysToExpiry(dashed)).toBe(expected);
    expect(daysToExpiry(compact)).toBe(expected);
  });
});
