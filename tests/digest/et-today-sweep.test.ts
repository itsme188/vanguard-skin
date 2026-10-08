/**
 * U22 — UTC "today" sweep, digest + earnings lane.
 *
 * Clock frozen at 2026-03-10T01:30:00Z = 21:30 ET on 2026-03-09 (the UTC day
 * has rolled over, the Eastern day has not). Every assertion holds only for
 * the Eastern reading of "today".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { generateDailyDigest } from "@/lib/digest/daily-digest";
import { refreshReportHistory } from "@/lib/earnings/report-history";
import { anchorIndex } from "@/tests/helpers/source-anchor";

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
      return null; // "nothing to send" — the window boundary is all we assert
    }),
  };
});

const EVENING_ET = new Date("2026-03-10T01:30:00Z");

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(EVENING_ET);
  adaptiveSince.calls.length = 0;
  process.env.BRIEFING_EMAIL_TO = "to@example.com";
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  vi.useRealTimers();
});

function seedArticle(subject: string, receivedAt: string) {
  const source = db
    .prepare("INSERT INTO research_sources (name, sender_email, is_active) VALUES (?, ?, 1)")
    .run(subject, `${subject.toLowerCase()}@example.com`);
  db.prepare(
    `INSERT INTO research_articles
       (source_id, subject, sender, received_at, raw_text, summary, sentiment, processed_at)
     VALUES (?, ?, 'src@example.com', ?, 'body', 'Summary text', 'neutral', datetime('now'))`,
  ).run(source.lastInsertRowid as number, subject, receivedAt);
}

describe("generateDailyDigest (legacy 24h wrapper)", () => {
  it("opens the window at the ET yesterday, not the UTC yesterday", () => {
    // ET yesterday = 2026-03-08; UTC yesterday = 2026-03-09.
    seedArticle("SundayNote", "2026-03-08 12:00:00");
    const digest = generateDailyDigest(db);
    expect(digest).not.toBeNull();
    expect(digest).toContain("SundayNote");
  });
});

describe("sendDigestEmail window boundaries", () => {
  it("mode 'today' starts at the ET day", async () => {
    const { sendDigestEmail } = await import("@/lib/digest/send-digest");
    await sendDigestEmail(db, { mode: "today" });
    expect(adaptiveSince.calls).toEqual(["2026-03-09"]);
  });

  it("mode 'since_last' with no prior send falls back to the ET yesterday", async () => {
    const { sendDigestEmail } = await import("@/lib/digest/send-digest");
    await sendDigestEmail(db, { mode: "since_last" });
    expect(adaptiveSince.calls).toEqual(["2026-03-08"]);
  });

  it("mode 'since_date' with no date falls back to the ET yesterday", async () => {
    const { sendDigestEmail } = await import("@/lib/digest/send-digest");
    await sendDigestEmail(db, { mode: "since_date" });
    expect(adaptiveSince.calls).toEqual(["2026-03-08"]);
  });

  it("no mode at all falls back to the ET yesterday", async () => {
    const { sendDigestEmail } = await import("@/lib/digest/send-digest");
    await sendDigestEmail(db, {});
    expect(adaptiveSince.calls).toEqual(["2026-03-08"]);
  });
});

describe("synthesis fallback ring date stamp", () => {
  // recordSynthesisFallback is module-private and only reachable through a
  // failing live synthesis call, so the stamp is source-pinned.
  it("stamps the ET day, never a UTC slice", () => {
    const src = readFileSync(join(process.cwd(), "lib/digest/daily-digest.ts"), "utf8");
    const start = anchorIndex(src, "function recordSynthesisFallback(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, anchorIndex(src, "\n}\n", start));
    expect(body).toMatch(/const today = todayET\(\)/);
    expect(body).not.toMatch(/toISOString\(\)\.slice\(0, 10\)/);
  });
});

describe("refreshReportHistory Yahoo window", () => {
  it("ends the daily-close fetch on the ET day", async () => {
    const av = {
      symbol: "TESTE",
      quarterlyEarnings: [
        { fiscalDateEnding: "2025-12-31", reportedDate: "2026-01-28", reportedEPS: "1.10",
          estimatedEPS: "1.00", surprise: "0.10", surprisePercentage: "10", reportTime: "post-market" },
      ],
    };
    let yahooUrl = "";
    const fetchImpl = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("alphavantage")) return new Response(JSON.stringify(av), { status: 200 });
      yahooUrl = u;
      return new Response(JSON.stringify({ chart: { result: [] } }), { status: 200 });
    }) as typeof fetch;

    await refreshReportHistory(db, "TESTE", { apiKey: "k", fetchImpl });

    const period2 = Number(new URL(yahooUrl).searchParams.get("period2"));
    expect(period2).toBe(Math.floor(Date.parse("2026-03-09T23:59:59-05:00") / 1000));
  });
});
