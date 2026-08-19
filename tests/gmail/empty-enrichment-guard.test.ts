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
 * Covers processUnprocessedArticles' new guard:
 *   1. An all-defaults result (empty summary AND empty key_themes) does NOT
 *      stamp processed_at and does NOT store the fabricated 'neutral'
 *      sentiment — the row is left untouched for the next pass to retry.
 *   2. A genuine neutral enrichment WITH real summary text (even with zero
 *      themes) still stores normally — the guard is an AND, not an OR, so
 *      legitimate terse-but-real reads are never dropped.
 *   3. isEmptyEnrichmentResult, the exported predicate, matches only the
 *      true all-defaults shape.
 *
 * Mocks generateObjectForFeature (no real AI calls) — same pattern as
 * tests/gmail/process-portfolio-relevance.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

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
import { processUnprocessedArticles, isEmptyEnrichmentResult } from "@/lib/gmail/process";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE research_sources (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      processing_prompt TEXT,
      allow_off_topic INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE research_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      subject TEXT NOT NULL,
      sender TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      received_at TEXT NOT NULL,
      summary TEXT,
      key_themes TEXT,
      sentiment TEXT,
      sentiment_score REAL,
      mentioned_symbols TEXT,
      portfolio_relevance TEXT,
      ai_model TEXT,
      processed_at TEXT,
      is_relevant INTEGER NOT NULL DEFAULT 1,
      excluded_category TEXT,
      excluded_reason TEXT
    );
    CREATE TABLE research_article_securities (
      article_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      mention_context TEXT,
      sentiment TEXT,
      UNIQUE(article_id, security_id)
    );
    CREATE TABLE securities (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      name TEXT,
      security_type TEXT
    );
    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      as_of_date TEXT NOT NULL
    );
    CREATE TABLE watchlist (
      id INTEGER PRIMARY KEY,
      security_id INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
  `);
  db.prepare(
    `INSERT INTO research_sources (id, name, allow_off_topic) VALUES (1, 'Test Source', 0)`,
  ).run();
  return db;
}

function insertUnprocessed(db: Database.Database, subject = "Empty parse test") {
  db.prepare(
    `INSERT INTO research_articles (source_id, subject, sender, raw_text, received_at)
     VALUES (1, ?, 'x@x', 'long enough article body for processing', '2026-08-19')`,
  ).run(subject);
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
    const db = makeDb();
    insertUnprocessed(db);
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
    const db = makeDb();
    insertUnprocessed(db);
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
    const db = makeDb();
    insertUnprocessed(db, "Fed holds rates steady");
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
    const db = makeDb();
    insertUnprocessed(db, "Themes but no summary edge case");
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
