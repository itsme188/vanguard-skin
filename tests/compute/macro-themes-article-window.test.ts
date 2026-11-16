import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { buildMacroSignalBlob } from "@/lib/compute/macro-themes";

// Review round 5 (2026-11-15), R9: the article read had no upper bound and a
// LIMIT applied BEFORE the held-relevance ranking (buildMacroPromptInputs),
// so the oldest articles of a busy week were dropped unseen and a past
// week's regeneration read articles dated after that week. weekOf is the
// Monday that opens the cache week (currentThemeWeek / the briefing's
// upcoming Monday); the window now ends where week W ends.

const W = "2026-05-04"; // a Monday

function seed(n: number): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  db.prepare("INSERT OR IGNORE INTO research_sources (id, name, sender_email, is_active) VALUES (1, 'T', 't@t.com', 1)").run();
  const ins = db.prepare(
    `INSERT INTO research_articles (id, source_id, subject, sender, raw_text, received_at, processed_at, sentiment, mentioned_symbols, is_relevant)
     VALUES (?, 1, ?, 't@t.com', 'body', ?, datetime('now'), 'neutral', '[]', 1)`
  );
  // n articles spread over the 7 days before W, oldest first.
  for (let i = 0; i < n; i++) {
    const t = new Date(Date.parse(`${W}T00:00:00Z`) - 7 * 86_400_000 + Math.floor((i * 7 * 86_400_000) / n) + 1000);
    ins.run(i + 1, `In-window ${i}`, t.toISOString().replace("T", " ").slice(0, 19));
  }
  return db;
}

describe("buildMacroSignalBlob article window (R9)", () => {
  it("a busy week (more than 200 articles) is read whole, so the ranking sees the oldest too", () => {
    const db = seed(260);
    const blob = buildMacroSignalBlob(db, "all", W);
    expect(blob.articleCount).toBe(260);
    expect(blob.articles.map((a) => a.id)).toContain(1); // the oldest
  });

  it("an article dated after week W ends is never read for week W", () => {
    const db = seed(3);
    const after = new Date(Date.parse(`${W}T00:00:00Z`) + 7 * 86_400_000 + 3600_000).toISOString().replace("T", " ").slice(0, 19);
    db.prepare(
      `INSERT INTO research_articles (id, source_id, subject, sender, raw_text, received_at, processed_at, sentiment, mentioned_symbols, is_relevant)
       VALUES (900, 1, 'Next week', 't@t.com', 'body', ?, datetime('now'), 'neutral', '[]', 1)`
    ).run(after);
    // An ISO 'T' timestamp just before the week ends still counts (datetime() on both sides).
    db.prepare(
      `INSERT INTO research_articles (id, source_id, subject, sender, raw_text, received_at, processed_at, sentiment, mentioned_symbols, is_relevant)
       VALUES (901, 1, 'Last hour', 't@t.com', 'body', '2026-05-10T23:30:00.000Z', datetime('now'), 'neutral', '[]', 1)`
    ).run();
    const ids = buildMacroSignalBlob(db, "all", W).articles.map((a) => a.id);
    expect(ids).not.toContain(900);
    expect(ids).toContain(901);
    expect(ids).toHaveLength(4);
  });
});
