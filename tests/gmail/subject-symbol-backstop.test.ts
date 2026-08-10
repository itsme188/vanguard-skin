/**
 * Deterministic subject-line linking backstop (lib/gmail/subject-symbol-
 * backstop.ts) — closes the live miss where the extraction model dropped
 * the single-letter ticker "U" from mentioned_symbols even though it was
 * plainly in the subject line ("Review|APP & U 2Q26: D28 IAA Is Now the
 * Core Battleground", FundaAI article id 67770).
 *
 * Two layers of coverage:
 *   - subjectSymbolBackstop (pure): token-split + exact-case membership.
 *   - processUnprocessedArticles integration: the backstop's union actually
 *     reaches both the stored mentioned_symbols JSON and the
 *     research_article_securities link row.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { subjectSymbolBackstop } from "@/lib/gmail/subject-symbol-backstop";

describe("subjectSymbolBackstop (pure)", () => {
  it("matches a single-letter ticker split out by & and |", () => {
    const knownSymbols = new Set(["APP", "U"]);
    const subject = "Review|APP & U 2Q26: D28 IAA Is Now the Core Battleground";
    expect(subjectSymbolBackstop(subject, knownSymbols)).toEqual(["APP", "U"]);
  });

  it("splits on the & separator alone", () => {
    const knownSymbols = new Set(["NVDA", "AMD"]);
    expect(subjectSymbolBackstop("NVDA & AMD rally into earnings", knownSymbols)).toEqual([
      "NVDA",
      "AMD",
    ]);
  });

  it("splits on the | separator alone", () => {
    const knownSymbols = new Set(["MSFT"]);
    expect(subjectSymbolBackstop("Weekly|MSFT wrap", knownSymbols)).toEqual(["MSFT"]);
  });

  it("does NOT match lowercase words even when the exact letters are held", () => {
    // "up" and "at" appear lowercase in ordinary prose — must not match
    // even though "UP" and "AT" are in the known-symbol set.
    const knownSymbols = new Set(["UP", "AT"]);
    expect(subjectSymbolBackstop("check up at noon", knownSymbols)).toEqual([]);
  });

  it("ignores a symbol-shaped token that isn't held or watchlisted", () => {
    const knownSymbols = new Set(["AAPL"]);
    expect(subjectSymbolBackstop("XYZ hosts a webinar today", knownSymbols)).toEqual([]);
  });

  it("dedupes a token that repeats in the subject", () => {
    const knownSymbols = new Set(["APP", "U"]);
    expect(subjectSymbolBackstop("APP APP U", knownSymbols)).toEqual(["APP", "U"]);
  });

  it("returns [] for an empty subject or empty known-symbol set", () => {
    expect(subjectSymbolBackstop("", new Set(["U"]))).toEqual([]);
    expect(subjectSymbolBackstop("APP & U", new Set())).toEqual([]);
  });

  it("splits on commas and parens too", () => {
    const knownSymbols = new Set(["TER", "SOXX"]);
    expect(subjectSymbolBackstop("Semis wrap: TER, (SOXX) breakdown", knownSymbols)).toEqual([
      "TER",
      "SOXX",
    ]);
  });
});

// ── processUnprocessedArticles integration ──────────────────────────────

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

// Pass-through verifyMentions — the backstop must survive independently of
// the AI verification gate, so this mock exercises exactly what the model
// extracted, nothing more.
vi.mock("@/lib/research/verify-mentions", () => ({
  verifyMentions: vi.fn(async (symbols: string[]) =>
    symbols.map((symbol) => ({ symbol, context: "mock context" })),
  ),
}));

import { generateObjectForFeature } from "@/lib/ai/generate";
import { processUnprocessedArticles } from "@/lib/gmail/process";

const LIVE_MISS_SUBJECT = "Review|APP & U 2Q26: D28 IAA Is Now the Core Battleground";

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
  db.prepare(`INSERT INTO research_sources (id, name) VALUES (1, 'FundaAI')`).run();
  // U (Unity) — held position, stock-like type, matches the live bug's
  // securities.id 1717 in spirit (id differs here, it's an in-memory test DB).
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type) VALUES (1717, 'U', 'Unity Software', 'Stock')`,
  ).run();
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (1, 1717, 100, '2026-08-01')`,
  ).run();
  return db;
}

function insertUnprocessed(db: Database.Database, subject: string) {
  db.prepare(
    `INSERT INTO research_articles (source_id, subject, sender, raw_text, received_at)
     VALUES (1, ?, 'newsletter@fundaai.com', 'long enough article body for processing', '2026-08-10')`,
  ).run(subject);
}

describe("processUnprocessedArticles — subject-line backstop wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("unions a subject-only ticker the model dropped into mentioned_symbols + links it", async () => {
    const db = makeDb();
    insertUnprocessed(db, LIVE_MISS_SUBJECT);
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: {
        summary: "APP/U 2Q26 battleground review.",
        key_themes: ["ad tech"],
        sentiment: "neutral",
        sentiment_score: 0,
        mentioned_symbols: ["APP"], // model drops "U" — the live bug
        portfolio_relevance: "Relevant to your U position.",
        is_portfolio_relevant: true,
      },
    });

    const result = await processUnprocessedArticles(db);
    expect(result).toEqual({ processed: 1, failed: 0 });

    const row = db
      .prepare(`SELECT mentioned_symbols FROM research_articles WHERE id = 1`)
      .get() as { mentioned_symbols: string };
    const symbols = JSON.parse(row.mentioned_symbols) as string[];
    expect(symbols).toContain("U");
    expect(symbols).toContain("APP");

    const link = db
      .prepare(`SELECT security_id FROM research_article_securities WHERE security_id = 1717`)
      .get();
    expect(link).toBeTruthy();
  });

  it("does not duplicate a symbol the model already extracted itself", async () => {
    const db = makeDb();
    insertUnprocessed(db, LIVE_MISS_SUBJECT);
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: {
        summary: "APP/U 2Q26 battleground review.",
        key_themes: ["ad tech"],
        sentiment: "neutral",
        sentiment_score: 0,
        mentioned_symbols: ["APP", "U"], // model already caught "U" this time
        portfolio_relevance: "Relevant to your U position.",
        is_portfolio_relevant: true,
      },
    });

    await processUnprocessedArticles(db);

    const row = db
      .prepare(`SELECT mentioned_symbols FROM research_articles WHERE id = 1`)
      .get() as { mentioned_symbols: string };
    const symbols = JSON.parse(row.mentioned_symbols) as string[];
    expect(symbols.filter((s) => s === "U")).toHaveLength(1);

    const links = db
      .prepare(`SELECT security_id FROM research_article_securities WHERE security_id = 1717`)
      .all();
    expect(links).toHaveLength(1);
  });

  it("does not backstop a symbol that is not held or watchlisted, even if capitalized in the subject", async () => {
    const db = makeDb();
    insertUnprocessed(db, "XYZ Corp announces Q2 results, up big");
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: {
        summary: "Unrelated company report.",
        key_themes: ["earnings"],
        sentiment: "neutral",
        sentiment_score: 0,
        mentioned_symbols: [],
        portfolio_relevance: "No portfolio link.",
        is_portfolio_relevant: false,
      },
    });

    await processUnprocessedArticles(db);

    const row = db
      .prepare(`SELECT mentioned_symbols FROM research_articles WHERE id = 1`)
      .get() as { mentioned_symbols: string };
    expect(JSON.parse(row.mentioned_symbols)).toEqual([]);

    const links = db.prepare(`SELECT * FROM research_article_securities`).all();
    expect(links).toHaveLength(0);
  });
});
