/**
 * D4 — getRecentArticles + getFullTextForSources + getArticlesForSecurity
 * honor the is_relevant filter.
 *
 * - getRecentArticles: relevantOnly opts in (default off so Feeds tab still
 *   shows everything).
 * - getFullTextForSources + getArticlesForSecurity: unconditionally filter
 *   (only digest/security-detail consume them).
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  getRecentArticles,
  getFullTextForSources,
  getArticlesForSecurity,
} from "@/lib/queries/research";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE research_sources (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      website_url TEXT,
      processing_prompt TEXT
    );
    CREATE TABLE research_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      gmail_message_id TEXT,
      received_at TEXT NOT NULL,
      subject TEXT NOT NULL,
      sender TEXT NOT NULL,
      raw_text TEXT,
      summary TEXT,
      key_themes TEXT,
      sentiment TEXT,
      sentiment_score REAL,
      mentioned_symbols TEXT,
      portfolio_relevance TEXT,
      processed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      source_url TEXT,
      is_relevant INTEGER NOT NULL DEFAULT 1,
      excluded_category TEXT,
      excluded_reason TEXT
    );
    CREATE TABLE research_article_securities (
      article_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      mention_context TEXT,
      sentiment TEXT
    );
    CREATE TABLE securities (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, name TEXT);
  `);
  db.prepare(`INSERT INTO research_sources (id, name) VALUES (1, 'Test Source')`).run();
  db.prepare(`INSERT INTO securities (id, symbol, name) VALUES (1, 'AAPL', 'Apple')`).run();
  return db;
}

function insertArticle(
  db: Database.Database,
  opts: {
    id: number;
    subject: string;
    isRelevant?: 0 | 1;
    processed?: boolean;
    receivedAt?: string;
    linkSecurityId?: number;
  },
) {
  db.prepare(
    `INSERT INTO research_articles (id, source_id, subject, sender, raw_text, received_at, is_relevant, processed_at, summary, sentiment)
     VALUES (?, 1, ?, 'x@x', 'body', ?, ?, ?, 'summary', 'neutral')`,
  ).run(
    opts.id,
    opts.subject,
    opts.receivedAt ?? new Date().toISOString().slice(0, 19).replace("T", " "),
    opts.isRelevant ?? 1,
    opts.processed ? new Date().toISOString().slice(0, 19).replace("T", " ") : null,
  );
  if (opts.linkSecurityId) {
    db.prepare(
      `INSERT INTO research_article_securities (article_id, security_id) VALUES (?, ?)`,
    ).run(opts.id, opts.linkSecurityId);
  }
}

describe("D4 — getRecentArticles relevantOnly flag", () => {
  it("returns all articles when relevantOnly is omitted (Feeds tab default)", () => {
    const db = makeDb();
    insertArticle(db, { id: 1, subject: "Real research", isRelevant: 1, processed: true });
    insertArticle(db, { id: 2, subject: "** Payment Receipt", isRelevant: 0, processed: false });
    insertArticle(db, { id: 3, subject: "Off-topic article", isRelevant: 0, processed: true });

    const rows = getRecentArticles(db, { limit: 10 });
    expect(rows.map((r) => r.id).sort()).toEqual([1, 2, 3]);
  });

  it("filters out is_relevant=0 articles when relevantOnly is true (digest path)", () => {
    const db = makeDb();
    insertArticle(db, { id: 1, subject: "Real research", isRelevant: 1, processed: true });
    insertArticle(db, { id: 2, subject: "** Payment Receipt", isRelevant: 0, processed: false });
    insertArticle(db, { id: 3, subject: "Off-topic article", isRelevant: 0, processed: true });

    const rows = getRecentArticles(db, { relevantOnly: true, limit: 10 });
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  it("combines relevantOnly with processedOnly (typical digest call)", () => {
    const db = makeDb();
    insertArticle(db, { id: 1, subject: "Processed + relevant", isRelevant: 1, processed: true });
    insertArticle(db, { id: 2, subject: "Processed + off-topic", isRelevant: 0, processed: true });
    insertArticle(db, { id: 3, subject: "Unprocessed + relevant", isRelevant: 1, processed: false });

    const rows = getRecentArticles(db, {
      processedOnly: true,
      relevantOnly: true,
      limit: 10,
    });
    expect(rows.map((r) => r.id)).toEqual([1]);
  });
});

describe("D4 — getFullTextForSources always filters is_relevant=1", () => {
  it("excludes off-topic processed articles even when the source matches", () => {
    const db = makeDb();
    // Three articles within the lookback window, all processed; one off-topic.
    insertArticle(db, { id: 1, subject: "Relevant", isRelevant: 1, processed: true });
    insertArticle(db, { id: 2, subject: "Off-topic", isRelevant: 0, processed: true });

    const rows = getFullTextForSources(db, [1], 72);
    expect(rows.map((r) => r.article_id)).toEqual([1]);
  });
});

describe("D4 — getArticlesForSecurity always filters is_relevant=1", () => {
  it("excludes off-topic articles linked to the security", () => {
    const db = makeDb();
    insertArticle(db, { id: 1, subject: "AAPL deep dive", isRelevant: 1, processed: true, linkSecurityId: 1 });
    insertArticle(db, { id: 2, subject: "AAPL off-topic mention", isRelevant: 0, processed: true, linkSecurityId: 1 });

    const rows = getArticlesForSecurity(db, 1, 10);
    expect(rows.map((r) => r.article_id)).toEqual([1]);
  });
});
