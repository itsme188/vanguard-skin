/**
 * repair-empty-enrichments.ts — companion to the QA finding
 * research-feeds--empty-enrichment-marked-processed-fake-neutral-chip
 * (2026-08-19). 78 research_articles rows were stamped processed_at with a
 * completely empty enrichment (summary='', key_themes=[],
 * mentioned_symbols=[], portfolio_relevance='', sentiment 'neutral'/0.0
 * all in lockstep). The code-side fix (lib/gmail/process.ts,
 * isEmptyEnrichmentResult) stops new damage; this script clears
 * processed_at on the rows the bug already produced so the next enrich
 * pass retries them.
 *
 * Tests the selector/mutation functions directly with DI (in-memory
 * SQLite via runMigrations) — never spawns the script.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  findEmptyEnrichmentRows,
  repairEmptyEnrichments,
} from "@/scripts/repair-empty-enrichments";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

let sourceId: number;

function insertSource(db: Database.Database): number {
  const result = db
    .prepare(`INSERT INTO research_sources (name) VALUES ('Test Source')`)
    .run();
  return result.lastInsertRowid as number;
}

interface ArticleFixture {
  subject?: string;
  summary?: string | null;
  key_themes?: string | null;
  sentiment?: string | null;
  sentiment_score?: number | null;
  mentioned_symbols?: string | null;
  portfolio_relevance?: string | null;
  ai_model?: string | null;
  processed_at?: string | null;
}

function insertArticle(db: Database.Database, fixture: ArticleFixture = {}): number {
  const result = db
    .prepare(
      `INSERT INTO research_articles
         (source_id, gmail_message_id, received_at, subject, sender, raw_text,
          summary, key_themes, sentiment, sentiment_score, mentioned_symbols,
          portfolio_relevance, ai_model, processed_at)
       VALUES (?, ?, '2026-08-19', ?, 'x@x', 'body text',
               ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sourceId,
      `msg-${Math.random()}`,
      fixture.subject ?? "Test article",
      fixture.summary ?? null,
      fixture.key_themes ?? null,
      fixture.sentiment ?? null,
      fixture.sentiment_score ?? null,
      fixture.mentioned_symbols ?? null,
      fixture.portfolio_relevance ?? null,
      fixture.ai_model ?? null,
      fixture.processed_at ?? null,
    );
  return result.lastInsertRowid as number;
}

/** The exact all-defaults shape the bug produced. */
const ALL_DEFAULTS: ArticleFixture = {
  subject: "Empty-parse stub card",
  summary: "",
  key_themes: "[]",
  sentiment: "neutral",
  sentiment_score: 0,
  mentioned_symbols: "[]",
  portfolio_relevance: "",
  ai_model: "claude-sonnet-5",
  processed_at: "2026-08-15 09:00:00",
};

describe("findEmptyEnrichmentRows", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    sourceId = insertSource(db);
  });

  it("matches a row with the exact all-defaults signature", () => {
    const id = insertArticle(db, ALL_DEFAULTS);

    const rows = findEmptyEnrichmentRows(db);

    expect(rows.map((r) => r.id)).toEqual([id]);
  });

  it("does NOT match a genuine neutral enrichment with real summary text", () => {
    insertArticle(db, {
      ...ALL_DEFAULTS,
      summary: "Rates held steady; no near-term catalyst either way.",
    });

    expect(findEmptyEnrichmentRows(db)).toEqual([]);
  });

  it("does NOT match a row with real key_themes even if summary is empty", () => {
    insertArticle(db, {
      ...ALL_DEFAULTS,
      key_themes: JSON.stringify(["fed policy", "rates"]),
    });

    expect(findEmptyEnrichmentRows(db)).toEqual([]);
  });

  it("does NOT match a row with real mentioned_symbols", () => {
    insertArticle(db, {
      ...ALL_DEFAULTS,
      mentioned_symbols: JSON.stringify(["AAPL"]),
    });

    expect(findEmptyEnrichmentRows(db)).toEqual([]);
  });

  it("does NOT match a row with a non-empty portfolio_relevance", () => {
    insertArticle(db, {
      ...ALL_DEFAULTS,
      portfolio_relevance: "Relevant to your NVDA position.",
    });

    expect(findEmptyEnrichmentRows(db)).toEqual([]);
  });

  it("does NOT match a row with a non-neutral sentiment", () => {
    insertArticle(db, { ...ALL_DEFAULTS, sentiment: "bullish" });

    expect(findEmptyEnrichmentRows(db)).toEqual([]);
  });

  it("does NOT match a row with a non-zero sentiment_score", () => {
    insertArticle(db, { ...ALL_DEFAULTS, sentiment_score: 0.4 });

    expect(findEmptyEnrichmentRows(db)).toEqual([]);
  });

  it("does NOT match an unprocessed row (processed_at IS NULL) — nothing to repair", () => {
    insertArticle(db, { ...ALL_DEFAULTS, processed_at: null });

    expect(findEmptyEnrichmentRows(db)).toEqual([]);
  });

  it("matches regardless of ai_model (not just the cloud-fallback path)", () => {
    const id1 = insertArticle(db, { ...ALL_DEFAULTS, ai_model: "claude-sonnet-5" });
    const id2 = insertArticle(db, { ...ALL_DEFAULTS, ai_model: "claude-haiku-5" });

    const rows = findEmptyEnrichmentRows(db);

    expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([id1, id2].sort((a, b) => a - b));
  });

  it("matches only the all-defaults rows out of a mixed batch", () => {
    const badId = insertArticle(db, ALL_DEFAULTS);
    insertArticle(db, {
      ...ALL_DEFAULTS,
      summary: "A real summary describing the article.",
    });
    insertArticle(db, { ...ALL_DEFAULTS, processed_at: null });
    insertArticle(db, { ...ALL_DEFAULTS, sentiment: "bearish" });

    const rows = findEmptyEnrichmentRows(db);

    expect(rows.map((r) => r.id)).toEqual([badId]);
  });
});

describe("repairEmptyEnrichments", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    sourceId = insertSource(db);
  });

  it("dry-run (apply=false) reports matches but writes nothing", () => {
    const id = insertArticle(db, ALL_DEFAULTS);

    const result = repairEmptyEnrichments(db, { apply: false });

    expect(result.matched.map((r) => r.id)).toEqual([id]);
    expect(result.repaired).toBe(0);

    const row = db
      .prepare(`SELECT processed_at FROM research_articles WHERE id = ?`)
      .get(id) as { processed_at: string | null };
    expect(row.processed_at).not.toBeNull();
  });

  it("apply=true clears processed_at on matched rows only", () => {
    const badId = insertArticle(db, ALL_DEFAULTS);
    const goodId = insertArticle(db, {
      ...ALL_DEFAULTS,
      summary: "A real summary describing the article.",
    });

    const result = repairEmptyEnrichments(db, { apply: true });

    expect(result.repaired).toBe(1);

    const bad = db
      .prepare(`SELECT processed_at FROM research_articles WHERE id = ?`)
      .get(badId) as { processed_at: string | null };
    const good = db
      .prepare(`SELECT processed_at FROM research_articles WHERE id = ?`)
      .get(goodId) as { processed_at: string | null };

    expect(bad.processed_at).toBeNull();
    expect(good.processed_at).not.toBeNull();
  });

  it("apply=true leaves the rest of the row untouched (summary/themes not modified) — only processed_at is cleared", () => {
    const id = insertArticle(db, ALL_DEFAULTS);

    repairEmptyEnrichments(db, { apply: true });

    const row = db
      .prepare(
        `SELECT summary, key_themes, sentiment, sentiment_score, mentioned_symbols, portfolio_relevance
         FROM research_articles WHERE id = ?`,
      )
      .get(id) as {
      summary: string;
      key_themes: string;
      sentiment: string;
      sentiment_score: number;
      mentioned_symbols: string;
      portfolio_relevance: string;
    };

    expect(row.summary).toBe("");
    expect(row.key_themes).toBe("[]");
    expect(row.sentiment).toBe("neutral");
    expect(row.sentiment_score).toBe(0);
    expect(row.mentioned_symbols).toBe("[]");
    expect(row.portfolio_relevance).toBe("");
  });

  it("is idempotent — a second run after apply finds and repairs nothing", () => {
    insertArticle(db, ALL_DEFAULTS);

    repairEmptyEnrichments(db, { apply: true });
    const second = repairEmptyEnrichments(db, { apply: true });

    expect(second.matched).toEqual([]);
    expect(second.repaired).toBe(0);
  });
});
