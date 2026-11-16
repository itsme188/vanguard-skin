/**
 * What-if review findings of 2026-11-15 (wave S). Synthetic symbols and
 * round figures only.
 *  S-2: a bond FUND with no stored beta takes the bond estimate, by the same
 *       predicate the scenario engine uses to give a bond fund no market move.
 *  S-3: a leveraged fund whose beta is STORED is not multiplied by its factor
 *       again in the beta (the stored beta already carries the leverage);
 *       its sector weight keeps the factor.
 *  S-4: cash equivalents stay in the total but are never a ranked
 *       concentration (owner ruling 2026-11-15).
 *  Near market-neutral: a scope whose net value is under 5% of its gross is
 *       flagged, and no ratio flag is raised on it.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  computeExposureDelta,
  BOND_EQUITY_BETA_ESTIMATE,
  NEAR_NEUTRAL_NET_SHARE,
} from "@/lib/compute/exposure-delta";
import { computeScenario } from "@/lib/compute/scenarios";
import { todayET } from "@/lib/calendar/date-utils";
import { BETA_LOOKBACK_DAYS } from "@/lib/queries/security-betas";

let db: Database.Database;
const today = todayET();
let nextId = 1;

function add(
  symbol: string,
  o: {
    type: string;
    name?: string;
    sector?: string | null;
    fundCategory?: string | null;
    duration?: number | null;
    leverage?: number | null;
    price: number;
    qty?: number;
    beta?: number;
    account?: number;
  },
): number {
  const id = nextId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category, duration_years,
       leverage_factor, currency, multiplier)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', 1)`,
  ).run(
    id,
    symbol,
    o.name ?? `${symbol} Holdings`,
    o.type,
    o.sector ?? null,
    o.fundCategory ?? null,
    o.duration ?? null,
    o.leverage ?? null,
  );
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`).run(
    id,
    today,
    o.price,
  );
  if (o.qty !== undefined) {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (?, ?, ?, ?, ?)`,
    ).run(o.account ?? 3, id, today, o.qty, `sw-${symbol}`);
  }
  if (o.beta !== undefined) {
    db.prepare(
      `INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, ?, ?, ?)`,
    ).run(id, BETA_LOOKBACK_DAYS, o.beta, `${today} 12:00:00`);
  }
  return id;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  nextId = 1;
});

describe("S-2: a bond fund with no stored beta takes the bond estimate", () => {
  it("a bond mutual fund is weighted at the bond figure, flagged as estimated", () => {
    add("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 10, beta: 1 }); // 1,000
    add("ZZBF", { type: "Mutual Fund", name: "ZZ Total Bond Index", fundCategory: "US Aggregate Bond", price: 10, qty: 100 }); // 1,000
    const d = computeExposureDelta(db, "all", undefined, []);
    expect(d.before.beta).toBeCloseTo((1000 + 1000 * BOND_EQUITY_BETA_ESTIMATE) / 2000, 9);
    expect(d.before.betaEstimatedWeight).toBeCloseTo(0.5, 9);
  });

  // Parity with the scenario engine: a fund it gives NO market move (beta 0
  // in its impact) is exactly a fund the What-if gives the bond estimate.
  const FUNDS: Array<{ label: string; o: Parameters<typeof add>[1] }> = [
    { label: "bond-category mutual fund", o: { type: "Mutual Fund", fundCategory: "US Aggregate Bond", price: 10 } },
    { label: "Treasury ETF", o: { type: "ETF", fundCategory: "US Treasury", price: 10 } },
    { label: "Fixed Income sector, no category", o: { type: "ETF", sector: "Fixed Income", price: 10 } },
    { label: "bond category, equity sector", o: { type: "Mutual Fund", fundCategory: "Diversified Bond", sector: "Technology", price: 10 } },
    { label: "bond category, equity name", o: { type: "Mutual Fund", fundCategory: "Diversified Bond", name: "ZZ Equity Income", price: 10 } },
    { label: "bond category, equity name, stored duration", o: { type: "Mutual Fund", fundCategory: "Diversified Bond", name: "ZZ Equity Income", duration: 6, price: 10 } },
    { label: "Stock typed, bond category", o: { type: "Stock", fundCategory: "US Treasury", price: 10 } },
    { label: "equity ETF", o: { type: "ETF", fundCategory: "Large Blend", sector: "Diversified", price: 10 } },
  ];
  for (const { label, o } of FUNDS) {
    it(`agrees with the scenario engine: ${label}`, () => {
      add("ZZF", { ...o, qty: 100 });
      const scenario = computeScenario(
        db,
        { id: "t", name: "t", description: "t", category: "custom", marketMove: -0.1 },
        { accountIds: undefined },
      );
      const noMarketMove = scenario.positionImpacts[0].beta === 0;
      const d = computeExposureDelta(db, "all", undefined, []);
      expect(d.before.beta === BOND_EQUITY_BETA_ESTIMATE).toBe(noMarketMove);
      if (!noMarketMove) expect(d.before.beta).toBe(1);
    });
  }
});

describe("S-3: a stored beta already carries the leverage", () => {
  it("a book that is all a 3x fund with stored beta 3.0 reports 3.0, not 9.0", () => {
    add("ZZL3", { type: "ETF", name: "ZZ 3X Daily Bull", fundCategory: "Leveraged/Inverse", sector: "Technology", leverage: 3, price: 100, qty: 100, beta: 3 });
    const d = computeExposureDelta(db, "all", undefined, []);
    expect(d.before.beta).toBeCloseTo(3, 9);
    // The sector weight keeps the factor: three times the money.
    expect(d.before.sectorWeights.Technology).toBeCloseTo(3, 9);
  });

  it("with no stored beta the factor still applies to the 1.0 estimate", () => {
    add("ZZL3", { type: "ETF", name: "ZZ 3X Daily Bull", fundCategory: "Leveraged/Inverse", sector: "Technology", leverage: 3, price: 100, qty: 100 });
    const d = computeExposureDelta(db, "all", undefined, []);
    expect(d.before.beta).toBeCloseTo(3, 9);
  });
});

describe("S-4: a cash equivalent is not a ranked concentration", () => {
  it("leaves the money-market fund out of the top list and keeps it in the total", () => {
    add("ZZMM", { type: "Mutual Fund", fundCategory: "Money Market", price: 1, qty: 6000 }); // 6,000
    add("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 30, beta: 1 }); // 3,000
    add("ZZB", { type: "Stock", sector: "Energy", price: 100, qty: 10, beta: 1 }); // 1,000
    const d = computeExposureDelta(db, "all", undefined, [{ symbol: "ZZMM", action: "buy", dollarAmount: 1000 }]);
    expect(d.before.topConcentrations.map((c) => c.symbol)).toEqual(["ZZA", "ZZB"]);
    expect(d.before.topConcentrations[0].weightPct).toBeCloseTo(0.3, 9);
    expect(d.after.topConcentrations[0].weightPct).toBeCloseTo(3000 / 11000, 9);
    expect(d.before.totalValue).toBeCloseTo(10_000, 6);
    expect(d.flags.some((f) => f.message.includes("ZZMM"))).toBe(false);
  });
});

describe("near market-neutral scope", () => {
  it("flags a net value under the threshold of gross and raises no ratio flag", () => {
    expect(NEAR_NEUTRAL_NET_SHARE).toBe(0.05);
    add("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 100, beta: 1.2 }); // 10,000
    add("ZZB", { type: "Stock", sector: "Technology", price: 100, qty: -99, beta: 1 }); // -9,900
    const d = computeExposureDelta(db, "all", undefined, []);
    expect(d.before.nearMarketNeutral).toBe(true);
    expect(d.after.nearMarketNeutral).toBe(true);
    expect(d.flags).toEqual([]);
  });

  it("a net-short scope is flagged too", () => {
    add("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 100, beta: 1.2 });
    add("ZZB", { type: "Stock", sector: "Technology", price: 100, qty: -150, beta: 1 });
    const d = computeExposureDelta(db, "all", undefined, []);
    expect(d.before.nearMarketNeutral).toBe(true);
  });

  it("an ordinary long book is not flagged", () => {
    add("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 100, beta: 1 });
    add("ZZB", { type: "Stock", sector: "Energy", price: 100, qty: -10, beta: 1 });
    const d = computeExposureDelta(db, "all", undefined, []);
    expect(d.before.nearMarketNeutral).toBe(false);
  });
});
