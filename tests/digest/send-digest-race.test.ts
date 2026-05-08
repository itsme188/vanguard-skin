import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { setLastDigestSentAt, getLastDigestSentAt } from "@/lib/digest/daily-digest";

/**
 * Regression test for the 2026-04-22 → 24 "digest skipped despite N processed
 * articles" mystery.
 *
 * Bug: send-digest.ts read `getLastDigestSentAt(db)` AFTER the slow fetch +
 * Claude-process step. A concurrent manual-trigger that completed during that
 * window would update `last_digest_sent_at` to "now", and then the cron's
 * subsequent read produced a future-of-our-articles cutoff. Result: zero
 * matches, "No processed articles" skip, three weekdays of broken delivery.
 *
 * Fix: capture the digest range boundary BEFORE the slow steps so concurrent
 * updates can't poison the range. This test simulates the race by mocking
 * the pipeline.
 */

// Use vi.hoisted so the mock can be replaced per-test inside the spec.
const mockSyncPortfolio = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/tws/positions", () => ({
  syncPortfolio: mockSyncPortfolio,
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

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  process.env.GMAIL_ADDRESS = "test@example.com";
  process.env.GMAIL_APP_PASSWORD = "x".repeat(16);
  process.env.BRIEFING_EMAIL_TO = "to@example.com";
});

function seedProcessedArticle(receivedAt: string, subject = "Test article") {
  const src = db
    .prepare(
      "INSERT INTO research_sources (name, sender_email, is_active) VALUES ('TestSrc', 'src@example.com', 1)"
    )
    .run();
  db.prepare(
    `INSERT INTO research_articles
       (source_id, subject, sender, received_at, raw_text, summary, sentiment, processed_at)
     VALUES (?, ?, ?, ?, ?, 'A summary', 'neutral', datetime('now'))`
  ).run(src.lastInsertRowid, subject, "src@example.com", receivedAt, "body");
}

describe("send-digest race-condition snapshot", () => {
  it("captures lastSent BEFORE fetch/process so a concurrent update can't poison the range", { timeout: 10000 }, async () => {
    const { sendDigestEmail } = await import("@/lib/digest/send-digest");

    // Initial state: last_digest_sent_at is from yesterday at 8:45 AM ET.
    const yesterday8amUtc = "2026-04-23T12:45:00.000Z"; // 8:45 EDT
    setLastDigestSentAt(db, yesterday8amUtc);

    // Insert 5 articles received overnight (between yesterday 8:45 ET and now).
    seedProcessedArticle("2026-04-24 02:00:00");
    seedProcessedArticle("2026-04-24 04:30:00");
    seedProcessedArticle("2026-04-24 06:15:00");
    seedProcessedArticle("2026-04-24 08:00:00");
    seedProcessedArticle("2026-04-24 11:30:00");

    // Simulate the race: DURING the await of syncPortfolio, a concurrent
    // manual trigger completes and updates `last_digest_sent_at` to a
    // timestamp AFTER all our overnight articles. Pre-fix, the cron would
    // read this poisoned value at the digest step (after our long process
    // step) and find zero matches. Post-fix, the cron snapshotted
    // yesterday's value before sync — concurrent updates can't reach in.
    mockSyncPortfolio.mockImplementationOnce(async () => {
      const futureNow = "2026-04-24T13:00:00.000Z"; // after all article timestamps
      setLastDigestSentAt(db, futureNow);
    });

    const result = await sendDigestEmail(db, { mode: "since_last" });

    // The fix means: we should NOT skip — the captured snapshot still
    // points at yesterday, so our 5 overnight articles match.
    expect(result.success).toBe(true);
    if ("skipped" in result && result.skipped) {
      throw new Error(
        `Race-condition regression: digest skipped with reason "${result.reason}" even though 5 in-range articles existed.`
      );
    }
    expect("sentTo" in result && result.sentTo).toBe("to@example.com");
  });

  it("still skips correctly when there genuinely are no articles in range", async () => {
    const { sendDigestEmail } = await import("@/lib/digest/send-digest");

    // Set lastSent to an hour ago. No articles. Truly nothing to send.
    setLastDigestSentAt(db, new Date(Date.now() - 60 * 60 * 1000).toISOString());

    const result = await sendDigestEmail(db, { mode: "since_last" });
    expect(result.success).toBe(true);
    expect("skipped" in result && result.skipped).toBe(true);
  });
});

/**
 * B1 (2026-04-27): the DigestCatchup banner manually fires the digest when
 * the 8:45 cron didn't show. If the cron is still in flight, the manual
 * send's "now" timestamp would poison `last_digest_sent_at` and cause a
 * thinned-out duplicate when the Worker fallback fires. The skipMarkerUpdate
 * flag suppresses that update specifically for catch-up flows.
 */
describe("send-digest skipMarkerUpdate flag", () => {
  it("does NOT update last_digest_sent_at when skipMarkerUpdate is true", async () => {
    const { sendDigestEmail } = await import("@/lib/digest/send-digest");

    // Initial state: yesterday's marker.
    const yesterday = "2026-04-26T12:45:00.000Z";
    setLastDigestSentAt(db, yesterday);

    // Seed an article so the digest actually sends.
    seedProcessedArticle("2026-04-27 02:00:00");

    const result = await sendDigestEmail(db, {
      mode: "since_last",
      skipMarkerUpdate: true,
    });

    expect(result.success).toBe(true);
    expect("sentTo" in result && result.sentTo).toBe("to@example.com");
    // Marker should still point at yesterday — catch-up didn't claim the slot.
    expect(getLastDigestSentAt(db)).toBe(yesterday);
  });

  it("still updates last_digest_sent_at by default (skipMarkerUpdate not set)", async () => {
    const { sendDigestEmail } = await import("@/lib/digest/send-digest");

    const yesterday = "2026-04-26T12:45:00.000Z";
    setLastDigestSentAt(db, yesterday);

    seedProcessedArticle("2026-04-27 02:00:00");

    const result = await sendDigestEmail(db, { mode: "since_last" });

    expect(result.success).toBe(true);
    // Default behavior preserved: cron still claims the slot.
    expect(getLastDigestSentAt(db)).not.toBe(yesterday);
  });

  it("does not update marker when skipped (no articles), regardless of flag", async () => {
    const { sendDigestEmail } = await import("@/lib/digest/send-digest");

    const yesterday = "2026-04-26T12:45:00.000Z";
    setLastDigestSentAt(db, yesterday);

    // No articles seeded — should skip.
    const result = await sendDigestEmail(db, {
      mode: "since_last",
      skipMarkerUpdate: false,
    });

    expect("skipped" in result && result.skipped).toBe(true);
    // Even without the flag, a skipped send leaves the marker alone
    // because setLastDigestSentAt is only called on the success path.
    expect(getLastDigestSentAt(db)).toBe(yesterday);
  });
});
