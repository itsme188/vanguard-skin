/**
 * Model-boundary guard for tagged-remnant summaries.
 *
 * The model intermittently dumps its ENTIRE tagged response inside the
 * `summary` string field ("...text.</summary>\n<key_themes">[...]</key_themes>
 * <sentiment>neutral</sentiment>..."). jsonSchema() can't catch it — the field
 * IS a valid string — so the guard lives at the storage boundary, same family
 * as normalizeThemes (2026-07-15 key_themes-as-string outage). Observed live:
 * 9 research_articles rows between 2026-07-07 and 2026-07-20 (QA finding
 * research-feeds--raw-ai-extraction-xml-tags-in-article-bodies-regression).
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
import { processUnprocessedArticles, sanitizeModelSummary, sanitizeThemeList } from "@/lib/gmail/process";

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
      name TEXT
    );
    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      as_of_date TEXT NOT NULL
    );
  `);
  db.prepare(`INSERT INTO research_sources (id, name) VALUES (1, 'Test Source')`).run();
  db.prepare(
    `INSERT INTO research_articles (source_id, subject, sender, raw_text, received_at)
     VALUES (1, 'Tagged-output edition', 'x@x', 'long enough article body for processing', '2026-07-20')`,
  ).run();
  return db;
}

// Verbatim shape of the live 2026-07-20 VK row (id 53964), incl. the
// malformed <key_themes"> tag the model actually emitted.
const POISONED_SUMMARY =
  'Vital Knowledge reports tariff developments adding cost burdens.</summary>\n' +
  '<key_themes">["Canada tariffs", "Trade policy unpredictability"]</key_themes>\n' +
  '<sentiment>neutral</sentiment>\n<sentiment_score>-0.05</sentiment_score>\n' +
  "<mentioned_symbols>[]</mentioned_symbols>";

describe("sanitizeModelSummary (pure)", () => {
  it("cuts at the first tagged remnant, incl. the malformed <key_themes\"> variant", () => {
    expect(sanitizeModelSummary(POISONED_SUMMARY)).toBe(
      "Vital Knowledge reports tariff developments adding cost burdens.",
    );
  });

  it("strips a leading <summary> wrapper", () => {
    expect(sanitizeModelSummary("<summary>Clean text here.</summary>")).toBe("Clean text here.");
  });

  it("passes clean prose through unchanged (incl. legit angle brackets in math)", () => {
    expect(sanitizeModelSummary("EPS beat; guidance for Q3 <10% growth.")).toBe(
      "EPS beat; guidance for Q3 <10% growth.",
    );
  });

  it("empty/nullish-ish input → empty string", () => {
    expect(sanitizeModelSummary("")).toBe("");
  });

  it("cuts at a <parameter remnant too", () => {
    expect(sanitizeModelSummary('Real prose here.<parameter name="key_themes">["x"]')).toBe(
      "Real prose here.",
    );
  });
});

describe("sanitizeThemeList (pure)", () => {
  it("cleans the 7/22 row-55380 shape: tag wrapper + stray brackets/quotes", () => {
    const poisoned = [
      '<parameter name="key_themes">["Google AI Overviews impact on publisher traffic"',
      '"search/AI Mode reducing outbound clicks"',
      '"publisher data licensing deals and long-tail disadvantage"',
      '"antitrust/policy implications for search dominance"',
      '"user experience vs. publisher traffic tradeoffs"]',
    ];
    expect(sanitizeThemeList(poisoned)).toEqual([
      "Google AI Overviews impact on publisher traffic",
      "search/AI Mode reducing outbound clicks",
      "publisher data licensing deals and long-tail disadvantage",
      "antitrust/policy implications for search dominance",
      "user experience vs. publisher traffic tradeoffs",
    ]);
  });

  it("keeps normal arrays untouched and caps at 5", () => {
    expect(sanitizeThemeList(["fed policy", "tech earnings", "a", "b", "c", "d"])).toEqual([
      "fed policy", "tech earnings", "a", "b", "c",
    ]);
  });

  it("splits a comma-joined string (legacy model behavior)", () => {
    expect(sanitizeThemeList("fed policy, tech earnings")).toEqual(["fed policy", "tech earnings"]);
  });

  it("drops elements that are pure tag debris; null/objects -> []", () => {
    expect(sanitizeThemeList(['\n<par', "real theme"])).toEqual(["real theme"]);
    expect(sanitizeThemeList(null)).toEqual([]);
    expect(sanitizeThemeList({})).toEqual([]);
  });

  it("legit angle brackets in themes survive (rates <1%, >50% upside)", () => {
    expect(sanitizeThemeList(["rates <1% scenario", ">50% upside case"])).toEqual([
      "rates <1% scenario", ">50% upside case",
    ]);
  });
});

describe("processUnprocessedArticles stores a sanitized summary", () => {
  beforeEach(() => vi.clearAllMocks());

  it("a tagged-blob summary from the model never reaches the DB", async () => {
    const db = makeDb();
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: {
        summary: POISONED_SUMMARY,
        key_themes: ["Canada tariffs"],
        sentiment: "neutral",
        sentiment_score: -0.05,
        mentioned_symbols: [],
        portfolio_relevance: "Macro relevance.",
        is_portfolio_relevant: true,
      },
    });

    await processUnprocessedArticles(db);

    const row = db.prepare(`SELECT summary FROM research_articles WHERE id = 1`).get() as {
      summary: string;
    };
    expect(row.summary).toBe("Vital Knowledge reports tariff developments adding cost burdens.");
    expect(row.summary).not.toContain("</summary>");
    expect(row.summary).not.toContain("<sentiment>");
  });
});
