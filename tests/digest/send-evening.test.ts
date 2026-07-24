import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { setLastDigestSentAt, getLastDigestSentAt } from "@/lib/digest/daily-digest";

/**
 * Tests for lib/digest/send-evening.ts
 *
 * Seven concerns:
 *  1. Race-guard: sinceSnapshot is captured BEFORE async work
 *  2. Updates last_digest_sent_at on successful send
 *  3. Does NOT update marker on skip (no content)
 *  4. Respects skipMarkerUpdate option
 *  5. Uses fromLocalPart='evening'
 *  6. Subject contains 'Evening Recap'
 *  7. Throws EveningSendError(500) when sendEmail fails
 */

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

const mockSendEmail = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@/lib/email", () => ({
  sendEmail: mockSendEmail,
}));
vi.mock("@/lib/calendar/briefing-html", () => ({
  briefingToHtml: vi.fn().mockReturnValue("<html><body>Evening test</body></html>"),
}));

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  process.env.BRIEFING_EMAIL_TO = "to@example.com";
  // Reset sendEmail mock before each test
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue(undefined);
  mockSyncPortfolio.mockReset();
  mockSyncPortfolio.mockResolvedValue(undefined);
});

function seedProcessedArticle(receivedAt: string, subject = "Evening article") {
  const src = db
    .prepare(
      "INSERT INTO research_sources (name, sender_email, is_active) VALUES ('EveningSrc', 'evening@example.com', 1)"
    )
    .run();
  db.prepare(
    `INSERT INTO research_articles
       (source_id, subject, sender, received_at, raw_text, summary, sentiment, processed_at)
     VALUES (?, ?, ?, ?, ?, 'An evening summary', 'neutral', datetime('now'))`
  ).run(src.lastInsertRowid, subject, "evening@example.com", receivedAt, "body text");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Race-guard: captures sinceSnapshot before async work
// ─────────────────────────────────────────────────────────────────────────────
describe("send-evening race-guard", () => {
  it("captures sinceSnapshot BEFORE async work so a concurrent update cannot poison the range", async () => {
    const { sendEveningEmail } = await import("@/lib/digest/send-evening");

    // Initial state: last_digest_sent_at is from yesterday evening.
    const yesterdayEvening = "2026-05-07T22:00:00.000Z";
    setLastDigestSentAt(db, yesterdayEvening);

    // Seed 3 articles received since yesterday evening.
    seedProcessedArticle("2026-05-08 02:00:00", "Overnight article 1");
    seedProcessedArticle("2026-05-08 06:00:00", "Morning article 2");
    seedProcessedArticle("2026-05-08 14:00:00", "Afternoon article 3");

    // Simulate the race: during syncPortfolio a concurrent trigger fires and
    // updates last_digest_sent_at to a future timestamp — AFTER all our
    // articles. Pre-fix this would poison the digest range.
    mockSyncPortfolio.mockImplementationOnce(async () => {
      const futureNow = "2026-05-08T21:00:00.000Z"; // after all article timestamps
      setLastDigestSentAt(db, futureNow);
    });

    const result = await sendEveningEmail(db);

    // Post-fix: snapshotted yesterday's value, so all 3 articles match.
    expect(result.success).toBe(true);
    if ("skipped" in result && result.skipped) {
      throw new Error(
        `Race-condition regression: evening email skipped with reason "${result.reason}" even though 3 in-range articles existed.`
      );
    }
    expect("sentTo" in result && result.sentTo).toBe("to@example.com");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Updates last_digest_sent_at on successful send
// ─────────────────────────────────────────────────────────────────────────────
describe("send-evening marker update", () => {
  it("updates last_digest_sent_at to a recent ISO timestamp after successful send", async () => {
    const { sendEveningEmail } = await import("@/lib/digest/send-evening");

    // Set the marker to 2 hours ago so the article seeded next (received "now")
    // clearly falls within the window.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    setLastDigestSentAt(db, twoHoursAgo);
    // Insert an article with received_at = NOW so it's definitely after twoHoursAgo.
    const nowStr = new Date().toISOString().replace("T", " ").slice(0, 19);
    seedProcessedArticle(nowStr);

    const result = await sendEveningEmail(db);

    expect(result.success).toBe(true);
    expect("sentTo" in result).toBe(true);

    const after = getLastDigestSentAt(db);
    expect(after).not.toBeNull();
    // The marker should have moved forward from twoHoursAgo
    expect(after! > twoHoursAgo).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 3. Does NOT update marker on skip
  // ─────────────────────────────────────────────────────────────────────────
  it("does NOT update last_digest_sent_at when skipped (no articles, no alerts, no anomalies)", async () => {
    const { sendEveningEmail } = await import("@/lib/digest/send-evening");

    const before = "2026-05-07T22:00:00.000Z";
    setLastDigestSentAt(db, before);

    // No articles seeded — should skip.
    const result = await sendEveningEmail(db);

    expect(result.success).toBe(true);
    expect("skipped" in result && result.skipped).toBe(true);
    // Marker must be unchanged.
    expect(getLastDigestSentAt(db)).toBe(before);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 4. Respects skipMarkerUpdate option
  // ─────────────────────────────────────────────────────────────────────────
  it("does NOT update last_digest_sent_at when skipMarkerUpdate is true, even on success", async () => {
    const { sendEveningEmail } = await import("@/lib/digest/send-evening");

    const before = "2026-05-07T22:00:00.000Z";
    setLastDigestSentAt(db, before);
    seedProcessedArticle("2026-05-08 14:00:00");

    const result = await sendEveningEmail(db, { skipMarkerUpdate: true });

    expect(result.success).toBe(true);
    expect("sentTo" in result).toBe(true);
    // Marker must be unchanged.
    expect(getLastDigestSentAt(db)).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Uses fromLocalPart='evening'
// ─────────────────────────────────────────────────────────────────────────────
describe("send-evening fromLocalPart", () => {
  it("calls sendEmail with fromLocalPart='evening'", async () => {
    const { sendEveningEmail } = await import("@/lib/digest/send-evening");

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    setLastDigestSentAt(db, twoHoursAgo);
    const nowStr = new Date().toISOString().replace("T", " ").slice(0, 19);
    seedProcessedArticle(nowStr);
    await sendEveningEmail(db);

    expect(mockSendEmail).toHaveBeenCalledOnce();
    expect(mockSendEmail.mock.calls[0][0].fromLocalPart).toBe("evening");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Subject contains 'Evening Recap'
// ─────────────────────────────────────────────────────────────────────────────
describe("send-evening subject", () => {
  it("sends an email whose subject contains 'Evening Recap'", async () => {
    const { sendEveningEmail } = await import("@/lib/digest/send-evening");

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    setLastDigestSentAt(db, twoHoursAgo);
    const nowStr = new Date().toISOString().replace("T", " ").slice(0, 19);
    seedProcessedArticle(nowStr);
    await sendEveningEmail(db);

    expect(mockSendEmail).toHaveBeenCalledOnce();
    const { subject } = mockSendEmail.mock.calls[0][0] as { subject: string };
    expect(subject).toMatch(/Evening Recap/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Throws EveningSendError(500) when sendEmail fails
// ─────────────────────────────────────────────────────────────────────────────
describe("send-evening error handling", () => {
  it("throws EveningSendError with status 500 when sendEmail rejects", async () => {
    const { sendEveningEmail, EveningSendError } = await import("@/lib/digest/send-evening");

    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    setLastDigestSentAt(db, twoHoursAgo);
    const nowStr = new Date().toISOString().replace("T", " ").slice(0, 19);
    seedProcessedArticle(nowStr);
    mockSendEmail.mockRejectedValueOnce(new Error("SMTP connection refused"));

    await expect(sendEveningEmail(db)).rejects.toSatisfy(
      (err: unknown) => err instanceof EveningSendError && err.status === 500
    );
  });

  it("throws EveningSendError with status 400 when no recipient is configured", async () => {
    const { sendEveningEmail, EveningSendError } = await import("@/lib/digest/send-evening");

    delete process.env.BRIEFING_EMAIL_TO;

    await expect(sendEveningEmail(db)).rejects.toSatisfy(
      (err: unknown) => err instanceof EveningSendError && err.status === 400
    );

    // Restore for other tests
    process.env.BRIEFING_EMAIL_TO = "to@example.com";
  });
});
