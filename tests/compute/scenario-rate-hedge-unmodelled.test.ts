import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeScenario, PRESET_SCENARIOS, type ScenarioResult } from "@/lib/compute/scenarios";
import { isInterestRateHedgeFund, summarizeUnmodelledRateHedges } from "@/lib/compute/rate-hedge";
import { todayET } from "@/lib/calendar/date-utils";

/**
 * Owner ruling (2026-10-12, option 1): a fund built to GAIN when long rates
 * rise is never given the rate-sensitive loss, nor a sign-inverted figure. In
 * any scenario that moves rates it takes no figure and is named and counted
 * under `rateHedgesUnmodelled`. Synthetic figures only.
 */

describe("isInterestRateHedgeFund", () => {
  const base = { security_type: "ETF", fund_category: null as string | null, name: "Synthetic Fund" as string | null };

  it("matches a fund by its category, case-insensitively", () => {
    expect(isInterestRateHedgeFund({ ...base, fund_category: "Interest Rate Hedge" })).toBe(true);
    expect(isInterestRateHedgeFund({ ...base, fund_category: " interest rate hedge " })).toBe(true);
    expect(isInterestRateHedgeFund({ ...base, security_type: "Mutual Fund", fund_category: "INTEREST RATE HEDGE" })).toBe(true);
  });

  it("matches a fund by the whole phrase 'rate hedge' in its name", () => {
    expect(isInterestRateHedgeFund({ ...base, name: "Synthetic Interest Rate Hedge ETF" })).toBe(true);
    expect(isInterestRateHedgeFund({ ...base, security_type: "etf", name: "ZZ RATE HEDGE fund" })).toBe(true);
    expect(isInterestRateHedgeFund({ ...base, name: "ZZ Corporate Hedged Bond" })).toBe(false);
    expect(isInterestRateHedgeFund({ ...base, name: "ZZ Exchange Rate Hedged Equity" })).toBe(false);
  });

  it("does not match a non-fund, whatever its name or category", () => {
    expect(isInterestRateHedgeFund({ security_type: "Stock", fund_category: null, name: "Synthetic Interest Rate Hedge ETF" })).toBe(false);
    expect(isInterestRateHedgeFund({ security_type: "Option", fund_category: "Interest Rate Hedge", name: "RHDG call" })).toBe(false);
    expect(isInterestRateHedgeFund({ security_type: "Bond", fund_category: "Interest Rate Hedge", name: null })).toBe(false);
  });

  it("does not match a bond fund with another category", () => {
    expect(isInterestRateHedgeFund({ security_type: "ETF", fund_category: "US Aggregate Bond", name: "ZZ Aggregate Bond ETF" })).toBe(false);
    expect(isInterestRateHedgeFund({ security_type: "ETF", fund_category: null, name: null })).toBe(false);
  });
});

describe("summarizeUnmodelledRateHedges", () => {
  it("counts flagged rows, sorts their symbols and gives their share of the book", () => {
    expect(
      summarizeUnmodelledRateHedges([
        { symbol: "ZZB", currentValue: 3000, rateHedgeUnmodelled: true },
        { symbol: "ZZA", currentValue: 1000, rateHedgeUnmodelled: true },
        { symbol: "ZZC", currentValue: 6000 },
      ]),
    ).toEqual({ count: 2, valueShare: 0.4, symbols: ["ZZA", "ZZB"] });
    expect(summarizeUnmodelledRateHedges([])).toEqual({ count: 0, valueShare: 0, symbols: [] });
  });
});

describe("scenario engines: a rate hedge fund is not modelled under a rate move", () => {
  let db: Database.Database;
  const HEDGE = 1;
  const EQUITY = 2;

  function seed(id: number, symbol: string, name: string, type: string, sector: string | null, fundCategory: string | null) {
    const today = todayET();
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, symbol, name, type, sector, fundCategory);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 50, 'test')`).run(id, today);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, 200, ?)`,
    ).run(id, today, `h-${id}`);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare(`INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test')`).run();
    seed(HEDGE, "RHDG", "Synthetic Interest Rate Hedge ETF", "ETF", null, "Interest Rate Hedge");
    seed(EQUITY, "ZZEQ", "ZZ Growth Corp", "Stock", "Technology", null);
    const factors = db.prepare(
      `INSERT INTO security_factors (security_id, interest_rate_sensitive, growth_vs_value) VALUES (?, ?, ?)`,
    );
    factors.run(HEDGE, "High", "Blend");
    factors.run(EQUITY, "Moderate", "Growth");
  });

  const rowOf = (res: ScenarioResult, id: number) => res.positionImpacts.find((p) => p.securityId === id)!;
  const preset = (id: string) => PRESET_SCENARIOS.find((p) => p.id === id)!;

  it("rate preset: the hedge takes no figure and is disclosed; the equity keeps its figure", () => {
    const res = computeScenario(db, preset("rate_shock_up_25bp"));
    const hedge = rowOf(res, HEDGE);
    expect(hedge.currentValue).toBeCloseTo(10_000, 8);
    expect(hedge.changePercent).toBe(0);
    expect(hedge.estimatedChange).toBe(0);
    expect(hedge.rateHedgeUnmodelled).toBe(true);
    expect(hedge.bondUnmodelledReason).toBeUndefined();
    expect(res.rateHedgesUnmodelled).toEqual({ count: 1, valueShare: 0.5, symbols: ["RHDG"] });

    // ZZEQ: Moderate (0.50) + 0.5 x Growth (1.00) = 1.00 -> -2.5% of 10,000.
    const eq = rowOf(res, EQUITY);
    expect(eq.changePercent).toBeCloseTo(-0.025, 12);
    expect(eq.rateHedgeUnmodelled).toBeUndefined();
    expect(res.estimatedChange).toBeCloseTo(-250, 8);
  });

  it("a scenario with no rate component leaves the hedge as it was", () => {
    const crash = computeScenario(db, {
      id: "custom",
      name: "c",
      description: "",
      category: "custom",
      marketMove: -0.1,
    });
    const hedge = rowOf(crash, HEDGE);
    expect(hedge.rateHedgeUnmodelled).toBeUndefined();
    expect(hedge.changePercent).toBeCloseTo(-0.1, 12); // beta 1.0, no sector, no style
    expect(crash.rateHedgesUnmodelled.count).toBe(0);
    expect(crash.rateHedgesUnmodelled.symbols).toEqual([]);

    // A non-rate preset: the hedge is not flagged there either.
    const other = computeScenario(db, preset("usd_strength_5pct"));
    expect(rowOf(other, HEDGE).rateHedgeUnmodelled).toBeUndefined();
    expect(other.rateHedgesUnmodelled.count).toBe(0);
  });

  it("custom scenario with a rate move discloses the hedge and gives it no figure", () => {
    const res = computeScenario(db, {
      id: "custom",
      name: "c",
      description: "",
      category: "custom",
      marketMove: -0.05,
      rateMove: 100,
    });
    const hedge = rowOf(res, HEDGE);
    expect(hedge.changePercent).toBe(0);
    expect(hedge.estimatedChange).toBe(0);
    expect(hedge.rateHedgeUnmodelled).toBe(true);
    expect(res.rateHedgesUnmodelled).toEqual({ count: 1, valueShare: 0.5, symbols: ["RHDG"] });
    // The equity keeps its market leg (Technology 1.15 x -5%).
    expect(rowOf(res, EQUITY).changePercent).toBeCloseTo(-0.05 * 1.15, 12);
  });
});
