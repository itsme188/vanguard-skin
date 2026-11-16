/**
 * FX4-UI item 3 (browser pass 2026-11-16): the "N cash-equivalent funds left
 * out" count on Position-Level Risk covers only the cash funds that would have
 * ranked inside the top N (the route grows its ask until N non-cash names are
 * in hand). A cash fund smaller than every ranked name is not counted, so the
 * card's line says what it counts: funds that "would have ranked in this list".
 * Synthetic book; a real migrated in-memory DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { anchorIndex } from "@/tests/helpers/source-anchor";

const h = vi.hoisted(() => ({ db: null as unknown as Database.Database }));
vi.mock("@/lib/db", () => ({
  get db() {
    return h.db;
  },
}));

import { GET } from "@/app/api/compute/position-risk/route";
import { todayET, addDays } from "@/lib/calendar/date-utils";

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
  // Three stocks, then one small money-market fund below all of them.
  add("ZZA", "Stock", null, 300, 100);
  add("ZZB", "Stock", null, 200, 100);
  add("ZZC", "Stock", null, 100, 100);
  add("ZMMS", "Mutual Fund", "Money Market", 1_000, 1);
  return d;
}

async function get(topN: number) {
  const res = await GET(new Request(`http://x/api/compute/position-risk?accountId=${ACCOUNT}&topN=${topN}`) as never);
  return res.json();
}

describe("Position-Level Risk cash count covers only funds that would have ranked (FX4 item 3)", () => {
  beforeEach(() => {
    h.db = seed();
  });

  it("does not count a cash fund smaller than every ranked name", async () => {
    const body = await get(2);
    expect(body.data.positions.map((p: { symbol: string }) => p.symbol)).toEqual(["ZZA", "ZZB"]);
    expect(body.data.cashEquivalentsLeftOut).toBe(0);
  });

  it("counts it when the list reaches it", async () => {
    const body = await get(10);
    expect(body.data.cashEquivalentsLeftOut).toBe(1);
  });

  it("the card's line says what it counts", () => {
    const src = readFileSync("app/dashboard/components/PositionRisk.tsx", "utf8");
    const line = src.slice(
      anchorIndex(src, "(data.cashEquivalentsLeftOut ?? 0) > 0 && ("),
      anchorIndex(src, "{/* ── Position table ── */}")
    );
    expect(line).toContain("would have ranked in this list and");
    expect(line).toContain('"was" : "were"');
    expect(line).toContain("{CASH_LEFT_OUT_TEXT}");
  });
});
