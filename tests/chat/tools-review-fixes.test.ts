/**
 * Barrier-1 review fixes for the chat tool dispatcher (Portfolio Assistant
 * plan, Task 5 fix round, items R5-1 .. R5-15). Synthetic data only; the
 * network-backed engines are mocked.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

vi.mock("@/lib/apis/press-releases", () => ({
  fetchAndCachePressReleases: vi.fn(async () => ({ upserted: 0 })),
}));
vi.mock("@/lib/apis/analyst-estimates", () => ({
  syncAnalystCoverage: vi.fn(async () => ({ errors: [] })),
}));

import { runMigrations } from "@/lib/db/migrate";
import { executeTool, CHAT_TOOLS } from "@/lib/chat/tools";
import { fetchAndCachePressReleases } from "@/lib/apis/press-releases";
import { VALID_TRANSACTION_TYPES } from "@/lib/import/validate";
import { todayET, addDays } from "@/lib/calendar/date-utils";

let db: Database.Database;
type Wrapped = { error?: string; data?: Record<string, unknown> & unknown[]; list_info?: unknown };

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.mocked(fetchAndCachePressReleases).mockClear();
});

function security(symbol: string): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'stock', 'USD')")
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function schemaOf(tool: string): { properties: Record<string, { type?: string; enum?: string[]; description?: string }> } {
  return CHAT_TOOLS.find((t) => t.name === tool)!.input_schema as never;
}

describe("R5-1 query_alerts orders by instant, not by stored string", () => {
  it("a newer space-form alert beats an older ISO-form alert under a limit", async () => {
    const secId = security("ZRA");
    const levelId = db
      .prepare("INSERT INTO security_levels (security_id, level_type, price) VALUES (?, 'support', 10)")
      .run(secId).lastInsertRowid as number;
    const ins = db.prepare("INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price) VALUES (?, ?, ?, ?)");
    // Same day: the ISO form sorts above the space form as a string, but the
    // space-form row is the NEWER instant.
    const day = todayET();
    ins.run(levelId, secId, `${day}T00:10:00.000Z`, 1); // older
    ins.run(levelId, secId, `${day} 00:20:00`, 2); // newer
    const r = (await executeTool(db, "query_alerts", { limit: 1, since_days: 3 })) as {
      data: { alerts: Array<{ triggered_price: number }> };
    };
    expect(r.data.alerts.map((a) => a.triggered_price)).toEqual([2]);
  });
});

describe("R5-5 research source exact name wins", () => {
  it("an exact (any-case) name is selected even when it is part of another name", async () => {
    db.prepare("INSERT INTO research_sources (name) VALUES ('The Diff Weekly')").run();
    const r = (await executeTool(db, "query_research_feeds", { source: "the diff" })) as Wrapped;
    expect(r.error).toBeUndefined();
  });
});

describe("R5-6 press releases days_back is 1..365", () => {
  it("clamps an oversize window and defaults garbage", async () => {
    await executeTool(db, "query_press_releases", { ticker: "ZRP", days_back: 5000 });
    expect(vi.mocked(fetchAndCachePressReleases)).toHaveBeenLastCalledWith(db, "ZRP", 365);
    await executeTool(db, "query_press_releases", { ticker: "ZRP", days_back: -4 });
    expect(vi.mocked(fetchAndCachePressReleases)).toHaveBeenLastCalledWith(db, "ZRP", 7);
  });
});

describe("R5-7 enums and level filters", () => {
  it("the transaction type enum is the import validator's list, without RECONCILE_CLOSE", () => {
    const e = schemaOf("query_transactions").properties.type.enum!;
    expect([...e].sort()).toEqual([...VALID_TRANSACTION_TYPES].filter((t) => t !== "RECONCILE_CLOSE").sort());
    expect(e).not.toContain("RECONCILE_CLOSE");
  });

  it("query_levels without a symbol applies the same filters as with one", async () => {
    const secId = security("ZRL");
    const lvl = db.prepare(
      "INSERT INTO security_levels (security_id, level_type, price, is_active, review_status) VALUES (?, 'support', ?, ?, ?)",
    );
    lvl.run(secId, 10, 1, "auto_approved"); // armed
    lvl.run(secId, 11, 1, "rejected"); // rejected in review
    lvl.run(secId, 12, 0, "auto_approved"); // inactive
    const prices = async (input: Record<string, unknown>) =>
      ((await executeTool(db, "query_levels", input)) as { data: { levels: Array<{ price: number }> } }).data.levels
        .map((l) => l.price)
        .sort();
    expect(await prices({})).toEqual([10]);
    expect(await prices({ symbol: "ZRL" })).toEqual([10]);
    expect(await prices({ include_inactive: true })).toEqual([10, 11, 12]);
    expect(await prices({ symbol: "ZRL", include_inactive: true })).toEqual([10, 11, 12]);
  });
});

describe("R5-8 wrong-typed input is an error naming the parameter", () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["query_holdings", { account_name: 12345 }, /"account_name" must be a string/],
    ["query_notes", { search: 12345 }, /"search" must be a string/],
    ["query_analyst_coverage", {}, /"ticker" is required/],
    ["query_analyst_coverage", { ticker: 12345 }, /"ticker" must be a string/],
    ["query_press_releases", { ticker: 12345 }, /"ticker" must be a string/],
    ["query_research_documents", { query: 12345 }, /"query" must be a string/],
    ["query_release_reactions", { event_type: 12345 }, /"event_type" must be a string/],
    ["query_tax_lots", { year: "abc" }, /"year" must be an integer/],
    ["query_earnings_transcript", { ticker: "ZRT", include_full_text: "yes" }, /"include_full_text" must be true or false/],
    ["create_note", { note_type: "journal", content: "x", tags: "notarray" }, /"tags" must be a list of strings/],
  ];
  for (const [tool, input, msg] of cases) {
    it(`${tool} ${JSON.stringify(input)}`, async () => {
      const r = (await executeTool(db, tool, input)) as Wrapped;
      expect(r.error).toMatch(msg);
      expect(r.error).not.toMatch(/is not a function|Cannot read properties|datatype mismatch/);
    });
  }

  it("analyst coverage counts take defaults instead of a database error", async () => {
    const r = (await executeTool(db, "query_analyst_coverage", { ticker: "ZRA", months_history: 2.5, rating_changes_limit: "abc" })) as Wrapped;
    expect(r.error).toBeUndefined();
  });

  it("a null parameter is treated as omitted", async () => {
    const r = (await executeTool(db, "query_holdings", { account_name: null, symbol: null })) as Wrapped;
    expect(r.error).toBeUndefined();
  });
});

describe("R5-11 greeks for an underlying not held", () => {
  it("withholds the totals with a note", async () => {
    const r = (await executeTool(db, "query_options_greeks", { underlying: "ZRX" })) as {
      data: { portfolio: { totalDelta: number | null; note: string | null } };
    };
    expect(r.data.portfolio.totalDelta).toBeNull();
    expect(r.data.portfolio.note).toMatch(/no option position on ZRX/);
  });
});

describe("R5-12/13 day windows are bounded integers", () => {
  it("every day-window parameter is typed integer and states its bounds", () => {
    const windows: Array<[string, string]> = [
      ["query_calendar_events", "days_ahead"],
      ["query_calendar_events", "days_back"],
      ["query_research_feeds", "days_back"],
      ["query_research_documents", "days_back"],
      ["query_calendar_briefings", "weeks_back"],
      ["query_alerts", "since_days"],
      ["query_press_releases", "days_back"],
    ];
    for (const [tool, p] of windows) {
      const prop = schemaOf(tool).properties[p];
      expect(prop.type, `${tool}.${p}`).toBe("integer");
      expect(prop.description, `${tool}.${p}`).toMatch(/max \d+/);
    }
  });

  it("calendar events: a garbage or oversize window falls back to its bounds", async () => {
    db.prepare(
      "INSERT INTO calendar_events (source, event_type, event_date, title, source_key) VALUES ('t', 'cpi', ?, 'Far', 'k1')",
    ).run(addDays(todayET(), 400));
    db.prepare(
      "INSERT INTO calendar_events (source, event_type, event_date, title, source_key) VALUES ('t', 'cpi', ?, 'Near', 'k2')",
    ).run(addDays(todayET(), 3));
    const count = async (input: Record<string, unknown>) =>
      ((await executeTool(db, "query_calendar_events", input)) as { data: { count: number } }).data.count;
    expect(await count({ days_ahead: "abc" })).toBe(1); // default 14
    expect(await count({ days_ahead: 99999 })).toBe(1); // max 365
    expect(await count({ days_ahead: 2.5 })).toBe(1);
  });
});

describe("R5-14 / R5-15 descriptions", () => {
  it("query_alerts no longer promises a position context", () => {
    const d = CHAT_TOOLS.find((t) => t.name === "query_alerts")!.description!;
    expect(d).not.toMatch(/position context/);
  });

  it("query_income_summary names the pairing rule, commissions and unpaired_reinvestment_count", () => {
    const d = CHAT_TOOLS.find((t) => t.name === "query_income_summary")!.description!;
    expect(d).toMatch(/to the cent/);
    expect(d).toMatch(/COMMISSION/);
    expect(d).toMatch(/unpaired_reinvestment_count/);
  });

  it("the research source is spelled Eliant Capital", () => {
    const d = CHAT_TOOLS.find((t) => t.name === "query_research_feeds")!.description!;
    expect(d).toContain("Eliant Capital");
  });
});
