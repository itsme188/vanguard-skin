/**
 * QA-10 (Portfolio Assistant plan, Task 5): a filter the dispatcher cannot
 * resolve is an error the model can act on, never a silently dropped filter.
 *
 * Before the fix, a `symbol` with no `securities` row left the security id
 * undefined, so query_notes / query_levels / query_alerts / query_research_feeds
 * returned EVERY name's rows as if they were the asked-about name's. The
 * research-feeds `source` lookup took the first of several LIKE matches and
 * dropped the filter on none.
 *
 * Protects: the model never receives another name's notes, levels, alerts or
 * articles for a filter it asked about. Bound: zero rows of another name.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool, CHAT_TOOLS } from "@/lib/chat/tools";

let db: Database.Database;
let secId: number;

type Wrapped = { error?: string; data?: Record<string, unknown> };

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  secId = db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES ('ZZQA', 'ZZQA Corp', 'stock', 'USD')")
    .run().lastInsertRowid as number;
  // One row of each kind for ZZQA, so a dropped filter would return it.
  db.prepare(
    "INSERT INTO notes (note_type, content, security_id, event_date) VALUES ('journal', 'about ZZQA', ?, '2026-11-01')",
  ).run(secId);
  const levelId = db
    .prepare(
      "INSERT INTO security_levels (security_id, level_type, price, review_status) VALUES (?, 'support', 10, 'auto_approved')",
    )
    .run(secId).lastInsertRowid as number;
  db.prepare(
    "INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price) VALUES (?, ?, datetime('now', '-1 day'), 9.5)",
  ).run(levelId, secId);
  db.prepare(
    `INSERT INTO research_articles (source_id, received_at, subject, sender, raw_text, mentioned_symbols, processed_at)
     VALUES (1, datetime('now', '-1 day'), 'Note on ZZQA', 'feed@example.com', 'body', '["ZZQA"]', datetime('now', '-1 day', '+5 minutes'))`,
  ).run();
});

const NO_SUCH = "No security 'ZZZZ' on file. Nothing was filtered or returned.";

describe("a symbol with no securities row is an error, never a dropped filter", () => {
  for (const tool of ["query_notes", "query_levels", "query_alerts", "query_research_feeds"]) {
    it(`${tool} answers with the no-security error`, async () => {
      const r = (await executeTool(db, tool, { symbol: "ZZZZ" })) as Wrapped;
      expect(r.error).toBe(NO_SUCH);
      expect(r.data).toBeUndefined();
    });

    it(`${tool} still finds a known symbol written in lower case`, async () => {
      const r = (await executeTool(db, tool, { symbol: "zzqa" })) as Wrapped;
      expect(r.error).toBeUndefined();
      expect(r.data).toBeDefined();
    });
  }
});

describe("query_research_feeds source resolves to exactly one source", () => {
  it("a unique case-insensitive substring selects that source", async () => {
    const r = (await executeTool(db, "query_research_feeds", { source: "vital" })) as Wrapped;
    expect(r.error).toBeUndefined();
    expect((r.data as { count: number }).count).toBe(1);
  });

  it("no match is an error naming every source", async () => {
    const r = (await executeTool(db, "query_research_feeds", { source: "Nonexistent Letter" })) as Wrapped;
    expect(r.error).toMatch(/No research source matches "Nonexistent Letter"/);
    for (const name of ["Vital Knowledge", "TMT Breakouts", "Morning Recap", "Afternoon Recap", "Stratechery", "The Diff"]) {
      expect(r.error).toContain(name);
    }
  });

  it("several matches is an error naming every source, never the first match", async () => {
    // Migration 019 seeds "Morning Recap" and "Afternoon Recap".
    const r = (await executeTool(db, "query_research_feeds", { source: "recap" })) as Wrapped;
    expect(r.error).toMatch(/matches 2 research sources/);
    expect(r.error).toContain("Morning Recap");
    expect(r.error).toContain("Afternoon Recap");
    expect(r.data).toBeUndefined();
  });
});

describe("descriptions", () => {
  it("names the Eliant newsletter correctly", () => {
    const tool = CHAT_TOOLS.find((t) => t.name === "query_research_feeds")!;
    expect(tool.description).toContain("Eliant Capital");
    expect(tool.description).not.toContain("Alliant");
  });
});
