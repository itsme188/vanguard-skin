import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getNewsletterContext } from "@/lib/digest/send-earnings-email";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // Clear seeded sources (migration 019 + 068 rank stamps) to isolate test data
  db.prepare("DELETE FROM research_sources").run();
});

function seedSource(name: string, rank: number | null, note: string | null = null): number {
  const res = db
    .prepare(
      "INSERT INTO research_sources (name, sender_email, is_active, earnings_rank, earnings_note) VALUES (?, ?, 1, ?, ?)"
    )
    .run(name, `${name.toLowerCase().replace(/[^a-z]/g, "")}@example.com`, rank, note);
  return res.lastInsertRowid as number;
}

function seedSecurity(symbol: string): number {
  const res = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, `${symbol} Corp`);
  return res.lastInsertRowid as number;
}

/** receivedAt: full ISO or SQLite 'YYYY-MM-DD HH:MM:SS' (UTC). */
function seedArticle(
  sourceId: number,
  securityId: number,
  subject: string,
  receivedAt: string,
  body = "Article body long enough to matter."
): number {
  const res = db
    .prepare(
      `INSERT INTO research_articles
         (source_id, subject, sender, received_at, raw_text, summary, sentiment, sentiment_score, processed_at)
       VALUES (?, ?, 'x@example.com', ?, ?, 'Summary', 'neutral', 0.1, datetime('now'))`
    )
    .run(sourceId, subject, receivedAt, body);
  const articleId = res.lastInsertRowid as number;
  db.prepare(
    "INSERT INTO research_article_securities (article_id, security_id) VALUES (?, ?)"
  ).run(articleId, securityId);
  return articleId;
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}
function daysAgo(d: number): string {
  return hoursAgo(d * 24);
}

describe("getNewsletterContext — rank-ordered fill", () => {
  it("admits fresh unranked articles alongside stale ranked ones (starvation fix)", () => {
    const sec = seedSecurity("AAPL");
    const ranked = seedSource("Ranked Letter", 1);
    const unranked = seedSource("Fresh Substack", null);
    seedArticle(ranked, sec, "Old preferred mention", daysAgo(6));
    seedArticle(unranked, sec, "Fresh detailed preview", hoursAgo(2));

    const result = getNewsletterContext(db, ["AAPL"]);
    const names = result.map((r) => r.source_name);
    expect(names).toContain("Ranked Letter");
    expect(names).toContain("Fresh Substack");
    // Ranked source comes first despite being older.
    expect(names[0]).toBe("Ranked Letter");
  });

  it("orders ranked sources by rank, then unranked, recency desc within", () => {
    const sec = seedSecurity("NVDA");
    const r2 = seedSource("Rank Two", 2);
    const r1 = seedSource("Rank One", 1);
    const un = seedSource("Pool Letter", null);
    seedArticle(un, sec, "Pool note", hoursAgo(1));
    seedArticle(r2, sec, "Second trust", hoursAgo(3));
    seedArticle(r1, sec, "Top trust older", hoursAgo(30));
    seedArticle(r1, sec, "Top trust newer", hoursAgo(4));

    const result = getNewsletterContext(db, ["NVDA"]);
    expect(result.map((r) => r.subject)).toEqual([
      "Top trust newer",
      "Top trust older",
      "Second trust",
      "Pool note",
    ]);
  });

  it("drops same-day superseded editions (VK Dawn dies to the Mid-Day Update)", () => {
    const sec = seedSecurity("MSFT");
    // classifyEdition keys on the exact source name "Vital Knowledge".
    const vk = seedSource("Vital Knowledge", 1);
    // Same ET day: use two timestamps a few hours apart mid-day UTC.
    const base = new Date();
    base.setUTCHours(12, 0, 0, 0); // 08:00 ET — same ET day for both
    const dawnAt = new Date(base.getTime() - 2 * 3600_000).toISOString();
    const middayAt = base.toISOString();
    seedArticle(vk, sec, "Vital Dawn — early look", dawnAt);
    seedArticle(vk, sec, "Mid-Day Market Update", middayAt);

    const result = getNewsletterContext(db, ["MSFT"]);
    const subjects = result.map((r) => r.subject);
    expect(subjects).toContain("Mid-Day Market Update");
    expect(subjects).not.toContain("Vital Dawn — early look");
  });

  it("falls back to 30 days only when the 7-day window is empty", () => {
    const sec = seedSecurity("TSM");
    const src = seedSource("Ranked Letter", 1);
    seedArticle(src, sec, "Two weeks old", daysAgo(14));
    const result = getNewsletterContext(db, ["TSM"]);
    expect(result.map((r) => r.subject)).toEqual(["Two weeks old"]);
  });

  it("caps at 6 articles, ranked sources winning the slots", () => {
    const sec = seedSecurity("AMD");
    const r1 = seedSource("Rank One", 1);
    const un = seedSource("Pool Letter", null);
    for (let i = 0; i < 5; i++) seedArticle(r1, sec, `Ranked ${i}`, hoursAgo(i + 1));
    for (let i = 0; i < 5; i++) seedArticle(un, sec, `Pool ${i}`, hoursAgo(i + 1));

    const result = getNewsletterContext(db, ["AMD"]);
    expect(result).toHaveLength(6);
    expect(result.filter((r) => r.source_name === "Rank One")).toHaveLength(5);
    expect(result.filter((r) => r.source_name === "Pool Letter")).toHaveLength(1);
  });

  it("carries earnings_note + earnings_rank onto entries", () => {
    const sec = seedSecurity("GOOG");
    const src = seedSource("TMT Breakout", 2, "Bogies tables — quote exact numbers.");
    seedArticle(src, sec, "Morning Wrap", hoursAgo(2));
    const [entry] = getNewsletterContext(db, ["GOOG"]);
    expect(entry.earnings_rank).toBe(2);
    expect(entry.earnings_note).toBe("Bogies tables — quote exact numbers.");
  });

  it("returns [] for an empty family", () => {
    expect(getNewsletterContext(db, [])).toEqual([]);
  });
});
