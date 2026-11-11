/**
 * query_risk (Portfolio Assistant plan, Task 6).
 *
 * Protects: the risk figures the chat quotes are the Analysis risk card's own
 * (computeRiskMetrics, same arguments as app/api/compute/risk/route.ts), for
 * the chat's scope only. Bound: volatility equals the hand-worked figure for
 * an alternating +1% / -1% series within 1e-9; Herfindahl of a 300/100 book
 * is exactly 0.625; an empty scope never reaches the engine.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/compute/risk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compute/risk")>();
  return { ...actual, computeRiskMetrics: vi.fn(actual.computeRiskMetrics) };
});

import { computeRiskMetrics } from "@/lib/compute/risk";
import { queryRiskTool } from "@/lib/chat/composite/risk";
import { COMPOSITE_MAX_JSON_CHARS } from "@/lib/chat/composite/shared";

const TODAY = "2026-03-01";
const BASE = "2026-01-01";
let db: Database.Database;

function day(i: number): string {
  const d = new Date(`${BASE}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}

function addStock(symbol: string, accountId: number, qty: number, price: number): void {
  const id = db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'Stock', 'USD')")
    .run(symbol, `${symbol} Co`).lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(accountId, id, qty, qty * price, day(39), `h-${symbol}-${accountId}`);
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(id, day(39), price);
}

/** 40 daily values for one account: 1000, then alternately x1.01 and x0.99. */
function seedSeries(accountId: number): void {
  let v = 1000;
  for (let i = 0; i < 40; i++) {
    if (i > 0) v = v * (i % 2 === 1 ? 1.01 : 0.99);
    db.prepare(
      "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (?, ?, 0, ?, ?)",
    ).run(accountId, day(i), v, v);
  }
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.mocked(computeRiskMetrics).mockClear();
  seedSeries(3);
  seedSeries(1);
  addStock("AAA", 3, 30, 10);
  addStock("BBB", 3, 10, 10);
  addStock("CCC", 1, 50, 10);
});

type RiskOut = {
  error?: string;
  volatility: number | null;
  sharpe_ratio: number | null;
  risk_free_rate: number;
  max_drawdown: { fraction: number; peak_date: string; trough_date: string } | null;
  concentration: { herfindahl: number | null; top5_share: number; position_count: number; top5: { symbol: string }[] };
  scope: { all_accounts: boolean; account_names: string[] };
  window: { data_points: number; series_start: string | null; series_end: string | null };
  seam_days_bridged: number;
  withheld?: Record<string, string>;
};

describe("query_risk", () => {
  it("returns the engine's figures for the same scope (parity)", () => {
    const out = queryRiskTool.run(db, {}, { accountIds: [3], today: TODAY }) as RiskOut;
    const engine = computeRiskMetrics(db, { accountIds: [3] });
    expect(out.volatility).toBe(engine.volatility);
    expect(out.sharpe_ratio).toBe(engine.sharpeRatio);
    expect(out.risk_free_rate).toBe(engine.riskFreeRate);
    expect(out.max_drawdown?.fraction).toBe(engine.maxDrawdown?.percent);
    expect(out.max_drawdown?.peak_date).toBe(engine.maxDrawdown?.peakDate);
    expect(out.max_drawdown?.trough_date).toBe(engine.maxDrawdown?.troughDate);
    expect(out.concentration.herfindahl).toBe(engine.herfindahl);
    expect(out.concentration.top5_share).toBe(engine.top5Concentration);
    expect(out.window.data_points).toBe(engine.dataPoints);
    expect(out.window.series_start).toBe(engine.seriesStart);
    expect(out.window.series_end).toBe(engine.seriesEnd);
    expect(out.seam_days_bridged).toBe(engine.seamDaysBridged);
  });

  it("matches the hand-worked figures for the scoped book", () => {
    const out = queryRiskTool.run(db, {}, { accountIds: [3], today: TODAY }) as RiskOut;
    // 39 daily log returns: 20 of ln(1.01), 19 of ln(0.99); sample sd x sqrt(252).
    const up = Math.log(1.01);
    const down = Math.log(0.99);
    const mean = (20 * up + 19 * down) / 39;
    const variance = (20 * (up - mean) ** 2 + 19 * (down - mean) ** 2) / 38;
    expect(out.volatility).toBeCloseTo(Math.sqrt(variance) * Math.sqrt(252), 9);
    // Account 3 holds 300 and 100: weights 0.75 and 0.25, HHI 0.5625 + 0.0625.
    expect(out.concentration.herfindahl).toBeCloseTo(0.625, 12);
    expect(out.concentration.top5_share).toBeCloseTo(1, 12);
    expect(out.concentration.position_count).toBe(2);
    expect(out.concentration.top5.map((p) => p.symbol)).toEqual(["AAA", "BBB"]);
    expect(out.scope).toEqual({ all_accounts: false, account_names: ["IBKR"] });
    expect(JSON.stringify(out)).not.toContain("CCC");
    expect(JSON.stringify(out)).not.toContain("Vanguard");
  });

  it("withholds volatility and Sharpe under 30 daily values, with the reason", () => {
    const out = queryRiskTool.run(db, { start_date: day(20) }, { accountIds: [3], today: TODAY }) as RiskOut;
    expect(out.volatility).toBeNull();
    expect(out.sharpe_ratio).toBeNull();
    expect(out.withheld?.volatility_and_sharpe).toMatch(/20 daily values/);
  });

  it("an empty scope answers without calling the engine", () => {
    const out = queryRiskTool.run(db, {}, { accountIds: [], today: TODAY }) as RiskOut;
    expect(out).toEqual({ error: "No account is in this chat's scope." });
    expect(computeRiskMetrics).not.toHaveBeenCalled();
  });

  it("writes nothing and stays under the size cap with 60 positions", () => {
    for (let i = 0; i < 60; i++) addStock(`Z${i}`, 3, 1 + i, 10);
    const before = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const out = queryRiskTool.run(db, {}, { accountIds: undefined, today: TODAY });
    const after = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    expect(after).toBe(before);
    expect(JSON.stringify(out).length).toBeLessThan(COMPOSITE_MAX_JSON_CHARS);
  });
});
