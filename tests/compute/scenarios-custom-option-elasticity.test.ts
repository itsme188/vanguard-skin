import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeScenario, type ScenarioDefinition } from "@/lib/compute/scenarios";
import {
  optionElasticity,
  DEFAULT_OPTION_ELASTICITY,
  type OptionElasticityInputs,
} from "@/lib/compute/option-elasticity";
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

  // Unpriceable option: its underlying ZZNP exists but carries no price row,
  // so elasticity has to fall back to ±DEFAULT_OPTION_ELASTICITY.
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

function callInputs(): OptionElasticityInputs {
  return { ...putInputs(), option_type: "CALL", strike_price: 105 };
}

describe("custom what-if scenarios: options use signed elasticity, not a flat 2x beta", () => {
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
    expect(Math.sign(down.orphanPut.changePercent)).toBe(1);
    expect(Math.sign(up.orphanPut.changePercent)).toBe(-1);
  });

  it("the custom path's option direction is exactly the shared helper's elasticity sign", () => {
    // On an UP move the option moves WITH Ω; on a down move, against it.
    const rate = getRiskFreeRate(db);
    const up = impacts(UP_20);
    expect(Math.sign(up.longPut.changePercent)).toBe(Math.sign(optionElasticity(putInputs(), rate)));
    expect(Math.sign(up.longCall.changePercent)).toBe(Math.sign(optionElasticity(callInputs(), rate)));
  });

  it("the custom leg equals underlying move x elasticity (clamped), not marketMove x 2", () => {
    const rate = getRiskFreeRate(db);
    const { longPut } = impacts(DOWN_20);
    const omega = optionElasticity(putInputs(), rate);
    const expected = Math.max(-1, -0.2 * UNDERLYING_BETA * omega);
    expect(longPut.changePercent).toBeCloseTo(expected, 6);
    // The pre-fix behaviour was a flat -0.4 for every option.
    expect(longPut.changePercent).not.toBeCloseTo(-0.4, 3);
  });

  it("reports the option's LEVERED signed exposure in the beta column", () => {
    const rate = getRiskFreeRate(db);
    const { longPut, longCall } = impacts(DOWN_20);
    expect(longPut.beta).toBeCloseTo(UNDERLYING_BETA * optionElasticity(putInputs(), rate), 6);
    expect(longPut.beta).toBeLessThan(0);
    expect(longCall.beta).toBeCloseTo(UNDERLYING_BETA * optionElasticity(callInputs(), rate), 6);
    expect(longCall.beta).toBeGreaterThan(0);
    // Never the old flat 2.0.
    expect(longPut.beta).not.toBeCloseTo(2, 3);
    expect(longCall.beta).not.toBeCloseTo(2, 3);
  });

  it("an unpriceable option falls back to ±2.5 x the underlying move, signed by put/call", () => {
    const { orphanPut } = impacts(DOWN_20);
    // ZZNP has no sector/style/size → underlying beta 1.0 → move -0.2.
    expect(orphanPut.changePercent).toBeCloseTo(-0.2 * -DEFAULT_OPTION_ELASTICITY, 6);
    expect(orphanPut.beta).toBeCloseTo(-DEFAULT_OPTION_ELASTICITY, 6);
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
});

describe("optionElasticity: expiration spellings", () => {
  // The DB carries BOTH shapes: ISO for most rows, the compact YYYYMMDD on
  // TWS-enriched ones (same two `normalizeExpiration` in
  // lib/compute/options-strategy.ts handles). `new Date("20270115")` is an
  // Invalid Date, so the compact spelling used to make T non-finite and every
  // such option silently took the ±2.5 fallback instead of its real Δ·S/V.
  const RATE = 0.045;

  function isoInputs(): OptionElasticityInputs {
    return {
      option_type: "PUT",
      strike_price: 95,
      expiration_date: addDays(todayET(), 90),
      own_price: 3,
      underlying_price: 100,
      underlying_iv: 0.3,
    };
  }

  /** The same date, spelled YYYYMMDD. */
  function compactInputs(): OptionElasticityInputs {
    const iso = isoInputs();
    return { ...iso, expiration_date: iso.expiration_date!.replace(/-/g, "") };
  }

  it("the compact YYYYMMDD spelling produces the SAME elasticity as the ISO one", () => {
    expect(optionElasticity(compactInputs(), RATE)).toBeCloseTo(
      optionElasticity(isoInputs(), RATE),
      6,
    );
  });

  it("the compact spelling is priced, not dropped onto the ±2.5 fallback", () => {
    const omega = optionElasticity(compactInputs(), RATE);
    expect(omega).toBeLessThan(0); // a put stays signed
    expect(omega).not.toBeCloseTo(-DEFAULT_OPTION_ELASTICITY, 6);
  });

  it("an unrecognized expiration spelling still falls back, signed by put/call", () => {
    const garbled = { ...isoInputs(), expiration_date: "JAN-15-27" };
    expect(optionElasticity(garbled, RATE)).toBeCloseTo(-DEFAULT_OPTION_ELASTICITY, 6);
    expect(optionElasticity({ ...garbled, option_type: "CALL" }, RATE)).toBeCloseTo(
      DEFAULT_OPTION_ELASTICITY,
      6,
    );
  });
});
