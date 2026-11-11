/**
 * query_scenarios (Portfolio Assistant plan, Task 6).
 *
 * Protects: the stress figures the chat quotes are the scenarios card's own
 * (computeAllScenarios with the chat's account ids), unmodelled positions are
 * counted, never given a figure. Bound: a bond with a stored 2-year duration
 * under the +25bp rate shock moves by value x (exp(-2 x 0.0025) - 1) to the
 * cent; an empty scope never reaches the engine.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/compute/scenarios", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compute/scenarios")>();
  return { ...actual, computeAllScenarios: vi.fn(actual.computeAllScenarios) };
});

import { computeAllScenarios } from "@/lib/compute/scenarios";
import { queryScenariosTool } from "@/lib/chat/composite/scenarios";
import { COMPOSITE_MAX_JSON_CHARS } from "@/lib/chat/composite/shared";
import { todayET } from "@/lib/calendar/date-utils";

let db: Database.Database;
const TODAY = todayET();

function addSecurity(
  symbol: string,
  type: string,
  accountId: number,
  qty: number,
  price: number,
  extra: { duration?: number; sector?: string } = {},
): void {
  const id = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, currency, duration_years, sector, maturity_date) VALUES (?, ?, ?, 'USD', ?, ?, ?)",
    )
    .run(symbol, `${symbol} Holding`, type, extra.duration ?? null, extra.sector ?? null, type === "Bond" ? "2030-06-30" : null)
    .lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(accountId, id, qty, 1, TODAY, `h-${symbol}-${accountId}`);
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(id, TODAY, price);
}

type Shaped = {
  id: string;
  current_value_usd: number;
  estimated_change_usd: number;
  estimated_change_fraction: number;
  biggest_losers: { symbol: string; change_usd: number }[];
  unmodelled: { options: { count: number }; bonds: { count: number } };
};
type Out = { error?: string; scenarios: Shaped[]; scope: { account_names: string[] } };

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.mocked(computeAllScenarios).mockClear();
  // Account 1: one Treasury-style bond, face 10,000 at 100 => value 10,000.
  addSecurity("TBOND", "Bond", 1, 10000, 100, { duration: 2 });
  // Account 3: stocks the account-1 answer must never name.
  addSecurity("AAA", "Stock", 3, 30, 10, { sector: "Technology" });
  addSecurity("BBB", "Stock", 3, 10, 10, { sector: "Utilities" });
});

describe("query_scenarios", () => {
  it("returns the engine's figures for every preset (parity)", () => {
    const out = queryScenariosTool.run(db, {}, { accountIds: [3], today: TODAY }) as Out;
    const engine = computeAllScenarios(db, { accountIds: [3] });
    expect(out.scenarios.map((s) => s.id)).toEqual(engine.map((r) => r.scenario.id));
    out.scenarios.forEach((s, i) => {
      expect(s.current_value_usd).toBe(engine[i].currentPortfolioValue);
      expect(s.estimated_change_usd).toBe(engine[i].estimatedChange);
      expect(s.estimated_change_fraction).toBe(engine[i].estimatedChangePercent);
      expect(s.biggest_losers.map((l) => l.symbol)).toEqual(engine[i].biggestLosers.slice(0, 3).map((l) => l.symbol));
      expect(s.unmodelled.options.count).toBe(engine[i].optionsUnmodelled.count);
      expect(s.unmodelled.bonds.count).toBe(engine[i].bondsUnmodelled.count);
    });
  });

  it("matches the hand-worked rate shock on a 2-year-duration bond", () => {
    const out = queryScenariosTool.run(db, { scenario_id: "rate_shock_up_25bp" }, { accountIds: [1], today: TODAY }) as Out;
    expect(out.scenarios).toHaveLength(1);
    const s = out.scenarios[0];
    expect(s.current_value_usd).toBeCloseTo(10000, 6);
    // 10,000 x (exp(-0.005) - 1) = -49.875...
    expect(s.estimated_change_usd).toBeCloseTo(10000 * (Math.exp(-2 * 0.0025) - 1), 2);
    expect(out.scope.account_names).toEqual(["Vanguard Taxable"]);
    const text = JSON.stringify(out);
    expect(text).not.toContain("AAA");
    expect(text).not.toContain("IBKR");
  });

  it("refuses an unknown scenario id with the valid list", () => {
    const out = queryScenariosTool.run(db, { scenario_id: "spx_minus_20" }, { accountIds: undefined, today: TODAY }) as Out;
    expect(out.error).toMatch(/Unknown scenario_id 'spx_minus_20'.*rate_shock_up_25bp/);
  });

  it("an empty scope answers without calling the engine", () => {
    const out = queryScenariosTool.run(db, {}, { accountIds: [], today: TODAY });
    expect(out).toEqual({ error: "No account is in this chat's scope." });
    expect(computeAllScenarios).not.toHaveBeenCalled();
  });

  it("writes nothing and stays under the size cap with 60 positions", () => {
    for (let i = 0; i < 60; i++) addSecurity(`Z${i}`, "Stock", 3, 1 + i, 10, { sector: "Technology" });
    const before = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const out = queryScenariosTool.run(db, {}, { accountIds: undefined, today: TODAY });
    const after = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    expect(after).toBe(before);
    expect(JSON.stringify(out).length).toBeLessThan(COMPOSITE_MAX_JSON_CHARS);
    const one = queryScenariosTool.run(db, { scenario_id: "semi_cycle_minus_15pct" }, { accountIds: undefined, today: TODAY });
    expect(JSON.stringify(one).length).toBeLessThan(COMPOSITE_MAX_JSON_CHARS);
  });
});
