/**
 * The evening sender uses the shared window rule (resolveDigestSince /
 * defaultDigestSince), captured before the slow fetch.
 *
 * Clock frozen at 2026-03-10T01:30:00Z = 21:30 ET on 2026-03-09: the UTC day
 * has rolled over, the Eastern day has not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { setLastDigestSentAt } from "@/lib/digest/daily-digest";

vi.mock("@/lib/tws/positions", () => ({
  syncPortfolio: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/gmail/auth", () => ({
  isGmailConfigured: () => false,
  getGmailClient: () => null,
}));
vi.mock("@/lib/gmail/fetch", () => ({
  fetchNewArticles: vi.fn().mockResolvedValue({ fetched: 0 }),
  backfillSourceUrls: vi.fn(),
}));
vi.mock("@/lib/gmail/process", () => ({
  processUnprocessedArticles: vi.fn().mockResolvedValue({ processed: 0, failed: 0 }),
}));
vi.mock("@/lib/email", () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/calendar/briefing-html", () => ({
  briefingToHtml: vi.fn().mockReturnValue("<html></html>"),
}));
const adaptiveSince = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("@/lib/digest/daily-digest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/digest/daily-digest")>();
  return {
    ...actual,
    generateDigestSinceAdaptive: vi.fn(async (_db: unknown, since: string) => {
      adaptiveSince.calls.push(since);
      return null;
    }),
  };
});

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-10T01:30:00Z"));
  adaptiveSince.calls.length = 0;
  process.env.BRIEFING_EMAIL_TO = "to@example.com";
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sendEveningEmail window", () => {
  it("with no last-sent marker opens at the Eastern yesterday, not a UTC slice", async () => {
    const { sendEveningEmail } = await import("@/lib/digest/send-evening");
    await sendEveningEmail(db);
    // ET yesterday = 2026-03-08; the old UTC slice of now-24h gave 2026-03-09.
    expect(adaptiveSince.calls).toEqual(["2026-03-08"]);
  });

  it("with a last-sent marker opens exactly at the marker", async () => {
    setLastDigestSentAt(db, "2026-03-09T14:00:00.000Z");
    const { sendEveningEmail } = await import("@/lib/digest/send-evening");
    await sendEveningEmail(db);
    expect(adaptiveSince.calls).toEqual(["2026-03-09T14:00:00.000Z"]);
  });

  it("captures the window before the slow fetch and keeps no private copy of the rule", () => {
    const src = readFileSync(join(process.cwd(), "lib/digest/send-evening.ts"), "utf8");
    expect(src).toContain('resolveDigestSince(db, { mode: "since_last" }) ?? defaultDigestSince()');
    expect(src).not.toMatch(/toISOString\(\)\s*\.slice\(0, 10\)/);
    expect(src.indexOf("sinceSnapshot =")).toBeLessThan(src.indexOf("await syncPortfolio"));
  });
});
