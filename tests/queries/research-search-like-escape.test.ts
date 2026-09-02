/**
 * Deep-QA fix — research-search--sql-like-wildcards-unescaped-false-matches.
 *
 * User-typed search terms reached SQLite LIKE with `_` and `%` unescaped,
 * so `guidance_raise` matched "guidance raise" and `20%` matched anything
 * containing "20". Every free-text search box (Feeds articles, Filtered
 * audit, Notes, transcripts) now escapes the term and pairs the pattern
 * with ESCAPE '\'.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { escapeLikeTerm } from "@/lib/queries/like-escape";
import { getRecentArticles } from "@/lib/queries/research";
import { getNotesFiltered } from "@/lib/queries/notes";
import { getTranscriptsSummary } from "@/lib/queries/transcripts";
import { createNote } from "@/lib/mutations/notes";
import { upsertTranscript } from "@/lib/mutations/transcripts";

let db: Database.Database;
let sourceId: number;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  sourceId = db
    .prepare("INSERT INTO research_sources (name, sender_email) VALUES ('QA Test Source', 'qa-like@b.c')")
    .run().lastInsertRowid as number;
});

function seedArticle(subject: string, summary: string): void {
  db.prepare(
    `INSERT INTO research_articles (source_id, gmail_message_id, received_at, subject, sender, summary, raw_text)
     VALUES (?, ?, '2026-08-01T12:00:00Z', ?, 'a@b.c', ?, ?)`,
  ).run(sourceId, `msg-${subject}`, subject, summary, summary);
}

describe("escapeLikeTerm", () => {
  it("escapes underscore, percent, and backslash", () => {
    expect(escapeLikeTerm("guidance_raise")).toBe("guidance\\_raise");
    expect(escapeLikeTerm("up 20%")).toBe("up 20\\%");
    expect(escapeLikeTerm("a\\b")).toBe("a\\\\b");
    expect(escapeLikeTerm("plain")).toBe("plain");
  });
});

describe("article search treats LIKE wildcards literally", () => {
  it("does not let `_` match arbitrary characters", () => {
    seedArticle("Guidance raise coming", "They see a guidance raise next quarter");
    seedArticle("Literal token", "The flag guidance_raise was set");

    const hits = getRecentArticles(db, { search: "guidance_raise" });
    expect(hits.map((a) => a.subject)).toEqual(["Literal token"]);
  });

  it("does not let `%` match everything", () => {
    seedArticle("Revenue grew", "Revenue grew 20 percent");
    seedArticle("Margin note", "Margins expanded to 20% of sales");

    const hits = getRecentArticles(db, { search: "20%" });
    expect(hits.map((a) => a.subject)).toEqual(["Margin note"]);
  });
});

describe("notes + transcripts search treat LIKE wildcards literally", () => {
  it("notes: `_` in the term only matches the literal underscore", () => {
    createNote(db, { note_type: "journal", content: "watching the guidance number closely", event_date: "2026-08-01" });
    createNote(db, { note_type: "journal", content: "flagged guidance_number in the model", event_date: "2026-08-01" });

    const hits = getNotesFiltered(db, { search: "guidance_number" });
    expect(hits).toHaveLength(1);
    expect(hits[0].content).toContain("guidance_number");
  });

  it("transcripts: `%` in the term only matches the literal percent", () => {
    upsertTranscript(db, {
      security_id: null,
      ticker: "INTC",
      year: 2026,
      quarter: 1,
      source: "api_ninjas",
      summary: "Gross margin reached 45 points",
      guidance: null,
      source_key: "api_ninjas:INTC:2026:1",
    });
    upsertTranscript(db, {
      security_id: null,
      ticker: "INTC",
      year: 2026,
      quarter: 2,
      source: "api_ninjas",
      summary: "Gross margin reached 45% of revenue",
      guidance: null,
      source_key: "api_ninjas:INTC:2026:2",
    });

    const hits = getTranscriptsSummary(db, { search: "45%" });
    expect(hits).toHaveLength(1);
    expect(hits[0].summary).toContain("45%");
  });
});
