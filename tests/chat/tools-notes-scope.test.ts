/**
 * Notes and whole-book text in a scoped chat (owner ruling 2026-11-12,
 * replacing plan P9 / OPEN-7: inside the chat the owner is the only reader).
 *
 * In a chat scoped to some accounts the route passes the scope's id list as
 * `opts.scopeAccountIds` (Contract H). Then:
 *  - query_notes returns every note, and a note linked to a transaction
 *    carries that transaction's `account`, inside the scope or not;
 *  - query_earnings_transcript's user_notes follow the same rule;
 *  - fields written against the whole book (a research article's
 *    portfolio_relevance, an alert's suggested_action, a weekly briefing's
 *    content) are returned, with a scope_note saying they cover the whole
 *    portfolio.
 * The All Accounts chat returns the same notes with the same account names,
 * and no scope_note.
 *
 * Protects: no note or whole-book field is hidden from the owner by the
 * chat's scope, and a whole-book field is never presented as this scope's
 * own. Bound: every seeded note and field returned, each labelled.
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

type Note = { content: string; transaction_type: string | null; transaction_date: string | null; account?: string };

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

describe("query_notes in a scoped chat", () => {
  it("returns every note, each linked note naming its account", async () => {
    const r = (await executeTool(db, "query_notes", {}, { scopeAccountIds: [3] })) as { data: Note[] };
    const byContent = Object.fromEntries(r.data.map((n) => [n.content, n.account ?? null]));
    expect(byContent).toEqual({
      "unlinked journal": null,
      "on the IBKR trade": "IBKR",
      "on the taxable trade": "Vanguard Taxable",
    });
  });

  it("returns the same notes in the All Accounts chat", async () => {
    const scoped = (await executeTool(db, "query_notes", {}, { scopeAccountIds: [3] })) as { data: Note[] };
    const all = (await executeTool(db, "query_notes", {})) as { data: Note[] };
    expect(all.data).toEqual(scoped.data);
  });

  it("returns one note by id even when it sits on another account's trade", async () => {
    const id = (db.prepare("SELECT id FROM notes WHERE content = 'on the taxable trade'").get() as { id: number }).id;
    const r = (await executeTool(db, "query_notes", { id }, { scopeAccountIds: [3] })) as { data: Note[] };
    expect(r.data).toHaveLength(1);
    expect(r.data[0].account).toBe("Vanguard Taxable");
  });
});

describe("query_earnings_transcript user_notes in a scoped chat", () => {
  it("returns both notes, each naming its account", async () => {
    const r = (await executeTool(db, "query_earnings_transcript", { ticker: "ZQN" }, { scopeAccountIds: [3] })) as {
      data: { user_notes: Note[] };
    };
    expect(r.data.user_notes.map((n) => [n.content, n.account]).sort()).toEqual([
      ["on the IBKR trade", "IBKR"],
      ["on the taxable trade", "Vanguard Taxable"],
    ]);
  });

  it("shows both in the All Accounts chat", async () => {
    const r = (await executeTool(db, "query_earnings_transcript", { ticker: "ZQN" })) as {
      data: { user_notes: Note[] };
    };
    expect(r.data.user_notes).toHaveLength(2);
  });
});

describe("whole-book fields in a scoped chat are returned, labelled", () => {
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
    expect(feeds.data.articles[0].portfolio_relevance).toBe("Relevant to the held ZQN position");
    expect(feeds.data.scope_note).toBe(
      "portfolio_relevance was written against the whole portfolio, not only this chat's accounts.",
    );

    const alerts = (await executeTool(db, "query_alerts", {}, opts)) as {
      data: { alerts: Array<{ suggested_action: unknown }>; scope_note?: string };
    };
    expect(alerts.data.alerts[0].suggested_action).toBe("Trim the position held in the taxable account");
    expect(alerts.data.scope_note).toBe(
      "suggested_action was written against the whole portfolio, not only this chat's accounts.",
    );

    const briefings = (await executeTool(db, "query_calendar_briefings", {}, opts)) as {
      data: { briefings: Array<{ content: unknown; title: string }>; scope_note?: string };
    };
    expect(briefings.data.briefings[0].content).toBe("Held names this week");
    expect(briefings.data.briefings[0].title).toBe("Week");
    expect(briefings.data.scope_note).toBe(
      "The briefing text was written against the whole portfolio, not only this chat's accounts.",
    );
  });

  it("are shown in the All Accounts chat, with no scope_note", async () => {
    const feeds = (await executeTool(db, "query_research_feeds", {})) as {
      data: { articles: Array<{ portfolio_relevance: unknown }>; scope_note?: string };
    };
    expect(feeds.data.scope_note).toBeUndefined();
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
