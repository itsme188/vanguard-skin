import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getRecentArticles } from "@/lib/queries/research";

/**
 * Regression test for the "send digest since last email" bug.
 *
 * `research_articles.received_at` is populated by SQLite's `datetime('now')`
 * which produces "YYYY-MM-DD HH:MM:SS" (space separator). Callers
 * pass startDate as either "YYYY-MM-DD" or a full ISO string
 * "YYYY-MM-DDTHH:MM:SS.sssZ". Under a naive string compare, any
 * received_at whose character after the date-part is a space (ASCII 32)
 * compares LESS than a filter whose character is 'T' (ASCII 84), even
 * when the actual moment is later. `datetime()` on both sides fixes it.
 */
describe("getRecentArticles — received_at datetime comparison", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare(
      `INSERT OR IGNORE INTO research_sources (id, name, sender_email, is_active) VALUES (1, 'Test', 'x@y.com', 1)`,
    ).run();
  });

  function insertArticle(id: number, receivedAt: string) {
    db.prepare(
      `INSERT INTO research_articles (id, source_id, subject, sender, received_at, raw_text, processed_at)
       VALUES (?, 1, 'Subject ' || ?, 'sender@x.com', ?, 'body', datetime('now'))`,
    ).run(id, id, receivedAt);
  }

  it("finds articles received after an ISO-Z startDate even when received_at uses space separator", () => {
    // received_at is stored in space-separator form (from datetime('now'))
    insertArticle(1, "2026-04-22 22:53:41");
    insertArticle(2, "2026-04-22 20:46:06");
    // one before the threshold
    insertArticle(3, "2026-04-22 08:00:00");

    // caller supplies an ISO-Z timestamp (what Date.toISOString() produces)
    const results = getRecentArticles(db, {
      startDate: "2026-04-22T13:44:44.806Z",
      processedOnly: true,
    });

    expect(results.length).toBe(2);
    expect(results.map((r) => r.id).sort()).toEqual([1, 2]);
  });

  it("respects endDate inclusive of same day", () => {
    insertArticle(1, "2026-04-22 22:53:41");
    insertArticle(2, "2026-04-23 05:00:00");

    const results = getRecentArticles(db, {
      startDate: "2026-04-22T00:00:00.000Z",
      endDate: "2026-04-22",
      processedOnly: true,
    });

    expect(results.map((r) => r.id)).toEqual([1]);
  });

  it("still works when startDate is a plain YYYY-MM-DD string", () => {
    insertArticle(1, "2026-04-22 15:00:00");
    insertArticle(2, "2026-04-21 15:00:00");

    const results = getRecentArticles(db, {
      startDate: "2026-04-22",
      processedOnly: true,
    });

    expect(results.map((r) => r.id)).toEqual([1]);
  });
});
