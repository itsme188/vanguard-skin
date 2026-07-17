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

  it("caps at 4 articles under the per-source diversity cap (2 ranked + 2 pool)", () => {
    // Pre-amendment this asserted 5 ranked + 1 pool (single fill loop, no
    // per-source cap). Post-amendment (2026-07-17): pass 1 walks the
    // trust-ordered rows and admits at most MAX_ARTICLES_PER_SOURCE (2)
    // from each of Rank One and Pool Letter — Ranked 0/1 and Pool 0/1 —
    // then skips every further row from either (both already at cap), so
    // pass 1 ends at 4 selected. Pass 2 only refills when the symbol's
    // WHOLE candidate pool is a single source (see the constant comment);
    // here there are 2 distinct sources, so pass 2 is a no-op and the
    // remaining 3 Ranked + 3 Pool rows stay unselected rather than
    // re-inflating either source past its cap. 4 total, not 6.
    const sec = seedSecurity("AMD");
    const r1 = seedSource("Rank One", 1);
    const un = seedSource("Pool Letter", null);
    for (let i = 0; i < 5; i++) seedArticle(r1, sec, `Ranked ${i}`, hoursAgo(i + 1));
    for (let i = 0; i < 5; i++) seedArticle(un, sec, `Pool ${i}`, hoursAgo(i + 1));

    const result = getNewsletterContext(db, ["AMD"]);
    expect(result).toHaveLength(4);
    expect(result.filter((r) => r.source_name === "Rank One")).toHaveLength(2);
    expect(result.filter((r) => r.source_name === "Pool Letter")).toHaveLength(2);
  });

  it("caps a prolific source so lower-ranked sources still get slots", () => {
    const sec = seedSecurity("META");
    const vk = seedSource("Rank One Daily", 1);
    const tmt = seedSource("Rank Two Bogies", 2, "Bogies tables.");
    for (let i = 0; i < 6; i++) seedArticle(vk, sec, `Daily ${i}`, hoursAgo(i * 5 + 1));
    seedArticle(tmt, sec, "Bogies preview", hoursAgo(30));

    const result = getNewsletterContext(db, ["META"]);
    expect(result.filter((r) => r.source_name === "Rank One Daily")).toHaveLength(2);
    expect(result.map((r) => r.source_name)).toContain("Rank Two Bogies");
    // Trust order preserved: all Rank One entries before Rank Two.
    const names = result.map((r) => r.source_name);
    expect(names.lastIndexOf("Rank One Daily")).toBeLessThan(names.indexOf("Rank Two Bogies"));
  });

  it("refills past the per-source cap when only one source covers the symbol", () => {
    const sec = seedSecurity("CROX");
    const only = seedSource("Only Letter", 1);
    for (let i = 0; i < 6; i++) seedArticle(only, sec, `Solo ${i}`, hoursAgo(i + 1));
    const result = getNewsletterContext(db, ["CROX"]);
    expect(result).toHaveLength(6);
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

  it("a flood of recent unranked articles cannot evict a ranked source's older in-window article", () => {
    const sec = seedSecurity("PLTR");
    const ranked = seedSource("Ranked Letter", 1);
    const flood = seedSource("Flood Letter", null);
    seedArticle(ranked, sec, "Ranked but older", daysAgo(6));
    for (let i = 0; i < 35; i++) {
      seedArticle(flood, sec, `Flood ${i}`, hoursAgo(i + 1));
    }
    const result = getNewsletterContext(db, ["PLTR"]);
    expect(result.map((r) => r.source_name)).toContain("Ranked Letter");
    expect(result[0].source_name).toBe("Ranked Letter");
  });
});
