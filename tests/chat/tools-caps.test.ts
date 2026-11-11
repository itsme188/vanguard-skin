/**
 * R4 caps (Portfolio Assistant plan, Task 5): server maxima enforced in code,
 * whatever the model asks for, and stated in each tool's description.
 *
 * Protects: no single tool result exceeds its cap. Bounds: limit <= 200 for
 * holdings, tax lots, transactions, levels, alerts; <= 100 notes, press
 * releases; <= 20 insider trades; <= 25 research documents; price history <=
 * 260 rows (weekly, then monthly sampling); calendar briefings <= 4 weeks.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";

vi.mock("@/lib/apis/press-releases", () => ({
  fetchAndCachePressReleases: vi.fn(async () => ({ upserted: 0 })),
}));
vi.mock("@/lib/apis/edgar", () => ({
  getCompanyFinancials: vi.fn(),
  getCompanyInfo: vi.fn(),
  getRecentFilings: vi.fn(),
  getInsiderTransactions: vi.fn(async () => []),
}));

import { runMigrations } from "@/lib/db/migrate";
import { executeTool, CHAT_TOOLS } from "@/lib/chat/tools";
import { getInsiderTransactions } from "@/lib/apis/edgar";
import { addDays, todayET } from "@/lib/calendar/date-utils";

let db: Database.Database;

type ListInfo = { returned: number; limit: number; truncated: boolean };
type Wrapped = { error?: string; data?: Record<string, unknown>; list_info?: ListInfo & { open?: ListInfo } };

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function descriptionOf(tool: string): string {
  const t = CHAT_TOOLS.find((x) => x.name === tool)!;
  const limit = (t.input_schema.properties as Record<string, { description?: string }>).limit;
  return `${t.description} ${limit?.description ?? ""}`;
}

describe("limit maxima", () => {
  const cases: Array<[string, number, Record<string, unknown>]> = [
    ["query_holdings", 200, {}],
    ["query_transactions", 200, {}],
    ["query_levels", 200, {}],
    ["query_alerts", 200, {}],
    ["query_notes", 100, {}],
    ["query_research_documents", 25, {}],
    ["query_press_releases", 100, { ticker: "ZQZ" }],
  ];
  for (const [tool, max, input] of cases) {
    it(`${tool} caps limit at ${max} and says so`, async () => {
      const r = (await executeTool(db, tool, { ...input, limit: 5000 })) as Wrapped;
      expect(r.error).toBeUndefined();
      expect(r.list_info?.limit).toBe(max);
      expect(descriptionOf(tool)).toContain(`max ${max}`);
    });
  }

  it("query_tax_lots caps each list at 200", async () => {
    const r = (await executeTool(db, "query_tax_lots", { limit: 5000 })) as Wrapped;
    expect(r.list_info?.open?.limit).toBe(200);
    expect(descriptionOf("query_tax_lots")).toContain("max 200");
  });

  it("query_insider_trades asks EDGAR for at most 20 filings", async () => {
    await executeTool(db, "query_insider_trades", { ticker: "ZQZ", limit: 999 });
    expect(vi.mocked(getInsiderTransactions)).toHaveBeenLastCalledWith("ZQZ", expect.objectContaining({ limit: 20 }));
    expect(descriptionOf("query_insider_trades")).toContain("max 20");
  });
});

describe("query_price_history row cap", () => {
  function seedDaily(days: number): number {
    const id = db
      .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES ('ZQP', 'ZQP Corp', 'stock', 'USD')")
      .run().lastInsertRowid as number;
    const end = todayET();
    const ins = db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)");
    for (let i = days - 1; i >= 0; i--) ins.run(id, addDays(end, -i), 100 + (days - i) / 100);
    return id;
  }
  type Hist = { rows: Array<{ date: string; close_price: number }>; sampled: string; note?: string };

  it("a short range stays daily", async () => {
    seedDaily(30);
    const r = (await executeTool(db, "query_price_history", { symbol: "ZQP", start_date: addDays(todayET(), -40) })) as Wrapped;
    const d = r.data as unknown as Hist;
    expect(d.sampled).toBe("daily");
    expect(d.rows.length).toBe(30);
  });

  it("a range over 260 days returns the last close of each week", async () => {
    seedDaily(400);
    const r = (await executeTool(db, "query_price_history", { symbol: "ZQP", start_date: addDays(todayET(), -500) })) as Wrapped;
    const d = r.data as unknown as Hist;
    expect(d.sampled).toBe("weekly");
    expect(d.rows.length).toBeLessThanOrEqual(260);
    expect(d.rows.length).toBeGreaterThan(50);
    // The newest row is the newest daily close, never an average.
    expect(d.rows[d.rows.length - 1].date).toBe(todayET());
    expect(d.note).toMatch(/last close of each week/);
  });

  it("a range over 260 weeks returns the last close of each month", async () => {
    seedDaily(2000);
    const r = (await executeTool(db, "query_price_history", { symbol: "ZQP", start_date: addDays(todayET(), -2100) })) as Wrapped;
    const d = r.data as unknown as Hist;
    expect(d.sampled).toBe("monthly");
    expect(d.rows.length).toBeLessThanOrEqual(260);
    expect(d.rows[d.rows.length - 1].date).toBe(todayET());
  });

  it("the description states the cap", () => {
    expect(descriptionOf("query_price_history")).toContain("260");
  });
});

describe("query_calendar_briefings weeks_back cap", () => {
  it("returns at most 4 weeks", async () => {
    for (let i = 0; i < 6; i++) {
      db.prepare(
        "INSERT INTO calendar_briefings (week_of, title, content, event_count, generated_at) VALUES (?, ?, 'body', 1, datetime('now'))",
      ).run(addDays("2026-01-05", 7 * i), `Week ${i}`);
    }
    const r = (await executeTool(db, "query_calendar_briefings", { weeks_back: 12 })) as Wrapped;
    expect((r.data as { count: number }).count).toBe(4);
    const t = CHAT_TOOLS.find((x) => x.name === "query_calendar_briefings")!;
    expect(JSON.stringify(t.input_schema)).toContain("max 4");
  });
});

// R5-4 (barrier-1 review): sampling keeps the FIRST and the LAST stored close
// of the range, and the note says the rows are sampled and must not feed
// daily statistics. Worked by hand:
//  - weekly: daily closes 2025-01-01 (a Wednesday) to 2025-12-31, 365 rows.
//    Monday weeks run from 2024-12-30 to 2025-12-29: 53 buckets. Rows are the
//    first close 2025-01-01, then each week's last close (2025-01-05, ...,
//    2025-12-31): 54 rows.
//  - monthly: 2019-01-01 to 2025-12-31, 2557 rows, 366 week buckets (> 259),
//    84 months. Rows: 2019-01-01, then each month's last close (2019-01-31,
//    ..., 2025-12-31): 85 rows.
describe("query_price_history sampling keeps the range's first and last close", () => {
  function seedRange(start: string, end: string): void {
    const id = db
      .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES ('ZQS', 'ZQS Corp', 'stock', 'USD')")
      .run().lastInsertRowid as number;
    const ins = db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)");
    let i = 0;
    for (let d = start; d <= end; d = addDays(d, 1)) ins.run(id, d, 50 + i++ / 100);
  }
  type Hist = { rows: Array<{ date: string }>; sampled: string; note?: string };
  const call = async (start: string, end: string) =>
    ((await executeTool(db, "query_price_history", { symbol: "ZQS", start_date: start, end_date: end })) as {
      data: Hist;
    }).data;

  it("weekly", async () => {
    seedRange("2025-01-01", "2025-12-31");
    const d = await call("2025-01-01", "2025-12-31");
    expect(d.sampled).toBe("weekly");
    expect(d.rows.length).toBe(54);
    expect(d.rows[0].date).toBe("2025-01-01");
    expect(d.rows[1].date).toBe("2025-01-05");
    expect(d.rows[d.rows.length - 1].date).toBe("2025-12-31");
    expect(d.note).toMatch(/sampled/);
    expect(d.note).toMatch(/volatility/);
  });

  it("monthly", async () => {
    seedRange("2019-01-01", "2025-12-31");
    const d = await call("2019-01-01", "2025-12-31");
    expect(d.sampled).toBe("monthly");
    expect(d.rows.length).toBe(85);
    expect(d.rows[0].date).toBe("2019-01-01");
    expect(d.rows[1].date).toBe("2019-01-31");
    expect(d.rows[d.rows.length - 1].date).toBe("2025-12-31");
    expect(d.note).toMatch(/last close of each month/);
    expect(d.note).toMatch(/drawdown/);
  });
});
