/**
 * B26 (Portfolio Assistant plan, Task 5): a mangled JSON column in one
 * research row made JSON.parse throw and the WHOLE tool call came back as an
 * error. Now one bad field becomes an empty list for that field on that row;
 * every other row and field is returned. A valid JSON value that is not a
 * list (for example an object) is also read as an empty list.
 *
 * Protects: one bad row cannot hide every other research result. Bound: all
 * rows returned; only the bad fields are empty.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool } from "@/lib/chat/tools";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const doc = db.prepare(
    `INSERT INTO research_documents (title, filename, raw_text, summary, key_points, mentioned_symbols, tags)
     VALUES (?, ?, ?, 'summary', ?, ?, ?)`,
  );
  doc.run("Good note", "good.pdf", "zqword body", '["point one"]', '["ZQG"]', '["semis"]');
  doc.run("Bad note", "bad.pdf", "zqword body", "<key_points>broken", '{"not":"a list"}', "semis, [broken");
  const art = db.prepare(
    `INSERT INTO research_articles (source_id, received_at, subject, sender, raw_text, mentioned_symbols, processed_at)
     VALUES (1, datetime('now', '-1 day'), ?, 'feed@example.com', 'body', ?, datetime('now', '-1 day', '+5 minutes'))`,
  );
  art.run("Good article", '["ZQG"]');
  art.run("Bad article", "ZQG, [oops");
});

describe("tolerant parse of research JSON fields", () => {
  it("query_research_documents returns both rows; the bad fields are empty lists", async () => {
    const r = (await executeTool(db, "query_research_documents", { query: "zqword" })) as {
      error?: string;
      data: { documents: Array<{ title: string; mentioned_symbols: unknown; tags: unknown; key_points: unknown }> };
    };
    expect(r.error).toBeUndefined();
    const byTitle = Object.fromEntries(r.data.documents.map((d) => [d.title, d]));
    expect(byTitle["Good note"]).toMatchObject({ mentioned_symbols: ["ZQG"], tags: ["semis"], key_points: ["point one"] });
    expect(byTitle["Bad note"]).toMatchObject({ mentioned_symbols: [], tags: [], key_points: [] });
  });

  it("query_research_feeds returns both rows; the bad tickers field is an empty list", async () => {
    const r = (await executeTool(db, "query_research_feeds", {})) as {
      error?: string;
      data: { articles: Array<{ subject: string; tickers: unknown }> };
    };
    expect(r.error).toBeUndefined();
    const bySubject = Object.fromEntries(r.data.articles.map((a) => [a.subject, a]));
    expect(bySubject["Good article"].tickers).toEqual(["ZQG"]);
    expect(bySubject["Bad article"].tickers).toEqual([]);
  });
});
