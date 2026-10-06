import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeScenario, type ScenarioDefinition } from "@/lib/compute/scenarios";
import { repriceOptionUnderShock } from "@/lib/compute/option-reprice";
import type { OptionElasticityInputs } from "@/lib/compute/option-elasticity";
import { getRiskFreeRate } from "@/lib/queries/risk-free-rate";
import { todayET, addDays } from "@/lib/calendar/date-utils";

/**
 * QA finding `analysis-scenarios--custom-whatif-flat-2x-option-beta-long-puts-
 * lose-in-crash` (2026-09-11, HIGH).
 *
 * The custom what-if path (Analysis → Diagnostics → Scenario Modeling →
 * "Build Custom Scenario", POST /api/compute/scenarios) gave EVERY option a
 * flat beta of 2.0 with no put/call sign, so a -20% market move showed every
 * option — puts and calls alike — at exactly -40%. The same long put rendered
 * a GAIN on the preset "Rate shock" card of the same page, because the recipe
 * engine levers the underlying move by signed elasticity Ω = Δ·S/V.
 *
 * Both engines now share lib/compute/option-elasticity.ts: a held put is
 * protection that gains when the market falls.
 *
 * Sibling finding in the same function:
 * `analysis-scenarios--vmfxx-money-market-modeled-as-rate-shock-loser` — a
 * money-market fund typed 'Mutual Fund' took the full market move because the
 * beta heuristic only zeroed the literal 'bond' / 'money market' type strings.
 *
 * All figures here are synthetic (ZZ* tickers, round numbers).
 */

const STOCK_ID = 1;
const LONG_PUT_ID = 2;
const LONG_CALL_ID = 3;
const SHORT_PUT_ID = 4;
const ORPHAN_PUT_ID = 5;
const ORPHAN_UNDERLYING_ID = 6;
const MMF_ID = 7;
const PRICELESS_PUT_ID = 8;

/** Technology + no style/size tilt → estimateBeta = 1.15. */
const UNDERLYING_BETA = 1.15;

const DOWN_20: ScenarioDefinition = {
  id: "custom-down-20",
  name: "Custom -20%",
  description: "synthetic custom what-if",
  category: "custom",
  marketMove: -0.2,
};

const UP_20: ScenarioDefinition = { ...DOWN_20, id: "custom-up-20", marketMove: 0.2 };

function seed(db: Database.Database) {
  const today = todayET();
  const expiry = addDays(today, 90);

  // Underlying: ZZUL, Technology, $100.
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector) VALUES (?, 'ZZUL', 'Zulu Systems', 'Stock', 'Technology')`
  ).run(STOCK_ID);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 100, 'test')`).run(STOCK_ID, today);
  db.prepare(`INSERT INTO security_quotes (security_id, as_of_date, iv_underlying) VALUES (?, ?, 0.30)`).run(STOCK_ID, today);
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, 100, 'h-zzul')`
  ).run(STOCK_ID, today);

  // Long put, 2 contracts, K=95, $3/share → $600 of protection.
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, underlying_symbol, strike_price, expiration_date, option_type, multiplier)
     VALUES (?, 'ZZUL  PUT95', 'Option', 'ZZUL', 95, ?, 'PUT', 100)`
  ).run(LONG_PUT_ID, expiry);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 3, 'test')`).run(LONG_PUT_ID, today);
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, 2, 'h-zzul-put95')`
  ).run(LONG_PUT_ID, today);

  // Long call, 1 contract, K=105, $3/share → $300.
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, underlying_symbol, strike_price, expiration_date, option_type, multiplier)
     VALUES (?, 'ZZUL  CALL105', 'Option', 'ZZUL', 105, ?, 'CALL', 100)`
  ).run(LONG_CALL_ID, expiry);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 3, 'test')`).run(LONG_CALL_ID, today);
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, 1, 'h-zzul-call105')`
  ).run(LONG_CALL_ID, today);

  // SHORT put, -1 contract, K=90, $2/share → market value -$200.
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, underlying_symbol, strike_price, expiration_date, option_type, multiplier)
     VALUES (?, 'ZZUL  PUT90', 'Option', 'ZZUL', 90, ?, 'PUT', 100)`
  ).run(SHORT_PUT_ID, expiry);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 2, 'test')`).run(SHORT_PUT_ID, today);
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, -1, 'h-zzul-put90-short')`
  ).run(SHORT_PUT_ID, today);

  // Unrepriceable option: its underlying ZZNP exists but carries no price row,
  // so repricing cannot run and the row is reported as unmodelled.
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type) VALUES (?, 'ZZNP', 'Zulu No-Price', 'Stock')`
  ).run(ORPHAN_UNDERLYING_ID);
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, underlying_symbol, strike_price, expiration_date, option_type, multiplier)
     VALUES (?, 'ZZNP  PUT50', 'Option', 'ZZNP', 50, ?, 'PUT', 100)`
  ).run(ORPHAN_PUT_ID, expiry);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 4, 'test')`).run(ORPHAN_PUT_ID, today);
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, 1, 'h-zznp-put50')`
  ).run(ORPHAN_PUT_ID, today);

  // Option with no price row of its own: kept by the query, listed as unmodelled.
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, underlying_symbol, strike_price, expiration_date, option_type, multiplier)
     VALUES (?, 'ZZUL  PUT90B', 'Option', 'ZZUL', 90, ?, 'PUT', 100)`
  ).run(PRICELESS_PUT_ID, expiry);
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, 1, 'h-zzul-put90-priceless')`
  ).run(PRICELESS_PUT_ID, today);

  // Money-market sweep fund the broker typed 'Mutual Fund' — identity lives
  // in fund_category, exactly like the live VMFXX rows.
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, fund_category) VALUES (?, 'ZZMM', 'Zulu Cash Reserves', 'Mutual Fund', 'Cash Equivalent')`
  ).run(MMF_ID);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 1, 'test')`).run(MMF_ID, today);
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, 1000, 'h-zzmm')`
  ).run(MMF_ID, today);
}

/** The same contract, shaped for a direct call to the shared helper. */
function putInputs(): OptionElasticityInputs {
  return {
    option_type: "PUT",
    strike_price: 95,
    expiration_date: addDays(todayET(), 90),
    own_price: 3,
    underlying_price: 100,
    underlying_iv: 0.3,
  };
}

describe("custom what-if scenarios: options are repriced, not scaled by a flat beta", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seed(db);
  });

  function impacts(scenario: ScenarioDefinition) {
    const result = computeScenario(db, scenario);
    const bySymbol = new Map(result.positionImpacts.map((p) => [p.symbol, p]));
    return {
      result,
      stock: bySymbol.get("ZZUL")!,
      longPut: bySymbol.get("ZZUL  PUT95")!,
      longCall: bySymbol.get("ZZUL  CALL105")!,
      shortPut: bySymbol.get("ZZUL  PUT90")!,
      orphanPut: bySymbol.get("ZZNP  PUT50")!,
      mmf: bySymbol.get("ZZMM")!,
    };
  }

  it("a long put GAINS in a -20% custom shock (it is protection, not a 2x long)", () => {
    const { longPut } = impacts(DOWN_20);
    expect(longPut.changePercent).toBeGreaterThan(0);
    expect(longPut.estimatedChange).toBeGreaterThan(0);
  });

  it("a long call LOSES in the same shock, floored at -100%", () => {
    const { longCall } = impacts(DOWN_20);
    expect(longCall.changePercent).toBeLessThan(0);
    expect(longCall.changePercent).toBeGreaterThanOrEqual(-1);
  });

  it("a SHORT put loses money in the shock even though its changePercent is positive", () => {
    const { shortPut } = impacts(DOWN_20);
    expect(shortPut.currentValue).toBeLessThan(0);
    expect(shortPut.changePercent).toBeGreaterThan(0);
    expect(shortPut.estimatedChange).toBeLessThan(0);
  });

  it("no position can lose more than 100% of its value", () => {
    for (const scenario of [DOWN_20, UP_20]) {
      const { result } = impacts(scenario);
      for (const pos of result.positionImpacts) {
        expect(pos.changePercent).toBeGreaterThanOrEqual(-1);
      }
    }
  });

  it("every option sign flips when the market move flips", () => {
    const down = impacts(DOWN_20);
    const up = impacts(UP_20);
    expect(Math.sign(down.longPut.changePercent)).toBe(1);
    expect(Math.sign(up.longPut.changePercent)).toBe(-1);
    expect(Math.sign(down.longCall.changePercent)).toBe(-1);
    expect(Math.sign(up.longCall.changePercent)).toBe(1);
  });

  it("an option inherits the underlying's classification (sector), never its own null sector", () => {
    const { longPut, stock } = impacts(DOWN_20);
    expect(stock.sector).toBe("Technology");
    expect(longPut.sector).toBe("Technology");
  });

  it("non-option behaviour is unchanged: the stock still takes marketMove x sector beta", () => {
    const { stock } = impacts(DOWN_20);
    expect(stock.changePercent).toBeCloseTo(-0.2 * UNDERLYING_BETA, 6);
    expect(stock.beta).toBeCloseTo(UNDERLYING_BETA, 6);
  });

  it("a money-market fund typed 'Mutual Fund' is cash: beta 0, no market-shock loss", () => {
    const { mmf } = impacts(DOWN_20);
    expect(mmf.beta).toBe(0);
    expect(mmf.changePercent).toBe(0);
    expect(mmf.estimatedChange).toBe(0);
  });

  it("an option's change is the shared repricing result (engine and module agree)", () => {
    const res = computeScenario(db, DOWN_20);
    const longPut = res.positionImpacts.find((p) => p.securityId === LONG_PUT_ID)!;
    const expected = repriceOptionUnderShock(putInputs(), {
      underlyingMove: -0.2 * UNDERLYING_BETA,
      riskFreeRate: getRiskFreeRate(db),
    });
    if (!expected.modelled) throw new Error("fixture must be modelled");
    expect(longPut.changePercent).toBeCloseTo(expected.changePercent, 10);
    expect(longPut.ivSource).toBe(expected.ivSource);
    expect(longPut.estimatedChange).toBeCloseTo(longPut.currentValue * expected.changePercent, 8);
  });

  it("a long put gains and a long call loses on a down move; a short put loses dollars", () => {
    const res = computeScenario(db, DOWN_20);
    const by = (id: number) => res.positionImpacts.find((p) => p.securityId === id)!;
    expect(by(LONG_PUT_ID).estimatedChange).toBeGreaterThan(0);
    expect(by(LONG_CALL_ID).estimatedChange).toBeLessThan(0);
    expect(by(SHORT_PUT_ID).currentValue).toBeLessThan(0);
    expect(by(SHORT_PUT_ID).estimatedChange).toBeLessThan(0);
  });

  it("a zero move with no volatility change leaves every option unchanged", () => {
    const res = computeScenario(db, { ...DOWN_20, id: "custom-flat", marketMove: 0 });
    for (const p of res.positionImpacts.filter((x) => x.securityType === "Option" && !x.unmodelledReason)) {
      if (p.ivSource === "own-price") expect(p.estimatedChange).toBeCloseTo(0, 10); // a short row gives -0
    }
  });

  it("the volatility slider moves option rows only", () => {
    const base = computeScenario(db, DOWN_20);
    const bumped = computeScenario(db, { ...DOWN_20, volMove: 20 });
    const stock = (r: typeof base) => r.positionImpacts.find((p) => p.securityId === STOCK_ID)!;
    expect(stock(bumped).estimatedChange).toBe(stock(base).estimatedChange);
    const put = (r: typeof base) => r.positionImpacts.find((p) => p.securityId === LONG_PUT_ID)!;
    expect(put(bumped).estimatedChange).toBeGreaterThan(put(base).estimatedChange);
  });

  it("an option that cannot be repriced is listed, adds nothing, and is counted", () => {
    const res = computeScenario(db, DOWN_20);
    const orphan = res.positionImpacts.find((p) => p.securityId === ORPHAN_PUT_ID)!;
    expect(orphan.unmodelledReason).toBe("no-underlying-price");
    expect(orphan.estimatedChange).toBe(0);
    expect(orphan.changePercent).toBe(0);
    const priceless = res.positionImpacts.find((p) => p.securityId === PRICELESS_PUT_ID)!;
    expect(priceless.unmodelledReason).toBe("no-option-price");
    expect(priceless.currentValue).toBe(0);
    expect(res.optionsUnmodelled.count).toBe(2);
    expect(res.optionsUnmodelled.valueShare).toBeGreaterThan(0);
  });

  it("the scenario total equals the sum of the rows", () => {
    const res = computeScenario(db, { ...DOWN_20, volMove: 10 });
    const sum = res.positionImpacts.reduce((s, p) => s + p.estimatedChange, 0);
    expect(res.estimatedChange).toBeCloseTo(sum, 8);
  });

  it("all options unmodelled: the result still computes and the total ties", () => {
    db.prepare(`DELETE FROM prices WHERE security_id = ?`).run(STOCK_ID); // every ZZUL option loses its underlying price
    const res = computeScenario(db, DOWN_20);
    const options = res.positionImpacts.filter((p) => p.securityType === "Option");
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((p) => p.unmodelledReason)).toBe(true);
    expect(res.optionsUnmodelled.count).toBe(options.length);
    expect(res.estimatedChange).toBeCloseTo(res.positionImpacts.reduce((s, p) => s + p.estimatedChange, 0), 8);
  });
});
