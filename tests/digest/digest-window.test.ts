/**
 * The digest window rule, shared by the sender and the preview.
 * Clock frozen at 2026-03-10T01:30:00Z = 21:30 ET on 2026-03-09: the UTC day
 * has rolled over, the Eastern day has not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { resolveDigestSince, defaultDigestSince } from "@/lib/digest/digest-window";
import { setLastDigestSentAt } from "@/lib/digest/daily-digest";

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-10T01:30:00Z"));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});
afterEach(() => vi.useRealTimers());

describe("resolveDigestSince", () => {
  it("mode 'today' is the Eastern day", () => {
    expect(resolveDigestSince(db, { mode: "today" })).toBe("2026-03-09");
  });

  it("mode 'since_last' with no marker is the Eastern yesterday", () => {
    expect(resolveDigestSince(db, { mode: "since_last" })).toBe("2026-03-08");
  });

  it("mode 'since_last' returns the stored marker when there is one", () => {
    setLastDigestSentAt(db, "2026-03-05");
    expect(resolveDigestSince(db, { mode: "since_last" })).toBe("2026-03-05");
  });

  it("mode 'since_date' returns the date it was given", () => {
    expect(resolveDigestSince(db, { mode: "since_date", sinceDate: "2026-02-01" })).toBe("2026-02-01");
  });

  it("mode 'since_date' with no date, and no mode at all, give null", () => {
    expect(resolveDigestSince(db, { mode: "since_date" })).toBeNull();
    expect(resolveDigestSince(db, { mode: "since_date", sinceDate: null })).toBeNull();
    expect(resolveDigestSince(db, {})).toBeNull();
  });

  it("the fallback for null is the Eastern yesterday", () => {
    expect(defaultDigestSince()).toBe("2026-03-08");
  });
});

describe("the sender and the preview read the one rule", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

  it("the sender calls resolveDigestSince before its slow fetch", () => {
    const src = read("lib/digest/send-digest.ts");
    const rule = src.indexOf("resolveDigestSince(db,");
    const fetch = src.indexOf("await syncPortfolio(db)");
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(fetch);
  });

  it("the preview route uses the rule and no UTC date slice", () => {
    const src = read("app/api/digest/preview/route.ts");
    expect(src).toContain("resolveDigestSince(db,");
    expect(src).not.toContain("toISOString().slice(0, 10)");
  });
});
