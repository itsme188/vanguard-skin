/**
 * Size caps for the tools whose output grew with the book (Portfolio
 * Assistant plan, Task 8 follow-up). Each cap keeps list_info honest, and
 * where a tool returns totals the totals come from EVERY row, never from the
 * rows kept. Synthetic data only.
 *
 * Hand-worked market snapshot: 120 held names ZC0..ZC119, 10 shares each,
 * prior close 100.00, latest close 100 + 0.01 x i. Each name's day effect is
 * 10 x 0.01 x i = 0.1 x i dollars; the total over all 120 is
 * 0.1 x (0 + 1 + ... + 119) = 0.1 x 7140 = 714.00. With limit 50 the rows are
 * the 50 largest by |day effect| (ZC119 first) and the total stays 714.00.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

vi.mock("@/lib/queries/market-snapshot", async (orig) => ({
  ...(await orig<typeof import("@/lib/queries/market-snapshot")>()),
  fetchYahooQuotes: vi.fn(async () => null),
}));

import { runMigrations } from "@/lib/db/migrate";
import { executeTool, CHAT_TOOLS, compactToolOutput } from "@/lib/chat/tools";
import { todayET, addDays } from "@/lib/calendar/date-utils";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function schemaText(tool: string): string {
  return JSON.stringify(CHAT_TOOLS.find((t) => t.name === tool)!.input_schema);
}

describe("query_market_snapshot: rows capped, totals whole", () => {
  function seed(): void {
    const today = todayET();
    const yesterday = addDays(today, -1);
    const sec = db.prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, ?, 'USD')");
    const price = db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)");
    const hold = db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (3, ?, 10, 1000, ?, ?)",
    );
    for (const b of ["SPY", "QQQ", "DIA"]) {
      const id = sec.run(b, b, "etf").lastInsertRowid as number;
      price.run(id, yesterday, 500);
      price.run(id, today, 505);
    }
    for (let i = 0; i < 120; i++) {
      const id = sec.run(`ZC${i}`, `ZC${i} Corp`, "stock").lastInsertRowid as number;
      price.run(id, yesterday, 100);
      price.run(id, today, 100 + 0.01 * i);
      hold.run(id, yesterday, `y${i}`);
      hold.run(id, today, `t${i}`);
    }
  }
  type Move = { symbol: string; kind: string; day_effect?: number | null };
  type Snap = {
    data: { moves: Move[]; held_totals: { day_effect_total: number; held_rows: number; measured_rows: number } };
    list_info: { returned: number; limit: number; truncated: boolean };
  };

  it("limit 50 keeps the 50 largest held rows, every benchmark, and the whole-book total", async () => {
    seed();
    const r = (await executeTool(db, "query_market_snapshot", { limit: 50 })) as Snap;
    const held = r.data.moves.filter((m) => m.kind === "holding");
    const bench = r.data.moves.filter((m) => m.kind === "benchmark");
    expect(bench.map((m) => m.symbol).sort()).toEqual(["DIA", "QQQ", "SPY"]);
    expect(held).toHaveLength(50);
    expect(held[0].symbol).toBe("ZC119");
    expect(held[49].symbol).toBe("ZC70");
    expect(r.data.held_totals.held_rows).toBe(120);
    expect(r.data.held_totals.measured_rows).toBe(120);
    expect(r.data.held_totals.day_effect_total).toBeCloseTo(714, 6);
    // Not the total of the 50 rows kept (0.1 x (70 + ... + 119) = 472.50).
    const keptSum = held.reduce((a, m) => a + (m.day_effect ?? 0), 0);
    expect(keptSum).toBeCloseTo(472.5, 6);
    expect(r.list_info).toEqual({
      returned: 50,
      limit: 50,
      truncated: true,
      note: "More rows match. Narrow the filter or raise limit (max 100).",
    });
  });

  it("default 40, max 100, stated in the schema", async () => {
    seed();
    const d = (await executeTool(db, "query_market_snapshot", {})) as Snap;
    expect(d.list_info.limit).toBe(40);
    const m = (await executeTool(db, "query_market_snapshot", { limit: 9999 })) as Snap;
    expect(m.list_info.limit).toBe(100);
    expect(schemaText("query_market_snapshot")).toContain("default 40, max 100");
  });
});

describe("query_performance: trailing 24 months by default", () => {
  function seed(): void {
    const snap = db.prepare(
      "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (1, ?, ?, 'statement')",
    );
    const today = todayET();
    const [y, mo] = today.split("-").map(Number);
    for (let m = 1; m <= 130; m++) {
      const d = new Date(Date.UTC(y, mo - 1 - m + 1, 0)).toISOString().slice(0, 10);
      snap.run(d, 1000 + m);
    }
  }
  const months = (r: unknown) => ((r as { data: unknown[] }).data ?? []).length;

  it("defaults to 24 months, takes months up to 120, and states both", async () => {
    seed();
    const def = await executeTool(db, "query_performance", { account_name: "Vanguard Taxable" });
    expect(months(def)).toBe(24);
    const more = await executeTool(db, "query_performance", { account_name: "Vanguard Taxable", months: 60 });
    expect(months(more)).toBe(60);
    const max = await executeTool(db, "query_performance", { account_name: "Vanguard Taxable", months: 9999 });
    expect(months(max)).toBe(120);
    expect(schemaText("query_performance")).toContain("default 24, max 120");
  });

  it("an explicit start_date wins over months", async () => {
    seed();
    const start = addDays(todayET(), -100);
    const r = (await executeTool(db, "query_performance", { account_name: "Vanguard Taxable", start_date: start })) as {
      data: Array<{ month_end_date?: string; month?: string }>;
    };
    expect(r.data.length).toBeGreaterThan(0);
    expect(r.data.length).toBeLessThanOrEqual(4);
  });
});

describe("lowered maxima for text-heavy and long lists", () => {
  const cases: Array<[string, number, number]> = [
    ["query_holdings", 50, 150],
    ["query_tax_lots", 50, 150],
    ["query_calendar_events", 50, 100],
    ["query_press_releases", 15, 40],
    ["query_research_feeds", 15, 25],
    ["query_levels", 30, 60],
    ["query_alerts", 20, 40],
  ];
  for (const [tool, def, max] of cases) {
    it(`${tool}: default ${def}, max ${max}`, () => {
      expect(schemaText(tool)).toContain(`default ${def}, max ${max}`);
    });
  }
});

describe("per-row text cuts point at the full item", () => {
  it("calendar descriptions, press summaries, feed summaries and document summaries", async () => {
    const today = todayET();
    for (let i = 0; i < 3; i++) {
      db.prepare(
        "INSERT INTO calendar_events (source, event_type, event_date, title, description, symbol, source_key) VALUES ('t', 'earnings', ?, ?, ?, ?, ?)",
      ).run(addDays(today, 1), `ZD${i} call`, "d".repeat(500), `ZD${i}`, `k${i}`);
      db.prepare(
        `INSERT INTO research_articles (source_id, received_at, subject, sender, raw_text, summary, processed_at)
         VALUES (1, datetime('now', '-1 hour'), ?, 'f@example.com', 'b', ?, datetime('now'))`,
      ).run(`Note ${i}`, "s".repeat(900));
      db.prepare(
        "INSERT INTO research_documents (title, filename, raw_text, summary) VALUES (?, ?, 'b', ?)",
      ).run(`Doc ${i}`, `d${i}.pdf`, "m".repeat(1500));
    }
    const ev = JSON.stringify(compactToolOutput("query_calendar_events", await executeTool(db, "query_calendar_events", {})));
    expect(ev).toMatch(/…\[cut: \d+ more chars; call query_calendar_events with symbol=ZD\d to read it in full\]/);
    const feeds = JSON.stringify(compactToolOutput("query_research_feeds", await executeTool(db, "query_research_feeds", {})));
    expect(feeds).toMatch(/call query_research_feeds with search=\\"Note \d\\" to read it in full/);
    const docs = JSON.stringify(compactToolOutput("query_research_documents", await executeTool(db, "query_research_documents", {})));
    expect(docs).toMatch(/call query_research_documents with query=\\"Doc \d\\" to read it in full/);
  });

  it("a compact form never comes out longer than the full result", async () => {
    const full = await executeTool(db, "create_note", { note_type: "journal", content: "short" });
    expect(JSON.stringify(compactToolOutput("create_note", full)).length).toBeLessThanOrEqual(JSON.stringify(full).length);
  });
});
