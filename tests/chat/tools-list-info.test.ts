/**
 * B10 dispatcher half + Contract G (Portfolio Assistant plan, Task 5).
 *
 * A list tool's wrapped result carries `list_info: { returned, limit,
 * truncated, note? }` beside `data`, built by fetching limit + 1 rows (P7).
 * Before the fix a 60-position book was handed to the model as "your
 * holdings" with 10 silently missing.
 *
 * Protects: the model is told when a list was cut. Bound: `truncated` is true
 * exactly when more rows match than `limit` (60 vs 50 → true; 50 vs 50 → false).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { executeTool } from "@/lib/chat/tools";
import { todayET, addDays } from "@/lib/calendar/date-utils";

let db: Database.Database;

type ListInfo = { returned: number; limit: number; truncated: boolean; note?: string };
type Wrapped = { error?: string; data?: unknown; list_info?: ListInfo & { open?: ListInfo; closed?: ListInfo } };

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedHoldings(n: number): void {
  const today = todayET();
  for (let i = 0; i < n; i++) {
    const id = db
      .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'stock', 'USD')")
      .run(`ZQ${i}`, `ZQ${i} Corp`).lastInsertRowid as number;
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (1, ?, 10, 100, ?, ?)",
    ).run(id, today, `h-${i}`);
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(id, today, 10 + i);
  }
}

describe("query_holdings list_info", () => {
  it("60 holdings with limit 50 report truncated", async () => {
    seedHoldings(60);
    const r = (await executeTool(db, "query_holdings", { limit: 50 })) as Wrapped;
    expect(r.error).toBeUndefined();
    expect(Array.isArray(r.data)).toBe(true);
    expect((r.data as unknown[]).length).toBe(50);
    expect(r.list_info).toEqual({
      returned: 50,
      limit: 50,
      truncated: true,
      note: "More rows match. Narrow the filter or raise limit (max 150).",
    });
  });

  it("exactly 50 report not truncated", async () => {
    seedHoldings(50);
    const r = (await executeTool(db, "query_holdings", { limit: 50 })) as Wrapped;
    expect((r.data as unknown[]).length).toBe(50);
    expect(r.list_info).toEqual({ returned: 50, limit: 50, truncated: false });
  });

  it("a missing, zero, negative, fractional or non-number limit becomes the default (50)", async () => {
    seedHoldings(55);
    for (const limit of [undefined, 0, -3, 2.5, "10", null]) {
      const r = (await executeTool(db, "query_holdings", { limit })) as Wrapped;
      expect(r.list_info?.limit).toBe(50);
      expect((r.data as unknown[]).length).toBe(50);
      expect(r.list_info?.truncated).toBe(true);
    }
  });
});

describe("query_tax_lots list_info has one object per list", () => {
  function seedLot(secId: number, i: number): number {
    return db
      .prepare(
        `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
         VALUES (1, ?, ?, 10, 1, 1, 10)`,
      )
      .run(secId, addDays(todayET(), -100 - i)).lastInsertRowid as number;
  }

  it("status 'all' reports open and closed separately", async () => {
    const secId = db
      .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES ('ZQL', 'ZQL Corp', 'stock', 'USD')")
      .run().lastInsertRowid as number;
    for (let i = 0; i < 3; i++) seedLot(secId, i);
    const r = (await executeTool(db, "query_tax_lots", { status: "all", limit: 2 })) as Wrapped;
    expect(r.error).toBeUndefined();
    expect(r.list_info?.open).toMatchObject({ returned: 2, limit: 2, truncated: true });
    expect(r.list_info?.closed).toMatchObject({ returned: 0, limit: 2, truncated: false });
    expect((r.data as unknown[]).length).toBe(2);
  });

  it("status 'open' reports the open list only", async () => {
    const secId = db
      .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES ('ZQL', 'ZQL Corp', 'stock', 'USD')")
      .run().lastInsertRowid as number;
    for (let i = 0; i < 2; i++) seedLot(secId, i);
    const r = (await executeTool(db, "query_tax_lots", { limit: 2 })) as Wrapped;
    expect(r.list_info?.open).toEqual({ returned: 2, limit: 2, truncated: false });
    expect(r.list_info?.closed).toBeUndefined();
  });
});

describe("the other list tools carry list_info", () => {
  it("query_transactions", async () => {
    for (let i = 0; i < 4; i++) {
      db.prepare(
        "INSERT INTO transactions (account_id, trade_date, type, amount, source_key) VALUES (1, ?, 'INTEREST', 1, ?)",
      ).run(addDays(todayET(), -i - 1), `t-${i}`);
    }
    const r = (await executeTool(db, "query_transactions", { limit: 3 })) as Wrapped;
    expect((r.data as { transactions: unknown[] }).transactions.length).toBe(3);
    expect(r.list_info).toMatchObject({ returned: 3, limit: 3, truncated: true });
  });

  it("query_calendar_events", async () => {
    for (let i = 0; i < 3; i++) {
      db.prepare(
        "INSERT INTO calendar_events (event_type, event_date, title, source, source_key) VALUES ('cpi', ?, ?, 'test', ?)",
      ).run(addDays(todayET(), i + 1), `CPI ${i}`, `test:cpi:${i}`);
    }
    const r = (await executeTool(db, "query_calendar_events", { limit: 2 })) as Wrapped;
    expect((r.data as { events: unknown[] }).events.length).toBe(2);
    expect(r.list_info).toMatchObject({ returned: 2, limit: 2, truncated: true });
  });

  it("query_levels, query_alerts and query_notes", async () => {
    const secId = db
      .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES ('ZQV', 'ZQV Corp', 'stock', 'USD')")
      .run().lastInsertRowid as number;
    for (let i = 0; i < 3; i++) {
      const levelId = db
        .prepare("INSERT INTO security_levels (security_id, level_type, price) VALUES (?, 'support', ?)")
        .run(secId, 10 + i).lastInsertRowid as number;
      db.prepare(
        "INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price) VALUES (?, ?, datetime('now', ?), 9)",
      ).run(levelId, secId, `-${i + 1} hours`);
      db.prepare(
        "INSERT INTO notes (note_type, content, event_date) VALUES ('journal', ?, '2026-11-01')",
      ).run(`note ${i}`);
    }
    for (const tool of ["query_levels", "query_alerts", "query_notes"]) {
      const r = (await executeTool(db, tool, { limit: 2 })) as Wrapped;
      expect(r.error).toBeUndefined();
      expect(r.list_info, tool).toMatchObject({ returned: 2, limit: 2, truncated: true });
    }
  });

  it("query_research_feeds and query_research_documents", async () => {
    for (let i = 0; i < 3; i++) {
      db.prepare(
        `INSERT INTO research_articles (source_id, received_at, subject, sender, raw_text, processed_at)
         VALUES (1, datetime('now', '-1 day'), ?, 'feed@example.com', 'body', datetime('now', '-1 day', '+5 minutes'))`,
      ).run(`Subject ${i}`);
    }
    const feeds = (await executeTool(db, "query_research_feeds", { limit: 2 })) as Wrapped;
    expect(feeds.list_info).toMatchObject({ returned: 2, limit: 2, truncated: true });

    const docs = (await executeTool(db, "query_research_documents", {})) as Wrapped;
    expect(docs.list_info).toMatchObject({ returned: 0, limit: 10, truncated: false });
  });
});
