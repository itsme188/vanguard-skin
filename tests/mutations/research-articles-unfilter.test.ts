/**
 * D5 — unfilterArticle mutation + getFilteredArticles query.
 *
 * Confirms:
 *   - Mutation flips is_relevant=0 → 1 and clears excluded_category/reason
 *   - Mutation is a no-op (changed=false) when the row is already relevant
 *   - getFilteredArticles returns only is_relevant=0 rows, newest first
 *   - getFilteredArticleCount matches the row count
 */

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { unfilterArticle } from "@/lib/mutations/research-articles";
import {
  getFilteredArticles,
  getFilteredArticleCount,
} from "@/lib/queries/research";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE research_sources (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE research_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      sender TEXT NOT NULL,
      raw_text TEXT,
      received_at TEXT NOT NULL,
      summary TEXT,
      processed_at TEXT,
      is_relevant INTEGER NOT NULL DEFAULT 1,
      excluded_category TEXT,
      excluded_reason TEXT
    );
  `);
  db.prepare(`INSERT INTO research_sources (id, name) VALUES (1, 'Test Source')`).run();
  return db;
}

function insert(
  db: Database.Database,
  opts: {
    id: number;
    isRelevant: 0 | 1;
    category?: string | null;
    reason?: string | null;
    receivedAt?: string;
    processed?: boolean;
  },
) {
  db.prepare(
    `INSERT INTO research_articles (id, source_id, subject, sender, raw_text, received_at, is_relevant, excluded_category, excluded_reason, processed_at)
     VALUES (?, 1, ?, 'x@x', 'body', ?, ?, ?, ?, ?)`,
  ).run(
    opts.id,
    `Article ${opts.id}`,
    opts.receivedAt ?? "2026-05-11 10:00:00",
    opts.isRelevant,
    opts.category ?? null,
    opts.reason ?? null,
    opts.processed ? "2026-05-11 11:00:00" : null,
  );
}

describe("D5 unfilterArticle mutation", () => {
  it("flips is_relevant=0 → 1 and clears category + reason", () => {
    const db = makeDb();
    insert(db, { id: 1, isRelevant: 0, category: "off_topic", reason: "noise" });

    const result = unfilterArticle(db, 1);

    expect(result.changed).toBe(true);
    const row = db.prepare(`SELECT is_relevant, excluded_category, excluded_reason FROM research_articles WHERE id = 1`).get() as {
      is_relevant: number;
      excluded_category: string | null;
      excluded_reason: string | null;
    };
    expect(row.is_relevant).toBe(1);
    expect(row.excluded_category).toBeNull();
    expect(row.excluded_reason).toBeNull();
  });

  it("returns changed=false when the article is already relevant (no double-flip)", () => {
    const db = makeDb();
    insert(db, { id: 1, isRelevant: 1 });

    const result = unfilterArticle(db, 1);

    expect(result.changed).toBe(false);
  });

  it("returns changed=false for a non-existent article id", () => {
    const db = makeDb();

    const result = unfilterArticle(db, 999);

    expect(result.changed).toBe(false);
  });
});

describe("D5 getFilteredArticles query", () => {
  it("returns only is_relevant=0 rows", () => {
    const db = makeDb();
    insert(db, { id: 1, isRelevant: 1 });
    insert(db, { id: 2, isRelevant: 0, category: "receipt", reason: "** Payment Receipt" });
    insert(db, { id: 3, isRelevant: 0, category: "off_topic", reason: "no portfolio connection" });

    const rows = getFilteredArticles(db);
    expect(rows.map((r) => r.id).sort()).toEqual([2, 3]);
    expect(rows.find((r) => r.id === 2)?.excluded_category).toBe("receipt");
    expect(rows.find((r) => r.id === 3)?.excluded_category).toBe("off_topic");
  });

  it("orders results by received_at DESC (newest first)", () => {
    const db = makeDb();
    insert(db, { id: 1, isRelevant: 0, category: "admin", receivedAt: "2026-05-09 10:00:00" });
    insert(db, { id: 2, isRelevant: 0, category: "admin", receivedAt: "2026-05-11 10:00:00" });
    insert(db, { id: 3, isRelevant: 0, category: "admin", receivedAt: "2026-05-10 10:00:00" });

    const rows = getFilteredArticles(db);
    expect(rows.map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it("getFilteredArticleCount matches the result count", () => {
    const db = makeDb();
    insert(db, { id: 1, isRelevant: 1 });
    insert(db, { id: 2, isRelevant: 0, category: "receipt" });
    insert(db, { id: 3, isRelevant: 0, category: "off_topic" });

    expect(getFilteredArticleCount(db)).toBe(2);
  });

  // qa:research-feeds-filtered--search-and-source-controls-noop — the Filtered
  // audit tab must honor the same search + source controls as the main feed
  // (DECIDED: extend the API rather than disable the controls).
  describe("search + sourceId options", () => {
    function seedTwoSources(db: Database.Database) {
      db.prepare(`INSERT INTO research_sources (id, name) VALUES (2, 'Other Source')`).run();
      db.prepare(
        `INSERT INTO research_articles (id, source_id, subject, sender, raw_text, received_at, is_relevant, excluded_category, excluded_reason, summary)
         VALUES (10, 1, 'Spotify deep dive', 'mbi@substack.com', 'body', '2026-08-01 10:00:00', 0, 'off_topic', 'streaming coverage, no held names', 'Spotify Q2 recap')`,
      ).run();
      db.prepare(
        `INSERT INTO research_articles (id, source_id, subject, sender, raw_text, received_at, is_relevant, excluded_category, excluded_reason, summary)
         VALUES (11, 2, 'Payment receipt', 'billing@substack.com', 'body', '2026-08-02 10:00:00', 0, 'receipt', 'admin mail', NULL)`,
      ).run();
    }

    it("filters by sourceId", () => {
      const db = makeDb();
      seedTwoSources(db);

      const rows = getFilteredArticles(db, { sourceId: 2 });
      expect(rows.map((r) => r.id)).toEqual([11]);
    });

    it("filters by search across subject / sender / summary / excluded_reason", () => {
      const db = makeDb();
      seedTwoSources(db);

      expect(getFilteredArticles(db, { search: "spotify" }).map((r) => r.id)).toEqual([10]);
      expect(getFilteredArticles(db, { search: "billing@" }).map((r) => r.id)).toEqual([11]);
      expect(getFilteredArticles(db, { search: "Q2 recap" }).map((r) => r.id)).toEqual([10]);
      expect(getFilteredArticles(db, { search: "admin mail" }).map((r) => r.id)).toEqual([11]);
      expect(getFilteredArticles(db, { search: "zzqqnothingmatchesxx" })).toEqual([]);
    });

    it("combines search + sourceId and honors limit", () => {
      const db = makeDb();
      seedTwoSources(db);

      expect(
        getFilteredArticles(db, { search: "substack", sourceId: 1 }).map((r) => r.id),
      ).toEqual([10]);
      expect(getFilteredArticles(db, { limit: 1 }).map((r) => r.id)).toEqual([11]);
    });
  });
});
