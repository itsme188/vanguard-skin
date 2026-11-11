/**
 * P9 / OPEN-7 (Portfolio Assistant plan, Task 5): the account scope applies to
 * private text, not only to tools that take `account_name`.
 *
 * In a single-account chat the route passes the scope's id list as
 * `opts.scopeAccountIds` (Contract H). Then:
 *  - query_notes withholds a note linked to ANOTHER account's transaction
 *    (and so never shows that transaction's type or date); unlinked notes
 *    (the owner's journal, not account data) and notes on an in-scope
 *    transaction are returned;
 *  - query_earnings_transcript's user_notes follow the same rule;
 *  - fields that are built from the whole book and cannot be scoped to one
 *    account are withheld with a note (OPEN-7 default): a research article's
 *    portfolio_relevance, an alert's suggested_action, a weekly briefing's
 *    content.
 * With no scope list (the All Accounts chat) everything is shown.
 *
 * Protects: no other account's transaction or whole-book text reaches a
 * single-account chat. Bound: zero such rows or fields.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

vi.mock("@/lib/transcripts/fetch", () => ({
  getTranscriptForChat: vi.fn(async () => ({ source: "edgar_8k", summary: "s", has_full_transcript: false })),
}));

import { runMigrations } from "@/lib/db/migrate";
import { executeTool } from "@/lib/chat/tools";

let db: Database.Database;
let secId: number;

type Note = { content: string; transaction_type: string | null; transaction_date: string | null };

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // Migration 002: 1 Vanguard Taxable, 2 Vanguard Roth IRA, 3 IBKR.
  secId = db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES ('ZQN', 'ZQN Corp', 'stock', 'USD')")
    .run().lastInsertRowid as number;
  const tx = (accountId: number, key: string) =>
    db
      .prepare(
        "INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, source_key) VALUES (?, ?, '2026-10-01', 'BUY', 1, -10, ?)",
      )
      .run(accountId, secId, key).lastInsertRowid as number;
  const ibkrTx = tx(3, "n-ibkr");
  const taxableTx = tx(1, "n-taxable");
  const note = db.prepare(
    "INSERT INTO notes (note_type, content, security_id, transaction_id, event_date) VALUES (?, ?, ?, ?, '2026-10-02')",
  );
  note.run("journal", "unlinked journal", null, null);
  note.run("earnings", "on the IBKR trade", secId, ibkrTx);
  note.run("earnings", "on the taxable trade", secId, taxableTx);
});

describe("query_notes in a single-account chat", () => {
  it("withholds a note linked to another account's transaction", async () => {
    const r = (await executeTool(db, "query_notes", {}, { scopeAccountIds: [3] })) as { data: Note[] };
    const contents = r.data.map((n) => n.content).sort();
    expect(contents).toEqual(["on the IBKR trade", "unlinked journal"]);
    expect(JSON.stringify(r.data)).not.toContain("taxable");
  });

  it("returns every note in the All Accounts chat", async () => {
    const r = (await executeTool(db, "query_notes", {})) as { data: Note[] };
    expect(r.data).toHaveLength(3);
  });
});

describe("query_earnings_transcript user_notes in a single-account chat", () => {
  it("follows the same rule", async () => {
    const r = (await executeTool(db, "query_earnings_transcript", { ticker: "ZQN" }, { scopeAccountIds: [3] })) as {
      data: { user_notes: Note[] };
    };
    expect(r.data.user_notes.map((n) => n.content)).toEqual(["on the IBKR trade"]);
  });

  it("shows both in the All Accounts chat", async () => {
    const r = (await executeTool(db, "query_earnings_transcript", { ticker: "ZQN" })) as {
      data: { user_notes: Note[] };
    };
    expect(r.data.user_notes).toHaveLength(2);
  });
});

describe("whole-book fields that cannot be scoped are withheld in a single-account chat", () => {
  beforeEach(() => {
    db.prepare(
      `INSERT INTO research_articles (source_id, received_at, subject, sender, raw_text, portfolio_relevance, processed_at)
       VALUES (1, datetime('now', '-1 day'), 'Subject', 'feed@example.com', 'body', 'Relevant to the held ZQN position', datetime('now', '-1 day', '+5 minutes'))`,
    ).run();
    const levelId = db
      .prepare("INSERT INTO security_levels (security_id, level_type, price) VALUES (?, 'support', 10)")
      .run(secId).lastInsertRowid as number;
    db.prepare(
      "INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price, suggested_action) VALUES (?, ?, datetime('now', '-1 hour'), 9, 'Trim the position held in the taxable account')",
    ).run(levelId, secId);
    db.prepare(
      "INSERT INTO calendar_briefings (week_of, title, content, event_count, generated_at) VALUES ('2026-11-02', 'Week', 'Held names this week', 1, datetime('now'))",
    ).run();
  });

  it("portfolio_relevance, suggested_action and briefing content", async () => {
    const opts = { scopeAccountIds: [3] };
    const feeds = (await executeTool(db, "query_research_feeds", {}, opts)) as {
      data: { articles: Array<{ portfolio_relevance: unknown }>; scope_note?: string };
    };
    expect(feeds.data.articles[0].portfolio_relevance).toBeNull();
    expect(feeds.data.scope_note).toMatch(/All Accounts/);

    const alerts = (await executeTool(db, "query_alerts", {}, opts)) as {
      data: { alerts: Array<{ suggested_action: unknown }>; scope_note?: string };
    };
    expect(alerts.data.alerts[0].suggested_action).toBeNull();
    expect(alerts.data.scope_note).toMatch(/All Accounts/);

    const briefings = (await executeTool(db, "query_calendar_briefings", {}, opts)) as {
      data: { briefings: Array<{ content: unknown; title: string }>; scope_note?: string };
    };
    expect(briefings.data.briefings[0].content).toBeNull();
    expect(briefings.data.briefings[0].title).toBe("Week");
    expect(briefings.data.scope_note).toMatch(/All Accounts/);
  });

  it("are shown in the All Accounts chat", async () => {
    const feeds = (await executeTool(db, "query_research_feeds", {})) as {
      data: { articles: Array<{ portfolio_relevance: unknown }> };
    };
    expect(feeds.data.articles[0].portfolio_relevance).toBe("Relevant to the held ZQN position");
    const alerts = (await executeTool(db, "query_alerts", {})) as {
      data: { alerts: Array<{ suggested_action: unknown }> };
    };
    expect(alerts.data.alerts[0].suggested_action).toMatch(/Trim/);
    const briefings = (await executeTool(db, "query_calendar_briefings", {})) as {
      data: { briefings: Array<{ content: unknown }> };
    };
    expect(briefings.data.briefings[0].content).toBe("Held names this week");
  });
});
