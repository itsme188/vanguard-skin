/**
 * query_allocation: one real category is one group, whatever the stored
 * spelling (CLAUDE.md: compare security types case-insensitively; sectors
 * via normalizeSector; fund categories via normalizeFundCategory).
 *
 * Synthetic book (all priced at 10, one account):
 *   security_type: "Option" 1 x 10 x 100 = 1000, "option" 1 x 10 x 100 = 1000,
 *                  "OPTION" 1 x 10 x 100 = 1000, "Stock" 10 x 10 = 100,
 *                  "stock" 20 x 10 = 200, "Mutual Fund" 30 x 10 = 300,
 *                  "mutual_fund" 40 x 10 = 400
 *   -> Option 3000 (3 positions), Stock 300 (2), Mutual Fund 700 (2); total 4000.
 *   sector: "Information Technology" (the 100 stock) and "technology" (the
 *   200 stock) -> one "Technology" group of 300.
 *   fund_category: "Large Blend" (300) and "large blend" (400) -> one group
 *   of 700; "Technology" (a vendor variant) -> "US Sector Equity (Technology)".
 * Conservation: group totals sum to the allocation total (4000) and the
 * percentages to 100.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllocationBreakdown, type AllocationResult } from "@/lib/queries/chat-tools";

let db: Database.Database;
let n = 0;

function hold(type: string, qty: number, opts: { sector?: string; fund_category?: string; multiplier?: number } = {}) {
  n += 1;
  const isOption = type.toLowerCase() === "option";
  const sec = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, sector, fund_category, multiplier, expiration_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `S${n}`,
      `S${n}`,
      type,
      opts.sector ?? null,
      opts.fund_category ?? null,
      opts.multiplier ?? (isOption ? 100 : 1),
      isOption ? "2026-12-18" : null
    ).lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (1, ?, ?, 1, '2026-11-10', ?)"
  ).run(sec, qty, `alloc-${n}`);
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-11-10', 10, 't')").run(sec);
}

function byName(rows: AllocationResult[]) {
  return Object.fromEntries(rows.map((r) => [r.group_name, r]));
}

beforeEach(() => {
  n = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T17:00:00Z"));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hold("Option", 1);
  hold("option", 1);
  hold("OPTION", 1);
  hold("Stock", 10, { sector: "Information Technology" });
  hold("stock", 20, { sector: "technology" });
  hold("Mutual Fund", 30, { fund_category: "Large Blend" });
  hold("mutual_fund", 40, { fund_category: "large blend" });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("getAllocationBreakdown groups one category once", () => {
  it("security types differing only in case or underscore are one group", () => {
    const rows = getAllocationBreakdown(db, "security_type");
    expect(rows.map((r) => r.group_name).sort()).toEqual(["Mutual Fund", "Option", "Stock"]);
    const g = byName(rows);
    expect(g.Option.total_market_value).toBeCloseTo(3000, 6);
    expect(g.Option.position_count).toBe(3);
    expect(g.Stock.total_market_value).toBeCloseTo(300, 6);
    expect(g["Mutual Fund"].total_market_value).toBeCloseTo(700, 6);
    expect(rows.reduce((s, r) => s + r.total_market_value, 0)).toBeCloseTo(4000, 6);
    expect(rows.reduce((s, r) => s + r.percentage, 0)).toBeCloseTo(100, 6);
    expect(g.Option.percentage).toBeCloseTo(75, 6);
  });

  it("sector variants are one GICS group", () => {
    const rows = getAllocationBreakdown(db, "sector");
    const g = byName(rows);
    expect(g.Technology.total_market_value).toBeCloseTo(300, 6);
    expect(g.Technology.position_count).toBe(2);
    expect(rows.filter((r) => r.group_name.toLowerCase().includes("tech"))).toHaveLength(1);
    expect(rows.reduce((s, r) => s + r.total_market_value, 0)).toBeCloseTo(4000, 6);
  });

  it("fund category variants are one group", () => {
    hold("ETF", 5, { fund_category: "Technology" });
    const rows = getAllocationBreakdown(db, "fund_category");
    const g = byName(rows);
    expect(g["Large Blend"].total_market_value).toBeCloseTo(700, 6);
    expect(g["Large Blend"].position_count).toBe(2);
    expect(g["US Sector Equity (Technology)"].total_market_value).toBeCloseTo(50, 6);
    expect(rows.filter((r) => r.group_name.toLowerCase() === "large blend")).toHaveLength(1);
    expect(rows.reduce((s, r) => s + r.total_market_value, 0)).toBeCloseTo(4050, 6);
    expect(rows.reduce((s, r) => s + r.percentage, 0)).toBeCloseTo(100, 6);
  });
});
