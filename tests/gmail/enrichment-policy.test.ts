/**
 * Owner ruling 2026-11-02 (AI-spend cut): Semi Doped, Bloomberg Odd Lots and
 * TBPN are never AI-summarized; Vital Knowledge only for "Vital Dawn".
 *
 * Pins: the JS rule, its SQL twin (parity over a probe table), the real queue
 * (processUnprocessedArticles makes no model call for a skipped source and
 * still enriches a control; skipped rows lapse, never deleted, and cannot
 * crowd the 20-row window), and the Worker's byte-identical mirror.
 * Invented subjects only: the repo is public.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("ai", () => ({ jsonSchema: <T,>(s: T) => s }));
vi.mock("@/lib/ai/generate", () => ({ generateObjectForFeature: vi.fn() }));
vi.mock("@/lib/ai/models", () => ({
  FEATURE_MODELS: { newsletterProcessing: "mock-model" },
  resolveFeatureModel: () => ({ provider: "anthropic", modelId: "mock-model" }),
}));
vi.mock("@/lib/research/verify-mentions", () => ({
  verifyMentions: vi.fn(async (symbols: string[]) =>
    symbols.map((symbol) => ({ symbol, context: "ctx" })),
  ),
}));

import { generateObjectForFeature } from "@/lib/ai/generate";
import { processUnprocessedArticles } from "@/lib/gmail/process";
import {
  shouldSummarizeArticle,
  summarizableArticleSql,
} from "@/lib/gmail/enrichment-policy";

const DAWN = "Vital Knowledge: Vital Dawn for Monday November 2, 2026";
const NOT_DAWN = [
  "Vital Knowledge: Vital Market Recap for Monday November 2, 2026",
  "Vital Knowledge: Vital Mid-Day Market Update for Monday November 2, 2026",
  "Vital Knowledge: Company-specific news for Mon 11/2 (AMC) - AAA, BBB",
  "Vital Knowledge: Vital Weekend (Sun 11/1/2026) - getting ready for the week ahead",
  "Vital Knowledge: Apple: takeaways on FQ4 earnings",
];

const PROBES: [string, string, boolean][] = [
  ["Semi Doped", "Any episode", false],
  ["Bloomberg Odd Lots", "Any episode", false],
  ["TBPN", "Any episode", false],
  ["  tbpn ", "Case and padding do not matter", false],
  ["Vital Knowledge", DAWN, true],
  ["Vital Knowledge", DAWN.toLowerCase(), true],
  ...NOT_DAWN.map((s): [string, string, boolean] => ["Vital Knowledge", s, false]),
  ["TMT Breakout", "Control sender", true],
  ["The Diff", "Control sender", true],
  ["Semi Doped Extra", "Name must match whole", true],
];

describe("shouldSummarizeArticle", () => {
  it.each(PROBES)("%s / %s -> %s", (name, subject, expected) => {
    expect(shouldSummarizeArticle(name, subject)).toBe(expected);
  });
});

function makeDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE research_sources (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, processing_prompt TEXT,
      allow_off_topic INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE research_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, source_id INTEGER NOT NULL,
      subject TEXT NOT NULL, sender TEXT NOT NULL, raw_text TEXT NOT NULL,
      received_at TEXT NOT NULL, summary TEXT, key_themes TEXT, sentiment TEXT,
      sentiment_score REAL, mentioned_symbols TEXT, portfolio_relevance TEXT,
      ai_model TEXT, processed_at TEXT,
      enrich_attempts INTEGER NOT NULL DEFAULT 0,
      is_relevant INTEGER NOT NULL DEFAULT 1,
      excluded_category TEXT, excluded_reason TEXT
    );
    CREATE TABLE research_article_securities (
      article_id INTEGER NOT NULL, security_id INTEGER NOT NULL,
      mention_context TEXT, sentiment TEXT, UNIQUE(article_id, security_id)
    );
    CREATE TABLE securities (
      id INTEGER PRIMARY KEY, symbol TEXT NOT NULL UNIQUE, name TEXT,
      security_type TEXT, underlying_symbol TEXT, expiration_date TEXT
    );
    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL, security_id INTEGER NOT NULL,
      quantity REAL NOT NULL, as_of_date TEXT NOT NULL
    );
    CREATE TABLE watchlist (
      id INTEGER PRIMARY KEY, security_id INTEGER NOT NULL, is_active INTEGER NOT NULL DEFAULT 1
    );
  `);
  return db;
}

const RESPONSE = {
  summary: "Macro context",
  key_themes: ["fed policy"],
  sentiment: "neutral",
  sentiment_score: 0,
  mentioned_symbols: [],
  portfolio_relevance: "Broad market.",
  is_portfolio_relevant: true,
};

describe("SQL twin parity", () => {
  it("agrees with the JS rule on every probe", () => {
    const db = makeDb();
    const where = summarizableArticleSql("s.name", "a.subject");
    for (const [name, subject, expected] of PROBES) {
      const row = db
        .prepare(`SELECT (${where}) AS ok FROM (SELECT ? AS name) s, (SELECT ? AS subject) a`)
        .get(name, subject) as { ok: number };
      expect(Boolean(row.ok), `${name} / ${subject}`).toBe(expected);
    }
  });
});

describe("processUnprocessedArticles queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (generateObjectForFeature as ReturnType<typeof vi.fn>).mockResolvedValue({ object: RESPONSE });
  });

  function seed(db: Database.Database) {
    const src = db.prepare(`INSERT INTO research_sources (id, name) VALUES (?, ?)`);
    src.run(1, "Semi Doped");
    src.run(2, "Bloomberg Odd Lots");
    src.run(3, "TBPN");
    src.run(4, "Vital Knowledge");
    src.run(5, "Control Source");
    const art = db.prepare(
      `INSERT INTO research_articles (source_id, subject, sender, raw_text, received_at)
       VALUES (?, ?, ?, 'long enough article body for processing', ?)`,
    );
    // Newest first in the queue; the skipped ones are the newest on purpose.
    art.run(1, "Semi episode", "Semi Doped <a@x>", "2026-11-02 12:00:00");
    art.run(1, "Semi episode 2", "Semi Doped from Semi Doped <a@x>", "2026-11-02 11:59:00");
    art.run(2, "Odd episode", "Bloomberg Odd Lots <b@x>", "2026-11-02 11:58:00");
    art.run(2, "Odd episode 2", "Bloomberg <b@x>", "2026-11-02 11:57:00");
    art.run(2, "Odd episode 3", "Someone at Bloomberg <b@x>", "2026-11-02 11:56:00");
    art.run(3, "TBPN show", "TBPN <c@x>", "2026-11-02 11:55:00");
    art.run(4, NOT_DAWN[0], "VK <d@x>", "2026-11-02 11:54:00");
    art.run(4, DAWN, "VK <d@x>", "2026-11-02 11:53:00");
    art.run(5, "Control piece", "Ctl <e@x>", "2026-11-02 11:52:00");
  }

  it("makes no model call for the three senders or non-Dawn VK, still enriches Dawn and a control", async () => {
    const db = makeDb();
    seed(db);
    await processUnprocessedArticles(db);

    const rows = db
      .prepare(`SELECT subject, processed_at, enrich_attempts FROM research_articles ORDER BY id`)
      .all() as { subject: string; processed_at: string | null; enrich_attempts: number }[];
    const processed = rows.filter((r) => r.processed_at !== null).map((r) => r.subject);
    expect(processed.sort()).toEqual([DAWN, "Control piece"].sort());
    expect(generateObjectForFeature).toHaveBeenCalledTimes(2);
    // Lapsed, not touched and not deleted.
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => r.processed_at === null).every((r) => r.enrich_attempts === 0)).toBe(true);
  });

  it("skipped rows do not crowd the 20-row window", async () => {
    const db = makeDb();
    db.prepare(`INSERT INTO research_sources (id, name) VALUES (1, 'TBPN'), (2, 'Control Source')`).run();
    const art = db.prepare(
      `INSERT INTO research_articles (source_id, subject, sender, raw_text, received_at)
       VALUES (?, ?, 'x@x', 'long enough article body for processing', ?)`,
    );
    for (let i = 0; i < 25; i++) art.run(1, `show ${i}`, `2026-11-02 12:${String(i).padStart(2, "0")}:00`);
    art.run(2, "Older control", "2026-11-01 08:00:00");
    await processUnprocessedArticles(db);
    expect(generateObjectForFeature).toHaveBeenCalledTimes(1);
    const ctl = db.prepare(`SELECT processed_at FROM research_articles WHERE subject='Older control'`).get() as {
      processed_at: string | null;
    };
    expect(ctl.processed_at).not.toBeNull();
  });
});

describe("Worker mirror", () => {
  it("is a byte-identical copy of the Mac module", () => {
    const mac = readFileSync(join(process.cwd(), "lib/gmail/enrichment-policy.ts"), "utf8");
    const worker = readFileSync(join(process.cwd(), "workers/cron/src/enrichment-policy.ts"), "utf8");
    expect(worker).toBe(mac);
  });
});
