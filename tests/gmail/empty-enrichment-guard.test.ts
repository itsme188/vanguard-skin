/**
 * QA finding research-feeds--empty-enrichment-marked-processed-fake-neutral-chip
 * (2026-08-19, HIGH): 78 research_articles rows were stamped processed_at
 * with a completely empty enrichment (summary='', key_themes=[],
 * mentioned_symbols=[], portfolio_relevance='', sentiment 'neutral'/0.0 all
 * in lockstep — the "parse produced nothing" tell). The feed card then
 * rendered a fabricated 'neutral' sentiment chip on an otherwise-empty stub
 * card. 61/78 were ai_model=claude-sonnet-5, so this was not just a
 * cloud-fallback artifact — the pipeline itself must treat an all-defaults
 * parse as a FAILED extraction, not a successful neutral read.
 *
 * Covers processUnprocessedArticles' guard:
 *   1. An all-defaults result (empty summary AND empty key_themes) does NOT
 *      stamp processed_at and does NOT store the fabricated 'neutral'
 *      sentiment — the row is left untouched for the next pass to retry.
 *   2. A genuine neutral enrichment WITH real summary text (even with zero
 *      themes) still stores normally — the guard is an AND, not an OR, so
 *      legitimate terse-but-real reads are never dropped.
 *   3. isEmptyEnrichmentResult, the exported predicate, matches only the
 *      true all-defaults shape.
 *
 * Also covers the retry cap added on top of that guard: a persistently
 * failing article (empty parse OR hard error) increments
 * research_articles.enrich_attempts each pass, drops out of the retry queue
 * once it hits MAX_ENRICH_ATTEMPTS, and gets excluded as
 * 'enrichment_failed' — so the LIMIT-20 queue head can't wedge on a
 * permanently-broken article.
 *
 * Uses runMigrations (:memory: SQLite) so the real schema — including
 * migration 083's enrich_attempts column — is present, same pattern as
 * tests/scripts/repair-empty-enrichments.test.ts. Mocks
 * generateObjectForFeature (no real AI calls) — same pattern as
 * tests/gmail/process-portfolio-relevance.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("ai", () => ({
  jsonSchema: <T,>(s: T) => s,
}));

vi.mock("@/lib/ai/generate", () => ({
  generateObjectForFeature: vi.fn(),
}));

vi.mock("@/lib/ai/models", () => ({
  FEATURE_MODELS: { newsletterProcessing: "mock-model" },
  resolveFeatureModel: () => ({ provider: "anthropic", modelId: "mock-model" }),
}));

vi.mock("@/lib/research/verify-mentions", () => ({
  verifyMentions: vi.fn(async (symbols: string[]) =>
    symbols.map((symbol) => ({ symbol, context: "mock context" })),
  ),
}));

import { generateObjectForFeature } from "@/lib/ai/generate";
import {
  processUnprocessedArticles,
  isEmptyEnrichmentResult,
  MAX_ENRICH_ATTEMPTS,
} from "@/lib/gmail/process";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function insertSource(db: Database.Database): number {
  const result = db
    .prepare(`INSERT INTO research_sources (name) VALUES ('Test Source')`)
    .run();
  return result.lastInsertRowid as number;
}

function insertUnprocessed(
  db: Database.Database,
  sourceId: number,
  subject = "Empty parse test",
  enrichAttempts = 0,
): number {
  const result = db
    .prepare(
      `INSERT INTO research_articles
         (source_id, gmail_message_id, subject, sender, raw_text, received_at, enrich_attempts)
       VALUES (?, ?, ?, 'x@x', 'long enough article body for processing', '2026-08-19', ?)`,
    )
    .run(sourceId, `msg-${Math.random()}`, subject, enrichAttempts);
  return result.lastInsertRowid as number;
}

/** Fresh :memory: db + one registered source — the common setup every test needs. */
function setup(): { db: Database.Database; sourceId: number } {
  const db = makeDb();
  const sourceId = insertSource(db);
  return { db, sourceId };
}

const ALL_DEFAULTS_RESPONSE = {
  summary: "",
  key_themes: [],
  sentiment: "neutral",
  sentiment_score: 0,
  mentioned_symbols: [],
  portfolio_relevance: "",
  is_portfolio_relevant: true,
};

const GENUINE_NEUTRAL_RESPONSE = {
  summary: "Rates held steady this week; the desk sees no near-term catalyst either way.",
  key_themes: [],
  sentiment: "neutral",
  sentiment_score: 0,
  mentioned_symbols: [],
  portfolio_relevance: "",
  is_portfolio_relevant: true,
};

describe("processUnprocessedArticles — empty-enrichment guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT stamp processed_at and does NOT store a fabricated 'neutral' sentiment for an all-defaults parse", async () => {
    const { db, sourceId } = setup();
    insertUnprocessed(db, sourceId);
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: ALL_DEFAULTS_RESPONSE,
    });

    const result = await processUnprocessedArticles(db);

    const row = db
      .prepare(
        `SELECT summary, key_themes, sentiment, sentiment_score, mentioned_symbols,
                portfolio_relevance, processed_at, ai_model
         FROM research_articles WHERE id = 1`,
      )
      .get() as {
      summary: string | null;
      key_themes: string | null;
      sentiment: string | null;
      sentiment_score: number | null;
      mentioned_symbols: string | null;
      portfolio_relevance: string | null;
      processed_at: string | null;
      ai_model: string | null;
    };

    expect(row.processed_at).toBeNull();
    expect(row.sentiment).toBeNull();
    expect(row.sentiment_score).toBeNull();
    expect(row.summary).toBeNull();
    expect(row.key_themes).toBeNull();
    expect(row.mentioned_symbols).toBeNull();
    expect(row.portfolio_relevance).toBeNull();
    expect(row.ai_model).toBeNull();

    // The article is counted as failed (not silently dropped) so the
    // pipeline's caller can see enrichment isn't fully caught up, and the
    // row remains eligible for the very next processUnprocessedArticles
    // pass (its SELECT filters on processed_at IS NULL).
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
  });

  it("does not link any securities when the parse is all-defaults, even if mentioned_symbols were somehow non-empty", async () => {
    const { db, sourceId } = setup();
    insertUnprocessed(db, sourceId);
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (1, 'AAPL', 'Stock')`).run();
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: ALL_DEFAULTS_RESPONSE,
    });

    await processUnprocessedArticles(db);

    const links = db.prepare(`SELECT COUNT(*) as n FROM research_article_securities`).get() as {
      n: number;
    };
    expect(links.n).toBe(0);
  });

  it("stores a genuine neutral enrichment with real summary text normally (does not break legitimate neutrals)", async () => {
    const { db, sourceId } = setup();
    insertUnprocessed(db, sourceId, "Fed holds rates steady");
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: GENUINE_NEUTRAL_RESPONSE,
    });

    const result = await processUnprocessedArticles(db);

    const row = db
      .prepare(
        `SELECT summary, sentiment, sentiment_score, processed_at FROM research_articles WHERE id = 1`,
      )
      .get() as {
      summary: string | null;
      sentiment: string | null;
      sentiment_score: number | null;
      processed_at: string | null;
    };

    expect(row.processed_at).not.toBeNull();
    expect(row.sentiment).toBe("neutral");
    expect(row.sentiment_score).toBe(0);
    expect(row.summary).toBe(GENUINE_NEUTRAL_RESPONSE.summary);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("stores normally when summary is empty but real themes were extracted (guard is AND, not OR)", async () => {
    const { db, sourceId } = setup();
    insertUnprocessed(db, sourceId, "Themes but no summary edge case");
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: { ...ALL_DEFAULTS_RESPONSE, key_themes: ["fed policy", "rates"] },
    });

    const result = await processUnprocessedArticles(db);

    const row = db
      .prepare(`SELECT processed_at, key_themes FROM research_articles WHERE id = 1`)
      .get() as { processed_at: string | null; key_themes: string | null };

    expect(row.processed_at).not.toBeNull();
    expect(JSON.parse(row.key_themes ?? "[]")).toEqual(["fed policy", "rates"]);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
  });
});

describe("processUnprocessedArticles — enrich_attempts retry cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("increments enrich_attempts by 1 per pass while the article keeps failing (empty-enrichment mode)", async () => {
    const { db, sourceId } = setup();
    const id = insertUnprocessed(db, sourceId);
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: ALL_DEFAULTS_RESPONSE,
    });

    const attemptsAfter = (): number =>
      (
        db.prepare(`SELECT enrich_attempts FROM research_articles WHERE id = ?`).get(id) as {
          enrich_attempts: number;
        }
      ).enrich_attempts;

    await processUnprocessedArticles(db);
    expect(attemptsAfter()).toBe(1);

    await processUnprocessedArticles(db);
    expect(attemptsAfter()).toBe(2);

    // Still under the cap after two failures — not yet excluded.
    const row = db
      .prepare(`SELECT is_relevant, excluded_category, processed_at FROM research_articles WHERE id = ?`)
      .get(id) as { is_relevant: number; excluded_category: string | null; processed_at: string | null };
    expect(row.is_relevant).toBe(1);
    expect(row.excluded_category).toBeNull();
    expect(row.processed_at).toBeNull();
  });

  it("excludes the article as 'enrichment_failed' after the third failing pass", async () => {
    const { db, sourceId } = setup();
    const id = insertUnprocessed(db, sourceId);
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: ALL_DEFAULTS_RESPONSE,
    });

    for (let i = 0; i < MAX_ENRICH_ATTEMPTS; i++) {
      await processUnprocessedArticles(db);
    }

    const row = db
      .prepare(
        `SELECT enrich_attempts, is_relevant, excluded_category, excluded_reason, processed_at
         FROM research_articles WHERE id = ?`,
      )
      .get(id) as {
      enrich_attempts: number;
      is_relevant: number;
      excluded_category: string | null;
      excluded_reason: string | null;
      processed_at: string | null;
    };

    expect(row.enrich_attempts).toBe(MAX_ENRICH_ATTEMPTS);
    expect(row.excluded_category).toBe("enrichment_failed");
    expect(row.is_relevant).toBe(0);
    expect(row.processed_at).not.toBeNull();
    expect(row.excluded_reason).toMatch(/failed/i);
  });

  it("does not select (and does not call the AI mock for) an article already at enrich_attempts = MAX_ENRICH_ATTEMPTS", async () => {
    const { db, sourceId } = setup();
    insertUnprocessed(db, sourceId, "Already capped out", MAX_ENRICH_ATTEMPTS);
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: GENUINE_NEUTRAL_RESPONSE,
    });

    const result = await processUnprocessedArticles(db);

    expect(generateObjectForFeature).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("increments enrich_attempts on a hard-error failure too, and excludes the same way at the cap", async () => {
    const { db, sourceId } = setup();
    const id = insertUnprocessed(db, sourceId);
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("simulated model outage"),
    );

    await processUnprocessedArticles(db);
    let row = db
      .prepare(`SELECT enrich_attempts, excluded_category, processed_at FROM research_articles WHERE id = ?`)
      .get(id) as { enrich_attempts: number; excluded_category: string | null; processed_at: string | null };
    expect(row.enrich_attempts).toBe(1);
    expect(row.excluded_category).toBeNull();
    expect(row.processed_at).toBeNull();

    await processUnprocessedArticles(db);
    const result = await processUnprocessedArticles(db);

    row = db
      .prepare(
        `SELECT enrich_attempts, is_relevant, excluded_category, excluded_reason, processed_at
         FROM research_articles WHERE id = ?`,
      )
      .get(id) as {
      enrich_attempts: number;
      is_relevant: number;
      excluded_category: string | null;
      excluded_reason: string | null;
      processed_at: string | null;
    };

    expect(row.enrich_attempts).toBe(MAX_ENRICH_ATTEMPTS);
    expect(row.excluded_category).toBe("enrichment_failed");
    expect(row.is_relevant).toBe(0);
    expect(row.processed_at).not.toBeNull();
    expect(row.excluded_reason).toMatch(/failed/i);
    expect(row.excluded_reason).toMatch(/simulated model outage/);
    expect(result.failed).toBe(1);
  });

  it("processes normally on the third pass when an article that failed twice finally succeeds", async () => {
    const { db, sourceId } = setup();
    const id = insertUnprocessed(db, sourceId, "Recovers on third try", MAX_ENRICH_ATTEMPTS - 1);
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: GENUINE_NEUTRAL_RESPONSE,
    });

    const result = await processUnprocessedArticles(db);

    const row = db
      .prepare(
        `SELECT summary, sentiment, sentiment_score, processed_at, excluded_category, is_relevant
         FROM research_articles WHERE id = ?`,
      )
      .get(id) as {
      summary: string | null;
      sentiment: string | null;
      sentiment_score: number | null;
      processed_at: string | null;
      excluded_category: string | null;
      is_relevant: number;
    };

    expect(row.processed_at).not.toBeNull();
    expect(row.excluded_category).toBeNull();
    expect(row.is_relevant).toBe(1);
    expect(row.sentiment).toBe("neutral");
    expect(row.summary).toBe(GENUINE_NEUTRAL_RESPONSE.summary);
    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
  });
});

describe("isEmptyEnrichmentResult", () => {
  it("is true when summary and key_themes are both empty", () => {
    expect(
      isEmptyEnrichmentResult({
        summary: "",
        key_themes: [],
        sentiment: "neutral",
        sentiment_score: 0,
        mentioned_symbols: [],
        portfolio_relevance: "",
        is_portfolio_relevant: true,
      }),
    ).toBe(true);
  });

  it("is true when summary is whitespace-only and key_themes is empty", () => {
    expect(
      isEmptyEnrichmentResult({
        summary: "   ",
        key_themes: [],
        sentiment: "neutral",
        sentiment_score: 0,
        mentioned_symbols: [],
        portfolio_relevance: "",
        is_portfolio_relevant: true,
      }),
    ).toBe(true);
  });

  it("is false when summary has real text, even with zero themes", () => {
    expect(
      isEmptyEnrichmentResult({
        summary: "Real desk note.",
        key_themes: [],
        sentiment: "neutral",
        sentiment_score: 0,
        mentioned_symbols: [],
        portfolio_relevance: "",
        is_portfolio_relevant: true,
      }),
    ).toBe(false);
  });

  it("is false when key_themes has content, even with empty summary", () => {
    expect(
      isEmptyEnrichmentResult({
        summary: "",
        key_themes: ["fed policy"],
        sentiment: "neutral",
        sentiment_score: 0,
        mentioned_symbols: [],
        portfolio_relevance: "",
        is_portfolio_relevant: true,
      }),
    ).toBe(false);
  });
});
