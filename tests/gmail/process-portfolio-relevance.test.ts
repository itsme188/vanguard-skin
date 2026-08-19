/**
 * D3 portfolio-relevance gate — integration tests over processUnprocessedArticles.
 *
 * Mocks generateObject so the assertions exercise only the post-extraction
 * branching: is_portfolio_relevant=false flips is_relevant=0, source-level
 * allow_off_topic opts out, missing field defaults to relevant (under-filter).
 *
 * verifyMentions is mocked to pass through symbols unmodified — the gate
 * logic is independent of the mention-verification two-layer drop.
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
import { processUnprocessedArticles } from "@/lib/gmail/process";

function makeDb(allowOffTopic = 0): Database.Database {
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
      enrich_attempts INTEGER NOT NULL DEFAULT 0,
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
    `INSERT INTO research_sources (id, name, allow_off_topic) VALUES (1, 'Test Source', ?)`,
  ).run(allowOffTopic);
  return db;
}

function insertUnprocessed(db: Database.Database, subject = "Off-topic piece") {
  db.prepare(
    `INSERT INTO research_articles (source_id, subject, sender, raw_text, received_at)
     VALUES (1, ?, 'x@x', 'long enough article body for processing', '2026-05-11')`,
  ).run(subject);
}

const OFF_TOPIC_RESPONSE = {
  summary: "Off-topic content",
  key_themes: ["unrelated"],
  sentiment: "neutral",
  sentiment_score: 0,
  mentioned_symbols: [],
  portfolio_relevance: "No connection to the user's holdings.",
  is_portfolio_relevant: false,
};

const RELEVANT_RESPONSE = {
  summary: "Macro context",
  key_themes: ["fed policy"],
  sentiment: "bearish",
  sentiment_score: -0.3,
  mentioned_symbols: [],
  portfolio_relevance: "Relevant to broad market exposure.",
  is_portfolio_relevant: true,
};

describe("D3 portfolio-relevance gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("flips is_relevant=0 and tags 'off_topic' when Claude votes false and source does NOT allow off-topic", async () => {
    const db = makeDb(0);
    insertUnprocessed(db);
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: OFF_TOPIC_RESPONSE,
    });

    await processUnprocessedArticles(db);

    const row = db
      .prepare(
        `SELECT is_relevant, excluded_category, excluded_reason, summary, processed_at
         FROM research_articles WHERE id = 1`,
      )
      .get() as {
      is_relevant: number;
      excluded_category: string | null;
      excluded_reason: string | null;
      summary: string | null;
      processed_at: string | null;
    };

    expect(row.is_relevant).toBe(0);
    expect(row.excluded_category).toBe("off_topic");
    expect(row.excluded_reason).toBe("No connection to the user's holdings.");
    expect(row.summary).toBe("Off-topic content");
    expect(row.processed_at).not.toBeNull();
  });

  it("keeps is_relevant=1 when source has allow_off_topic=1 (escape hatch for Helene-style commentary)", async () => {
    const db = makeDb(1);
    insertUnprocessed(db);
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: OFF_TOPIC_RESPONSE,
    });

    await processUnprocessedArticles(db);

    const row = db
      .prepare(`SELECT is_relevant, excluded_category FROM research_articles WHERE id = 1`)
      .get() as { is_relevant: number; excluded_category: string | null };

    expect(row.is_relevant).toBe(1);
    expect(row.excluded_category).toBeNull();
  });

  it("keeps is_relevant=1 when Claude votes true", async () => {
    const db = makeDb(0);
    insertUnprocessed(db, "Fed pivot drives Q3 macro view");
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: RELEVANT_RESPONSE,
    });

    await processUnprocessedArticles(db);

    const row = db
      .prepare(`SELECT is_relevant, excluded_category FROM research_articles WHERE id = 1`)
      .get() as { is_relevant: number; excluded_category: string | null };

    expect(row.is_relevant).toBe(1);
    expect(row.excluded_category).toBeNull();
  });

  it("under-filters when is_portfolio_relevant is missing/null from the response (defensive default)", async () => {
    const db = makeDb(0);
    insertUnprocessed(db, "Ambiguous content");
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: {
        ...RELEVANT_RESPONSE,
        is_portfolio_relevant: undefined,
      },
    });

    await processUnprocessedArticles(db);

    const row = db
      .prepare(`SELECT is_relevant FROM research_articles WHERE id = 1`)
      .get() as { is_relevant: number };

    expect(row.is_relevant).toBe(1);
  });

  it("uses a fallback reason when portfolio_relevance string is empty", async () => {
    const db = makeDb(0);
    insertUnprocessed(db);
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: { ...OFF_TOPIC_RESPONSE, portfolio_relevance: "" },
    });

    await processUnprocessedArticles(db);

    const row = db
      .prepare(`SELECT excluded_reason FROM research_articles WHERE id = 1`)
      .get() as { excluded_reason: string };

    expect(row.excluded_reason).toBe("Claude judged article off-topic");
  });

  it("truncates a very long portfolio_relevance string at 280 chars (excluded_reason audit field guard)", async () => {
    const db = makeDb(0);
    insertUnprocessed(db);
    const longRelevance = "A".repeat(500);
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: { ...OFF_TOPIC_RESPONSE, portfolio_relevance: longRelevance },
    });

    await processUnprocessedArticles(db);

    const row = db
      .prepare(`SELECT excluded_reason FROM research_articles WHERE id = 1`)
      .get() as { excluded_reason: string };

    expect(row.excluded_reason.length).toBe(280);
  });
});
