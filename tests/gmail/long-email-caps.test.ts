/**
 * Long-email ingestion caps (R2 audit, 2026-07-03).
 *
 * Gmail's REST fetch returns complete bodies (the web UI's ~102KB clipping
 * is cosmetic), but the pipeline self-inflicted two truncations: raw_text
 * stored at ≤50k chars (48 live articles sat exactly at the cap — 13 of
 * them Eliant Capital weeklies) and the extraction prompt saw only the
 * FIRST 15k chars, so summaries for long weeklies reflected ~the opening
 * 15% and the tail never influenced the AI on either the Mac or Worker
 * path. These tests pin the raised caps and the prompt behavior.
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
import {
  RAW_TEXT_STORE_CAP,
  RAW_HTML_STORE_CAP,
  EXTRACTION_PROMPT_CHAR_CAP,
  truncateForPrompt,
} from "@/lib/gmail/prompt-caps";

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
    CREATE TABLE securities (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL UNIQUE, name TEXT);
    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      as_of_date TEXT NOT NULL
    );
  `);
  db.prepare("INSERT INTO research_sources (id, name) VALUES (1, 'Eliant Capital')").run();
  return db;
}

const AI_RESPONSE = {
  summary: "Weekly synthesis",
  key_themes: ["semis"],
  sentiment: "bullish",
  sentiment_score: 0.4,
  mentioned_symbols: [],
  portfolio_relevance: "Held names discussed.",
  is_portfolio_relevant: true,
};

describe("long-email caps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pins the raised store caps (48 live articles were clipped at exactly 50k)", () => {
    expect(RAW_TEXT_STORE_CAP).toBeGreaterThanOrEqual(500_000);
    expect(RAW_HTML_STORE_CAP).toBeGreaterThanOrEqual(500_000);
    expect(EXTRACTION_PROMPT_CHAR_CAP).toBeGreaterThanOrEqual(150_000);
  });

  it("truncateForPrompt passes short text through untouched and marks long text", () => {
    expect(truncateForPrompt("short body")).toBe("short body");
    const long = "x".repeat(EXTRACTION_PROMPT_CHAR_CAP + 100);
    const out = truncateForPrompt(long);
    expect(out.length).toBeLessThan(long.length);
    expect(out.endsWith("\n...[truncated]")).toBe(true);
  });

  it("the extraction prompt includes long-weekly content far beyond the old 15k cap", async () => {
    const db = makeDb();
    const sentinel = "LATE-SECTION-THESIS-MARKER-XYZZY";
    const body = "a".repeat(100_000) + sentinel + "b".repeat(5_000);
    db.prepare(
      "INSERT INTO research_articles (source_id, subject, sender, raw_text, received_at) VALUES (1, 'Weekly', 'e@e', ?, '2026-07-01')",
    ).run(body);

    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: AI_RESPONSE,
    });

    await processUnprocessedArticles(db);

    const call = (generateObjectForFeature as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toBeDefined();
    const prompt = call[1].prompt as string;
    expect(prompt).toContain(sentinel);
  });

  it("content beyond the extraction cap is dropped with a [truncated] marker", async () => {
    const db = makeDb();
    const sentinel = "BEYOND-CAP-MARKER-PLUGH";
    const body = "a".repeat(EXTRACTION_PROMPT_CHAR_CAP + 10_000) + sentinel;
    db.prepare(
      "INSERT INTO research_articles (source_id, subject, sender, raw_text, received_at) VALUES (1, 'Mega', 'e@e', ?, '2026-07-01')",
    ).run(body);

    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: AI_RESPONSE,
    });

    await processUnprocessedArticles(db);

    const prompt = (generateObjectForFeature as ReturnType<typeof vi.fn>).mock.calls[0][1]
      .prompt as string;
    expect(prompt).not.toContain(sentinel);
    expect(prompt).toContain("...[truncated]");
  });
});
