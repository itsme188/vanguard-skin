/**
 * Owner ruling (2026-11-16): cash is never ranked as a position. The
 * Position-Level Risk card's route leaves every cash-equivalent fund out
 * BEFORE the top N is taken (as the "top N by risk" drawer does through
 * cashFreeTopPositions), says how many it left out, and drops a pairwise
 * correlation that names one. Synthetic book; a real migrated in-memory DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

const h = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", () => ({
  get db() {
    return h.db;
  },
}));

import { GET } from "@/app/api/compute/position-risk/route";
import { cashFreeTopPositions } from "@/lib/queries/drill-down";
import { todayET, addDays } from "@/lib/calendar/date-utils";

// Migration 002 seeds account 1.
const ACCOUNT = 1;

function seed() {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  runMigrations(d);
  const day = addDays(todayET(), -1);
  const add = (symbol: string, type: string, fundCategory: string | null, qty: number, price: number) => {
    const id = d
      .prepare("INSERT INTO securities (symbol, name, security_type, fund_category, source_key) VALUES (?, ?, ?, ?, ?)")
      .run(symbol, symbol, type, fundCategory, `t:${symbol}`).lastInsertRowid as number;
    d.prepare("INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, ?)").run(
      ACCOUNT,
      id,
      qty,
      qty * price,
      day
    );
    d.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, ?, 'test')").run(id, price, day);
  };
  // Two money-market funds bigger than every stock, then three stocks.
  add("ZMMA", "Mutual Fund", "Money Market", 50_000, 1);
  add("ZMMB", "Mutual Fund", "Money Market", 40_000, 1);
  add("ZZA", "Stock", null, 300, 100);
  add("ZZB", "Stock", null, 200, 100);
  add("ZZC", "Stock", null, 100, 100);
  return d;
}

async function get(topN: number) {
  const res = await GET(new Request(`http://x/api/compute/position-risk?accountId=${ACCOUNT}&topN=${topN}`) as never);
  return res.json();
}

describe("GET /api/compute/position-risk leaves cash out before the top N", () => {
  beforeEach(() => {
    h.db = seed();
  });

  it("ranks no cash-equivalent fund and still lists N names", async () => {
    const body = await get(2);
    expect(body.success).toBe(true);
    const symbols = body.data.positions.map((p: { symbol: string }) => p.symbol);
    expect(symbols).toEqual(["ZZA", "ZZB"]);
    expect(body.data.positions.some((p: { cashEquivalent: boolean }) => p.cashEquivalent)).toBe(false);
    expect(body.data.cashEquivalentsLeftOut).toBe(2);
  });

  it("lists the same rows as the drawer's cashFreeTopPositions", async () => {
    const body = await get(2);
    const drawer = cashFreeTopPositions(h.db, [ACCOUNT], 2);
    expect(body.data.positions).toEqual(JSON.parse(JSON.stringify(drawer)));
  });

  it("drops a pairwise correlation that names a cash fund", async () => {
    const body = await get(10);
    for (const c of body.data.correlations as Array<{ symbolA: string; symbolB: string }>) {
      expect(["ZMMA", "ZMMB"]).not.toContain(c.symbolA);
      expect(["ZMMA", "ZMMB"]).not.toContain(c.symbolB);
    }
    expect(body.data.positions).toHaveLength(3);
    expect(body.data.cashEquivalentsLeftOut).toBe(2);
  });

  it("the week-ago snapshot carries the same rule", async () => {
    const body = await get(2);
    expect(body.weekAgo.positions.some((p: { cashEquivalent: boolean }) => p.cashEquivalent)).toBe(false);
    expect(typeof body.weekAgo.cashEquivalentsLeftOut).toBe("number");
  });
});
