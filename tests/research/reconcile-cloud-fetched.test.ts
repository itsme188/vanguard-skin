/**
 * Mac-side reconcile of cloud-fetched newsletter articles.
 *
 * Covers:
 *   - gmail_message_id UNIQUE dedup (INSERT OR IGNORE swallows a duplicate
 *     even if Mac fetched the same message during the asleep-wake gap)
 *   - D3 gate application using local research_sources.allow_off_topic
 *   - source-missing path (Worker had an old snapshot)
 *   - link symbol → security via mentioned_symbols
 *   - DELETE-on-success against the Worker (idempotency)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { reconcileCloudFetchedNewsletters } from "@/lib/research/reconcile-cloud-fetched";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE research_sources (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      allow_off_topic INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE research_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      gmail_message_id TEXT UNIQUE,
      gmail_thread_id TEXT,
      received_at TEXT NOT NULL,
      subject TEXT NOT NULL,
      sender TEXT NOT NULL,
      raw_text TEXT,
      raw_html TEXT,
      source_url TEXT,
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
    CREATE TABLE securities (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, name TEXT, security_type TEXT);
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
  db.prepare(`INSERT INTO research_sources (id, name, allow_off_topic) VALUES (1, 'Strict', 0)`).run();
  db.prepare(`INSERT INTO research_sources (id, name, allow_off_topic) VALUES (2, 'Loose', 1)`).run();
  db.prepare(`INSERT INTO securities (id, symbol, name) VALUES (1, 'AAPL', 'Apple')`).run();
  // Held stock for the subject-line backstop tests below (id 2, "U").
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type) VALUES (2, 'U', 'Unity Software', 'Stock')`,
  ).run();
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (1, 2, 100, '2026-08-01')`,
  ).run();
  return db;
}

const BASE_PAYLOAD = {
  source_id: 1,
  source_name: "Strict",
  gmail_message_id: "m1",
  received_at: "2026-05-11 10:00:00",
  subject: "Today's macro view",
  sender: "feed@example.com",
  raw_text: "body",
  raw_html: null,
  summary: "Macro analysis",
  key_themes: ["fed"],
  sentiment: "bearish" as const,
  sentiment_score: -0.2,
  mentioned_symbols: ["AAPL"],
  portfolio_relevance: "Direct AAPL exposure",
  is_portfolio_relevant: true,
  ai_model: "cloud-fallback",
  fetched_by: "cloud" as const,
  fetched_at: "2026-05-11T10:05:00Z",
};

interface MockResponses {
  list?: Record<string, typeof BASE_PAYLOAD>;
}

function mockWorker(responses: MockResponses) {
  const calls: { method: string; url: string }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, url: typeof url === "string" ? url : String(url) });
    if (method === "GET") {
      return new Response(JSON.stringify({ payloads: responses.list ?? {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "DELETE") {
      return new Response("{}", { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { calls };
}

beforeEach(() => {
  process.env.WORKER_MARKER_URL = "https://worker.example.com";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reconcileCloudFetchedNewsletters", () => {
  it("returns no-op note when WORKER_MARKER_URL is unset", async () => {
    delete process.env.WORKER_MARKER_URL;
    const db = makeDb();
    const result = await reconcileCloudFetchedNewsletters(db, "secret");
    expect(result.note).toContain("WORKER_MARKER_URL unset");
  });

  it("inserts a new article with processed_at populated", async () => {
    const db = makeDb();
    mockWorker({ list: { m1: BASE_PAYLOAD } });

    const result = await reconcileCloudFetchedNewsletters(db, "secret");

    expect(result.reconciled).toBe(1);
    const row = db.prepare(`SELECT * FROM research_articles WHERE gmail_message_id = 'm1'`).get() as any;
    expect(row).toBeTruthy();
    expect(row.summary).toBe("Macro analysis");
    expect(row.processed_at).not.toBeNull();
    expect(row.is_relevant).toBe(1);
  });

  it("sanitizes tag-contaminated key_themes before storing", async () => {
    const db = makeDb();
    mockWorker({
      list: {
        m1: {
          ...BASE_PAYLOAD,
          key_themes: ['<parameter name="key_themes">["fed policy"', "tech earnings"],
        },
      },
    });

    const result = await reconcileCloudFetchedNewsletters(db, "secret");

    expect(result.reconciled).toBe(1);
    const row = db.prepare(`SELECT key_themes FROM research_articles WHERE gmail_message_id = 'm1'`).get() as any;
    expect(JSON.parse(row.key_themes)).toEqual(["fed policy", "tech earnings"]);
  });

  it("applies the D3 gate when is_portfolio_relevant=false and source.allow_off_topic=0", async () => {
    const db = makeDb();
    mockWorker({
      list: {
        m1: { ...BASE_PAYLOAD, source_id: 1, is_portfolio_relevant: false, portfolio_relevance: "No portfolio link" },
      },
    });

    await reconcileCloudFetchedNewsletters(db, "secret");

    const row = db.prepare(`SELECT is_relevant, excluded_category, excluded_reason FROM research_articles WHERE gmail_message_id = 'm1'`).get() as {
      is_relevant: number;
      excluded_category: string | null;
      excluded_reason: string | null;
    };
    expect(row.is_relevant).toBe(0);
    expect(row.excluded_category).toBe("off_topic");
    expect(row.excluded_reason).toBe("No portfolio link");
  });

  it("respects allow_off_topic=1 on the source (no flip even if Claude voted false)", async () => {
    const db = makeDb();
    mockWorker({
      list: {
        m1: { ...BASE_PAYLOAD, source_id: 2, is_portfolio_relevant: false },
      },
    });

    await reconcileCloudFetchedNewsletters(db, "secret");

    const row = db.prepare(`SELECT is_relevant, excluded_category FROM research_articles WHERE gmail_message_id = 'm1'`).get() as {
      is_relevant: number;
      excluded_category: string | null;
    };
    expect(row.is_relevant).toBe(1);
    expect(row.excluded_category).toBeNull();
  });

  it("dedups via INSERT OR IGNORE when gmail_message_id already exists locally", async () => {
    const db = makeDb();
    // Mac already fetched this message between Worker write and Mac wake.
    db.prepare(
      `INSERT INTO research_articles (source_id, gmail_message_id, received_at, subject, sender, raw_text, processed_at)
       VALUES (1, 'm1', '2026-05-11 09:00:00', 'Local copy', 'x@x', 'body', '2026-05-11 09:30:00')`,
    ).run();

    mockWorker({ list: { m1: BASE_PAYLOAD } });

    const result = await reconcileCloudFetchedNewsletters(db, "secret");

    expect(result.skipped_already_in_db).toBe(1);
    expect(result.reconciled).toBe(0);
    const subjectRow = db.prepare(`SELECT subject FROM research_articles WHERE gmail_message_id = 'm1'`).get() as { subject: string };
    expect(subjectRow.subject).toBe("Local copy");
  });

  it("skips when the source_id is unknown locally (Worker had stale snapshot)", async () => {
    const db = makeDb();
    mockWorker({
      list: {
        m1: { ...BASE_PAYLOAD, source_id: 999 },
      },
    });

    const result = await reconcileCloudFetchedNewsletters(db, "secret");

    expect(result.skipped_source_missing).toBe(1);
    expect(result.reconciled).toBe(0);
    const row = db.prepare(`SELECT * FROM research_articles WHERE gmail_message_id = 'm1'`).get();
    expect(row).toBeUndefined();
  });

  it("links mentioned symbols → security_id rows", async () => {
    const db = makeDb();
    mockWorker({ list: { m1: BASE_PAYLOAD } });

    await reconcileCloudFetchedNewsletters(db, "secret");

    const links = db.prepare(`SELECT security_id FROM research_article_securities`).all() as { security_id: number }[];
    expect(links).toHaveLength(1);
    expect(links[0].security_id).toBe(1);
  });

  it("subject-line backstop: unions a held ticker the Worker's extraction dropped, and links it", async () => {
    const db = makeDb();
    mockWorker({
      list: {
        m1: {
          ...BASE_PAYLOAD,
          subject: "Review|APP & U 2Q26: D28 IAA Is Now the Core Battleground",
          mentioned_symbols: ["APP"], // Worker's Claude call dropped "U" — same live bug
        },
      },
    });

    await reconcileCloudFetchedNewsletters(db, "secret");

    const row = db
      .prepare(`SELECT mentioned_symbols FROM research_articles WHERE gmail_message_id = 'm1'`)
      .get() as { mentioned_symbols: string };
    const symbols = JSON.parse(row.mentioned_symbols) as string[];
    expect(symbols).toContain("U");
    expect(symbols).toContain("APP");

    const link = db
      .prepare(`SELECT security_id FROM research_article_securities WHERE security_id = 2`)
      .get();
    expect(link).toBeTruthy();
  });

  it("DELETEs the worker KV entry after a successful insert", async () => {
    const db = makeDb();
    const { calls } = mockWorker({ list: { m1: BASE_PAYLOAD } });

    await reconcileCloudFetchedNewsletters(db, "secret");

    const deletes = calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0].url).toContain("messageId=m1");
  });

  it("returns ok=true with empty payloads when Worker has nothing", async () => {
    const db = makeDb();
    mockWorker({ list: {} });

    const result = await reconcileCloudFetchedNewsletters(db, "secret");

    expect(result).toMatchObject({ ok: true, reconciled: 0, skipped_already_in_db: 0, skipped_source_missing: 0 });
  });
});
