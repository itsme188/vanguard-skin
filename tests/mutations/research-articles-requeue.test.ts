/**
 * Unfilter and Retry re-queue an article whose enrichment failed.
 *
 * Finding: research-feeds--billing-outage-burned-enrich-retry-cap-no-retry-when-credit-returns.
 * Before: Unfilter flipped is_relevant and left processed_at and
 * enrich_attempts as they were, so the article was never enriched.
 *
 * Real schema (runMigrations) so the queue's own SELECT can be run against
 * the result.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  requeueArticlesForEnrichment,
  retryArticleEnrichment,
  unfilterArticle,
} from "@/lib/mutations/research-articles";
import { MAX_ENRICH_ATTEMPTS } from "@/lib/gmail/enrichment-failure";

/** Id of the source makeDb() registered (the migrations seed sources of their own). */
let sourceId = 0;

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  sourceId = db.prepare(`INSERT INTO research_sources (name) VALUES ('ZZ Test Letter')`).run()
    .lastInsertRowid as number;
  return db;
}

interface Fixture {
  isRelevant?: 0 | 1;
  category?: string | null;
  reason?: string | null;
  processedAt?: string | null;
  attempts?: number;
  summary?: string | null;
}

let seq = 0;
function insert(db: Database.Database, f: Fixture = {}): number {
  seq += 1;
  return db
    .prepare(
      `INSERT INTO research_articles
         (source_id, gmail_message_id, subject, sender, raw_text, received_at,
          is_relevant, excluded_category, excluded_reason, processed_at, enrich_attempts, summary)
       VALUES (?, ?, ?, 'letters@example.test', 'body', '2026-01-05 12:00:00', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sourceId,
      `requeue-${seq}`,
      `ZZ letter ${seq}`,
      f.isRelevant ?? 0,
      f.category ?? null,
      f.reason ?? null,
      f.processedAt === undefined ? "2026-01-05 13:00:00" : f.processedAt,
      f.attempts ?? 0,
      f.summary ?? null,
    ).lastInsertRowid as number;
}

const FAILED: Fixture = {
  isRelevant: 0,
  category: "enrichment_failed",
  reason: "Enrichment failed 3 times — last failure: No object generated: the model did not return a response.",
  attempts: MAX_ENRICH_ATTEMPTS,
};

function state(db: Database.Database, id: number) {
  return db
    .prepare(
      `SELECT is_relevant, excluded_category, excluded_reason, processed_at, enrich_attempts, summary
         FROM research_articles WHERE id = ?`,
    )
    .get(id);
}

/** The queue predicate, as lib/gmail/process.ts selects it. */
function inQueue(db: Database.Database, id: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM research_articles a
          WHERE a.id = ?
            AND a.processed_at IS NULL
            AND COALESCE(a.is_relevant, 1) = 1
            AND COALESCE(a.enrich_attempts, 0) < ${MAX_ENRICH_ATTEMPTS}`,
      )
      .get(id) !== undefined
  );
}

const QUEUED = {
  is_relevant: 1,
  excluded_category: null,
  excluded_reason: null,
  processed_at: null,
  enrich_attempts: 0,
};

describe("unfilterArticle", () => {
  it("an 'enrichment_failed' article is re-queued, not just flipped", () => {
    const db = makeDb();
    const id = insert(db, FAILED);
    expect(inQueue(db, id)).toBe(false);

    expect(unfilterArticle(db, id)).toEqual({ changed: true, requeued: true });

    expect(state(db, id)).toMatchObject(QUEUED);
    expect(inQueue(db, id)).toBe(true);
  });

  it("an off-topic article keeps its enrichment and is NOT re-queued", () => {
    const db = makeDb();
    const id = insert(db, {
      isRelevant: 0,
      category: "off_topic",
      reason: "No connection to the portfolio",
      summary: "A real summary.",
      attempts: 1,
    });

    expect(unfilterArticle(db, id)).toEqual({ changed: true, requeued: false });

    expect(state(db, id)).toEqual({
      is_relevant: 1,
      excluded_category: null,
      excluded_reason: null,
      processed_at: "2026-01-05 13:00:00",
      enrich_attempts: 1,
      summary: "A real summary.",
    });
    expect(inQueue(db, id)).toBe(false);
  });

  it("a pre-AI filtered article (never processed) joins the queue as before", () => {
    const db = makeDb();
    const id = insert(db, { isRelevant: 0, category: "receipt", reason: "Payment receipt", processedAt: null });

    expect(unfilterArticle(db, id)).toEqual({ changed: true, requeued: false });
    expect(inQueue(db, id)).toBe(true);
  });

  it("is a no-op on an article that is not filtered, and on a missing id", () => {
    const db = makeDb();
    const id = insert(db, { isRelevant: 1, summary: "kept" });
    const before = state(db, id);

    expect(unfilterArticle(db, id)).toEqual({ changed: false, requeued: false });
    expect(unfilterArticle(db, 999_999)).toEqual({ changed: false, requeued: false });
    expect(state(db, id)).toEqual(before);
  });
});

describe("retryArticleEnrichment", () => {
  it("re-queues an 'enrichment_failed' article", () => {
    const db = makeDb();
    const id = insert(db, FAILED);

    expect(retryArticleEnrichment(db, id)).toEqual({ status: "requeued" });

    expect(state(db, id)).toMatchObject(QUEUED);
    expect(inQueue(db, id)).toBe(true);
  });

  it("a second Retry is refused: the article is already queued", () => {
    const db = makeDb();
    const id = insert(db, FAILED);
    retryArticleEnrichment(db, id);
    const afterFirst = state(db, id);

    expect(retryArticleEnrichment(db, id)).toEqual({ status: "not_failed" });
    expect(state(db, id)).toEqual(afterFirst);
  });

  it.each([
    ["an off-topic article", { isRelevant: 0, category: "off_topic", summary: "A real summary." } as Fixture],
    ["a receipt", { isRelevant: 0, category: "receipt", processedAt: null } as Fixture],
    ["an enriched article in the feed", { isRelevant: 1, summary: "A real summary." } as Fixture],
  ])("refuses %s and changes nothing", (_label, fixture) => {
    const db = makeDb();
    const id = insert(db, fixture);
    const before = state(db, id);

    expect(retryArticleEnrichment(db, id)).toEqual({ status: "not_failed" });
    expect(state(db, id)).toEqual(before);
  });

  it("reports a missing article", () => {
    const db = makeDb();
    expect(retryArticleEnrichment(db, 999_999)).toEqual({ status: "not_found" });
  });
});

describe("requeueArticlesForEnrichment", () => {
  it("re-queues exactly the ids given and reports how many rows it wrote", () => {
    const db = makeDb();
    const a = insert(db, FAILED);
    const b = insert(db, FAILED);
    const untouched = insert(db, FAILED);
    const before = state(db, untouched);

    expect(requeueArticlesForEnrichment(db, [a, b, 999_999])).toBe(2);

    expect(state(db, a)).toMatchObject(QUEUED);
    expect(state(db, b)).toMatchObject(QUEUED);
    expect(state(db, untouched)).toEqual(before);
  });
});
