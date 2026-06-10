import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";

vi.mock("@/lib/digest/synthesize", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/digest/synthesize")>();
  return {
    ...mod,
    synthesize: vi.fn(async (input: { sessionHeading?: string }) =>
      [
        `## ${input.sessionHeading ?? "The Session"}`,
        "Macro narrative.",
        "## NVDA (NVIDIA Corp)",
        "NVDA coverage.",
        "## Also covered",
        "Tail.",
      ].join("\n"),
    ),
  };
});
vi.mock("@/lib/digest/anomalies", () => ({
  computeAnomalies: vi.fn(() => []),
  formatVanguardAnomaliesBlock: vi.fn(() => ""),
}));

import { generateDigestSinceAdaptive } from "@/lib/digest/daily-digest";
import { synthesize } from "@/lib/digest/synthesize";

function setupDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE research_sources (id INTEGER PRIMARY KEY, name TEXT, website_url TEXT);
    CREATE TABLE research_articles (
      id INTEGER PRIMARY KEY, source_id INTEGER, gmail_message_id TEXT,
      received_at TEXT, subject TEXT, sender TEXT, summary TEXT, key_themes TEXT,
      sentiment TEXT, sentiment_score REAL, mentioned_symbols TEXT,
      portfolio_relevance TEXT, processed_at TEXT, created_at TEXT,
      source_url TEXT, is_relevant INTEGER DEFAULT 1
    );
    CREATE TABLE level_alerts (id INTEGER PRIMARY KEY, level_id INTEGER, security_id INTEGER,
      triggered_at TEXT, triggered_price REAL, user_response TEXT, suggested_action TEXT);
    CREATE TABLE security_levels (id INTEGER PRIMARY KEY, level_type TEXT, price REAL,
      price_source TEXT, source_author TEXT);
    CREATE TABLE securities (id INTEGER PRIMARY KEY, symbol TEXT, name TEXT, security_type TEXT);
    CREATE TABLE holdings (id INTEGER PRIMARY KEY, security_id INTEGER, quantity REAL);
    CREATE TABLE watchlist (id INTEGER PRIMARY KEY, security_id INTEGER, is_active INTEGER);
  `);
  db.prepare(`INSERT INTO research_sources (id, name) VALUES (1,'Vital Knowledge'),(2,'MBI Deep Dives'),(3,'TMT Breakout')`).run();
  // Seed NVDA into watchlist so insertCrossFilePointers can cross-file essay
  // pointers into the NVDA section produced by the synthesis mock.
  db.prepare(`INSERT INTO securities (id, symbol, name, security_type) VALUES (100, 'NVDA', 'NVIDIA Corp', 'stock')`).run();
  db.prepare(`INSERT INTO watchlist (id, security_id, is_active) VALUES (1, 100, 1)`).run();
  return db;
}

let seq = 0;
function insertArticle(db: Database.Database, sourceId: number, subject: string, receivedAt: string, symbols = '["NVDA"]') {
  seq += 1;
  db.prepare(
    `INSERT INTO research_articles (source_id, gmail_message_id, received_at, subject, summary,
       mentioned_symbols, sentiment, processed_at, created_at, is_relevant)
     VALUES (?, ?, ?, ?, 'Summary.', ?, 'neutral', datetime('now'), datetime('now'), 1)`,
  ).run(sourceId, `m${seq}`, receivedAt, subject, symbols);
}

const SINCE = "2026-06-09T12:45:00.000Z";

function insertFiveCommentary(db: Database.Database) {
  insertArticle(db, 1, "Vital Knowledge: Vital Dawn for Tuesday June 9, 2026", "2026-06-09 14:00:00");
  insertArticle(db, 1, "Vital Knowledge: Vital Mid-Day Market Update for Tuesday June 9, 2026", "2026-06-09 15:00:00");
  insertArticle(db, 1, "Vital Knowledge: Vital Market Recap for Tuesday June 9, 2026", "2026-06-09 20:04:00");
  insertArticle(db, 3, "TMTB EOD Wrap", "2026-06-09 21:30:00");
  insertArticle(db, 1, "Vital Knowledge: Iran & tech: thoughts", "2026-06-09 17:30:00");
}

describe("generateDigestSinceAdaptive — structured composer", () => {
  beforeEach(() => {
    vi.mocked(synthesize).mockClear();
  });

  it("evening edition: title, section order, Research Desk after AI body", async () => {
    const db = setupDb();
    insertFiveCommentary(db);
    insertArticle(db, 2, "NVDA's networking moat", "2026-06-09 16:00:00"); // essay

    const md = await generateDigestSinceAdaptive(db, SINCE, { includeAnomalies: true, edition: "evening" });
    expect(md).not.toBeNull();
    expect(md!).toContain("# Evening Recap");
    expect(md!).toContain("## The Session");
    expect(md!).toContain("## Research Desk");
    expect(md!.indexOf("## The Session")).toBeLessThan(md!.indexOf("## Research Desk"));
    // essay cross-filed into the NVDA section
    expect(md!).toContain("Deep dive today");
    // essays excluded from the synthesis input
    const input = vi.mocked(synthesize).mock.calls[0][0] as import("@/lib/digest/synthesize").SynthesisInput;
    const bucketSources = input.buckets.flatMap((b) => b.articles.map((a) => a.source_name));
    expect(bucketSources).not.toContain("MBI Deep Dives");
  });

  it("morning edition: title + Overnight & Setup heading passed to synthesize", async () => {
    const db = setupDb();
    insertFiveCommentary(db);
    const md = await generateDigestSinceAdaptive(db, SINCE, { edition: "morning" });
    expect(md!).toContain("# Morning Research Digest");
    const input = vi.mocked(synthesize).mock.calls[0][0] as import("@/lib/digest/synthesize").SynthesisInput;
    expect(input.sessionHeading).toBe("Overnight & Setup");
  });

  it("late arrivals lead the email and are excluded from synthesis", async () => {
    const db = setupDb();
    insertFiveCommentary(db);
    insertArticle(db, 3, "TMTB Morning Wrap", "2026-06-09 12:48:00"); // 3 min after send → late
    const md = await generateDigestSinceAdaptive(db, SINCE, { edition: "evening" });
    expect(md!).toContain("## ⏰ Late arrivals");
    expect(md!.indexOf("## ⏰ Late arrivals")).toBeLessThan(md!.indexOf("## The Session"));
    const input = vi.mocked(synthesize).mock.calls[0][0] as import("@/lib/digest/synthesize").SynthesisInput;
    const subjects = input.buckets.flatMap((b) => b.articles.map((a) => a.subject));
    expect(subjects).not.toContain("TMTB Morning Wrap");
  });

  it("<5 commentary articles → per-source fallback for commentary, Research Desk still renders", async () => {
    const db = setupDb();
    insertArticle(db, 1, "Vital Knowledge: Vital Dawn for Tuesday June 9, 2026", "2026-06-09 14:00:00");
    insertArticle(db, 2, "NVDA's networking moat", "2026-06-09 16:00:00");
    const md = await generateDigestSinceAdaptive(db, SINCE, { edition: "morning" });
    expect(vi.mocked(synthesize)).not.toHaveBeenCalled();
    expect(md!).toContain("## VITAL KNOWLEDGE"); // per-source fallback header
    expect(md!).toContain("## Research Desk");
  });

  it("essay-only window still produces an email (no synthesis)", async () => {
    const db = setupDb();
    insertArticle(db, 2, "NVDA's networking moat", "2026-06-09 16:00:00");
    const md = await generateDigestSinceAdaptive(db, SINCE, { edition: "evening" });
    expect(vi.mocked(synthesize)).not.toHaveBeenCalled();
    expect(md!).toContain("## Research Desk");
  });
});
