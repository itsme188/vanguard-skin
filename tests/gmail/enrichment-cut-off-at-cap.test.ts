/**
 * A newsletter enrichment reply cut off at the output cap (2026-11-13).
 *
 * On the 5.5 generation thinking is on by default and counts against the
 * output cap, so a small cap can end the reply before (or inside) its JSON.
 * The call now asks for 16,000 tokens, and a reply that stopped at the cap is
 * never stored as a complete enrichment, even when its text happens to parse.
 * A cut-off is the provider ANSWERING about this article: it is article-level
 * (`malformed_output`), uses one of the article's attempts, and leaves the
 * article queued (processed_at NULL, no summary).
 *
 * Only the network is replaced (global fetch); the real gateway, AI SDK and
 * Anthropic provider build the error, as in
 * tests/gmail/enrichment-account-level-failure.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { processUnprocessedArticles } from "@/lib/gmail/process";
import { classifyEnrichmentError } from "@/lib/gmail/enrichment-failure";
import { AITruncatedError } from "@/lib/ai/generate";
import { anthropicMessage } from "../helpers/ai-sdk-real-errors";

const COMPLETE = JSON.stringify({
  summary: "ZZAA guided revenue higher and the desk sees room for estimates to move up.",
  key_themes: ["guidance"],
  sentiment: "bullish",
  sentiment_score: 0.5,
  mentioned_symbols: [],
  portfolio_relevance: "Relevant to your ZZAA position.",
  is_portfolio_relevant: true,
});

let reply: () => Response;
let bodies: Array<Record<string, unknown>>;
let errorLog: MockInstance<typeof console.error>;
let warnLog: MockInstance<typeof console.warn>;
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key-not-real";
  bodies = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
      return reply();
    }),
  );
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  warnLog = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  errorLog.mockRestore();
  warnLog.mockRestore();
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
});

function makeDbWithOneArticle(): { db: Database.Database; id: number } {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const sourceId = db.prepare(`INSERT INTO research_sources (name) VALUES ('ZZ Test Letter')`).run()
    .lastInsertRowid as number;
  const id = db
    .prepare(
      `INSERT INTO research_articles (source_id, gmail_message_id, subject, sender, raw_text, received_at)
       VALUES (?, 'cutoff-msg-1', 'ZZ letter cut', 'letters@example.test', 'ZZAA raised its outlook.', '2026-01-05 10:00:00')`,
    )
    .run(sourceId).lastInsertRowid as number;
  return { db, id };
}

function row(db: Database.Database, id: number) {
  return db
    .prepare(`SELECT enrich_attempts, processed_at, summary, excluded_category FROM research_articles WHERE id = ?`)
    .get(id) as { enrich_attempts: number; processed_at: string | null; summary: string | null; excluded_category: string | null };
}

describe("newsletterProcessing: a reply cut off at the output cap", () => {
  it("asks for an output cap with room for default-on thinking", async () => {
    reply = () => anthropicMessage(COMPLETE);
    const { db } = makeDbWithOneArticle();
    await processUnprocessedArticles(db);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].max_tokens).toBeGreaterThanOrEqual(16_000);
  });

  it("never stores a reply that stopped at the cap, even when its text parses", async () => {
    reply = () => anthropicMessage(COMPLETE, "max_tokens");
    const { db, id } = makeDbWithOneArticle();
    const result = await processUnprocessedArticles(db);
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(1);
    const r = row(db, id);
    expect(r.summary).toBeNull();
    expect(r.processed_at).toBeNull();
    expect(r.enrich_attempts).toBe(1);
  });

  it("a reply cut inside its JSON uses one attempt and leaves the article queued", async () => {
    reply = () => anthropicMessage(COMPLETE.slice(0, 60), "max_tokens");
    const { db, id } = makeDbWithOneArticle();
    await processUnprocessedArticles(db);
    const r = row(db, id);
    expect(r.summary).toBeNull();
    expect(r.processed_at).toBeNull();
    expect(r.enrich_attempts).toBe(1);
  });

  it("a reply that spent the whole cap thinking (no text) is article-level, not an outage", async () => {
    reply = () => anthropicMessage(null, "max_tokens");
    const { db, id } = makeDbWithOneArticle();
    const result = await processUnprocessedArticles(db);
    expect(result.deferred).toBe(0);
    expect(row(db, id).enrich_attempts).toBe(1);
  });

  it("classifies the gateway's truncation error as malformed output (article-level)", () => {
    const c = classifyEnrichmentError(new AITruncatedError("newsletterProcessing", "claude-test"));
    expect(c).toMatchObject({ scope: "article", kind: "malformed_output" });
  });
});
