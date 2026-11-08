import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeScenario, PRESET_SCENARIOS, type ScenarioResult } from "@/lib/compute/scenarios";
import { computeRecipeScenario, findRecipe } from "@/lib/compute/scenario-recipes";
import { computeExposureDelta } from "@/lib/compute/exposure-delta";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";
import { resolveLeveragedExposure, normalizeLeverageFactor } from "@/lib/compute/leveraged-fund";
import { applyLeverageFactors } from "@/lib/securities/apply-leverage-factors";
import { todayET, addDays } from "@/lib/calendar/date-utils";

/**
 * Theme T2, the durable signed leverage factor (sign table approved by the
 * owner 2026-11-07). Every test here is seeded on one of the QA findings the
 * build exists to close:
 *
 *   #1  a 3x INVERSE semiconductor fund was modelled as a plain long, so in a
 *       semis -15% scenario it fell ~27.6% and printed as the biggest loser —
 *       the hedge shown as the casualty. It must now GAIN.
 *   #10 a +2x crude fund was modelled 1x.
 *   #44 a 3x bear semiconductor fund was classified Financials.
 *   (h) Defense counted a long inverse ETF as LONG exposure.
 *
 * Synthetic symbols and round figures only.
 */

const today = todayET();

describe("resolveLeveragedExposure / normalizeLeverageFactor", () => {
  const fund = (leverage_factor: number | null) => ({
    security_type: "ETF",
    fund_category: "Leveraged/Inverse",
    name: "ZZ 3X BEAR FUND",
    leverage_factor,
  });

  it("gives a flagged row its own factor", () => {
    expect(resolveLeveragedExposure(fund(-3), null)).toEqual({ flagged: true, factor: -3 });
  });

  it("gives an OPTION its underlying's factor, and a non-option never looks through", () => {
    const call = { security_type: "Option", fund_category: "Options", name: "ZZ call", leverage_factor: null };
    expect(resolveLeveragedExposure(call, fund(2))).toEqual({ flagged: true, factor: 2 });
    const stock = { security_type: "Stock", fund_category: null, name: "AAA Corp", leverage_factor: null };
    expect(resolveLeveragedExposure(stock, fund(2))).toEqual({ flagged: false, factor: null });
  });

  it("a flagged row with no factor is flagged with a null factor — the stopgap", () => {
    expect(resolveLeveragedExposure(fund(null), null)).toEqual({ flagged: true, factor: null });
  });

  it("refuses an unusable stored figure rather than carrying it", () => {
    expect(normalizeLeverageFactor(0)).toBeNull();
    expect(normalizeLeverageFactor(NaN)).toBeNull();
    expect(normalizeLeverageFactor(Infinity)).toBeNull();
    expect(normalizeLeverageFactor(99)).toBeNull();
    expect(normalizeLeverageFactor("3" as unknown)).toBeNull();
    expect(normalizeLeverageFactor(null)).toBeNull();
    expect(normalizeLeverageFactor(-3)).toBe(-3);
    expect(normalizeLeverageFactor(1.5)).toBe(1.5);
    // An unusable figure falls back to the stopgap, never to 1x.
    expect(resolveLeveragedExposure(fund(0), null)).toEqual({ flagged: true, factor: null });
  });
});

/** A book of three semiconductor positions that differ ONLY in their factor. */
function seedSemiBook(db: Database.Database): { BEAR: number; BULL: number; PLAIN: number; UNSIGNED: number } {
  const ids = { BEAR: 1, BULL: 2, PLAIN: 3, UNSIGNED: 4 };
  db.prepare(`INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test')`).run();
  const sec = db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category, leverage_factor)
     VALUES (?, ?, ?, 'Stock', 'Technology', ?, ?)`,
  );
  sec.run(ids.BEAR, "ZZS", "DIREX DAI SEMI BE 3X ETF-USD", null, -3);
  sec.run(ids.BULL, "ZZL", "DIREX DAIL SEMI BU 3X ET-USD", null, 3);
  // Same type / sector / style, so its beta is identical: the 1x yardstick.
  sec.run(ids.PLAIN, "AAA", "AAA Semi Corp", null, null);
  sec.run(ids.UNSIGNED, "ZZN", "ZZ NO MULTIPLE FUND", "Leveraged/Inverse", null);
  const px = db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 50, 'test')`);
  const h = db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, 200, ?)`,
  );
  for (const id of Object.values(ids)) {
    px.run(id, today);
    h.run(id, today, `h-${id}`);
  }
  const fac = db.prepare(`INSERT INTO security_factors (security_id, tariff_exposure, ai_exposure) VALUES (?, 'High', 'Very High')`);
  for (const id of Object.values(ids)) fac.run(id);
  return ids;
}

describe("QA #1: a 3x inverse semiconductor fund GAINS in a semis -15% scenario", () => {
  let db: Database.Database;
  let ids: ReturnType<typeof seedSemiBook>;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    ids = seedSemiBook(db);
  });

  const rowOf = (res: ScenarioResult, id: number) => res.positionImpacts.find((p) => p.securityId === id)!;

  function expectSignedAndScaled(res: ScenarioResult) {
    const bear = rowOf(res, ids.BEAR);
    const bull = rowOf(res, ids.BULL);
    const plain = rowOf(res, ids.PLAIN);

    // The shock really is a fall for an ordinary semiconductor name.
    expect(plain.changePercent).toBeLessThan(0);

    // THE FINDING: the hedge gains, and it is no longer the biggest loser.
    expect(bear.changePercent).toBeGreaterThan(0);
    expect(bear.estimatedChange).toBeGreaterThan(0);
    expect(res.biggestLosers.map((p) => p.symbol)).not.toContain("ZZS");
    expect(res.biggestWinners.map((p) => p.symbol)).toContain("ZZS");

    // Exactly three times the 1x move, with the sign flipped.
    expect(bear.changePercent).toBeCloseTo(-3 * plain.changePercent, 10);
    expect(bull.changePercent).toBeCloseTo(3 * plain.changePercent, 10);

    // A signed fund is modelled, so it is no longer disclosed as not
    // modelled — only the flagged fund with no factor is.
    expect(bear.leveragedFundUnmodelled).toBeUndefined();
    expect(bull.leveragedFundUnmodelled).toBeUndefined();
    expect(res.leveragedFundsUnmodelled.symbols).toEqual(["ZZN"]);
  }

  it("custom engine, semis preset", () => {
    expectSignedAndScaled(computeScenario(db, PRESET_SCENARIOS.find((p) => p.id === "semi_cycle_minus_15pct")!));
  });

  it("custom engine, plain market -10%", () => {
    expectSignedAndScaled(
      computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove: -0.1 }),
    );
  });

  it("recipe engine, semis preset", () => {
    const res = computeRecipeScenario(db, findRecipe("semi_cycle_minus_15pct")!);
    const bear = res.positionImpacts.find((p) => p.securityId === ids.BEAR)!;
    const plain = res.positionImpacts.find((p) => p.securityId === ids.PLAIN)!;
    expect(plain.changePercent).toBeLessThan(0);
    expect(bear.changePercent).toBeGreaterThan(0);
    expect(bear.changePercent).toBeCloseTo(-3 * plain.changePercent, 10);
    expect(res.leveragedFundsUnmodelled.symbols).toEqual(["ZZN"]);
  });

  it("a 3x fund never loses more than its whole NAV", () => {
    // A +40% rally would be -120% for a -3x fund.
    const res = computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove: 0.4 });
    const bear = res.positionImpacts.find((p) => p.securityId === ids.BEAR)!;
    expect(bear.changePercent).toBe(-1);
    expect(bear.estimatedNewValue).toBeCloseTo(0, 8);
  });
});

describe("QA #10: a +2x crude fund moves twice its index", () => {
  let db: Database.Database;
  const LEV = 1;
  const PLAIN = 2;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare(`INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test')`).run();
    const sec = db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category, leverage_factor)
       VALUES (?, ?, ?, 'ETF', 'Energy', ?, ?)`,
    );
    sec.run(LEV, "ZZU", "PROSHARES ULTRA BLOOMBERG CR", "Leveraged/Inverse (Commodities)", 2);
    sec.run(PLAIN, "AAA", "AAA Energy Fund", "Energy", null);
    const px = db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 50, 'test')`);
    const h = db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, 200, ?)`,
    );
    const fac = db.prepare(`INSERT INTO security_factors (security_id, cyclical) VALUES (?, 'Very High')`);
    for (const id of [LEV, PLAIN]) {
      px.run(id, today);
      h.run(id, today, `h-${id}`);
      fac.run(id);
    }
  });

  it("oil shock, recipe engine: twice the plain fund's move", () => {
    const res = computeRecipeScenario(db, findRecipe("oil_shock_10dollar")!);
    const lev = res.positionImpacts.find((p) => p.securityId === LEV)!;
    const plain = res.positionImpacts.find((p) => p.securityId === PLAIN)!;
    expect(plain.changePercent).toBeGreaterThan(0);
    expect(lev.changePercent).toBeCloseTo(2 * plain.changePercent, 10);
    expect(res.leveragedFundsUnmodelled).toEqual({ count: 0, valueShare: 0, symbols: [] });
  });

  it("oil shock, custom engine: twice the plain fund's move", () => {
    const res = computeScenario(db, PRESET_SCENARIOS.find((p) => p.id === "oil_shock_10dollar")!);
    const lev = res.positionImpacts.find((p) => p.securityId === LEV)!;
    const plain = res.positionImpacts.find((p) => p.securityId === PLAIN)!;
    expect(lev.changePercent).toBeCloseTo(2 * plain.changePercent, 10);
  });
});

describe("an option on a +2x fund is repriced at the FUND's move, not its index's", () => {
  let db: Database.Database;
  const LEV_FUND = 1;
  const LEV_CALL = 2;
  const PLAIN_ETF = 3;
  const PLAIN_CALL = 4;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const expiry = addDays(today, 90);
    db.prepare(`INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test')`).run();
    const fund = db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category, leverage_factor)
       VALUES (?, ?, ?, 'ETF', 'Energy', ?, ?)`,
    );
    fund.run(LEV_FUND, "ZZZ", "PROSHARES ULTRA BLOOMBERG CR", "Leveraged/Inverse (Commodities)", 2);
    fund.run(PLAIN_ETF, "AAA", "AAA Energy ETF", "Energy", null);
    const opt = db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, underlying_symbol, strike_price, expiration_date, option_type, multiplier, fund_category)
       VALUES (?, ?, ?, 'Option', ?, 60, ?, 'CALL', 100, 'Options')`,
    );
    opt.run(LEV_CALL, "ZZZ 261120C00065000", "ZZZ call", "ZZZ", expiry);
    opt.run(PLAIN_CALL, "AAA 261120C00060000", "AAA call", "AAA", expiry);
    const px = db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')`);
    px.run(LEV_FUND, today, 60);
    px.run(PLAIN_ETF, today, 60);
    px.run(LEV_CALL, today, 5);
    px.run(PLAIN_CALL, today, 5);
    const h = db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, 2, ?)`,
    );
    h.run(LEV_CALL, today, "h-lev-call");
    h.run(PLAIN_CALL, today, "h-plain-call");
  });

  it("custom engine: the call's underlying move is exactly twice the plain call's", () => {
    const res = computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove: 0.1 });
    const lev = res.positionImpacts.find((p) => p.securityId === LEV_CALL)!;
    const plain = res.positionImpacts.find((p) => p.securityId === PLAIN_CALL)!;
    expect(plain.underlyingMove).toBeGreaterThan(0);
    expect(lev.underlyingMove).toBeCloseTo(2 * plain.underlyingMove!, 10);
    // And the contract itself is worth more than the one on the 1x fund.
    expect(lev.changePercent).toBeGreaterThan(plain.changePercent);
    expect(lev.leveragedFundUnmodelled).toBeUndefined();
    expect(res.leveragedFundsUnmodelled).toEqual({ count: 0, valueShare: 0, symbols: [] });
  });

  it("recipe engine (oil shock): the same inheritance", () => {
    const res = computeRecipeScenario(db, findRecipe("oil_shock_10dollar")!);
    const lev = res.positionImpacts.find((p) => p.securityId === LEV_CALL)!;
    const plain = res.positionImpacts.find((p) => p.securityId === PLAIN_CALL)!;
    expect(lev.underlyingMove).toBeCloseTo(2 * plain.underlyingMove!, 10);
  });

  it("What-if: the held call counts at twice its money in the exposure buckets", () => {
    const res = computeExposureDelta(db, "all", undefined, []);
    expect(res.leveragedFundsNotModelled).toEqual([]);
    // Both calls hold $1,000 of contracts. An option row carries no sector of
    // its own in this engine, so both sit in "Unknown" — but the 2x call
    // carries $2,000 of exposure there against the plain call's $1,000:
    // $3,000 over a $2,000 book.
    expect(res.before.totalValue).toBeCloseTo(2000, 8);
    expect(res.before.sectorWeights.Unknown).toBeCloseTo(1.5, 10);
  });
});

describe("What-if: a signed fund is counted at its exposure; an unsigned one is still left out", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare(`INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test')`).run();
    const sec = db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category, leverage_factor)
       VALUES (?, ?, ?, 'Stock', ?, ?, ?)`,
    );
    sec.run(1, "AAA", "AAA Semi Corp", "Technology", null, null);
    sec.run(2, "ZZS", "DIREX DAI SEMI BE 3X ETF-USD", "Technology", null, -3);
    sec.run(3, "ZZN", "ZZ NO MULTIPLE FUND", "Technology", "Leveraged/Inverse", null);
    const fac = db.prepare(`INSERT INTO security_factors (security_id, ai_exposure) VALUES (?, ?)`);
    fac.run(1, "Very High");
    fac.run(2, "Very High");
    fac.run(3, "Very High");
    const beta = db.prepare(
      `INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, 60, ?, '2026-10-01')`,
    );
    beta.run(1, 1.0);
    beta.run(2, 1.0);
    beta.run(3, 1.0);
    const px = db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 100, 'test')`);
    const h = db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, ?, ?)`,
    );
    for (const id of [1, 2, 3]) {
      px.run(id, today);
      h.run(id, today, 100, `h-${id}`);
    }
  });

  it("the inverse fund SUBTRACTS from the sector it shorts, and the unsigned fund is named", () => {
    const res = computeExposureDelta(db, "all", undefined, []);
    // $10,000 long AAA + $10,000 of a -3x fund = $20,000 of money, and
    // 10,000 - 30,000 = -$20,000 of Technology exposure.
    expect(res.before.totalValue).toBeCloseTo(20_000, 8);
    expect(res.before.sectorWeights.Technology).toBeCloseTo(-1, 10);
    expect(res.before.beta).toBeCloseTo(-1, 10);
    // The unsigned fund stays out of the buckets and out of the total.
    expect(res.leveragedFundsNotModelled).toEqual(["ZZN"]);
  });

  it("a hypothetical leg on a SIGNED fund is modelled, not dropped", () => {
    const res = computeExposureDelta(db, "all", undefined, [
      { symbol: "ZZS", action: "buy", dollarAmount: 10_000 },
      { symbol: "ZZN", action: "buy", dollarAmount: 10_000 },
    ]);
    // Only the unsigned one is refused.
    expect(res.droppedLegs).toEqual([{ symbol: "ZZN", reason: "leveraged_or_inverse_fund" }]);
    // Buying another $10,000 of the -3x fund takes Technology exposure from
    // -$20,000 to -$50,000 over a $30,000 book.
    expect(res.after.totalValue).toBeCloseTo(30_000, 8);
    expect(res.after.sectorWeights.Technology).toBeCloseTo(-50_000 / 30_000, 10);
  });
});

describe("TODO (h): Defense counts a long inverse ETF as SHORT exposure", () => {
  let db: Database.Database;

  function seedDefense(leverageFactor: number | null): void {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare(`INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test')`).run();
    const sec = db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category, currency, leverage_factor)
       VALUES (?, ?, ?, ?, 'Technology', ?, 'USD', ?)`,
    );
    sec.run(1, "AAA", "AAA Semi Corp", "Stock", null, null);
    sec.run(2, "ZZS", "DIREX DAI SEMI BE 3X ETF-USD", "ETF", null, leverageFactor);
    const px = db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 100, 'test')`);
    const h = db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, 100, ?)`,
    );
    for (const id of [1, 2]) {
      px.run(id, today);
      h.run(id, today, `h-${id}`);
    }
  }

  it("a signed inverse fund enters the book with negative exposure", () => {
    seedDefense(-3);
    const res = computeDefenseAnalysis(db);
    // It is modelled now, so nothing is disclosed as not modelled.
    expect(res.leveragedFundsUnmodelled).toEqual({ count: 0, valueShare: 0, symbols: [] });
    // $10,000 long AAA, and $10,000 of a -3x fund = -$30,000 of exposure.
    expect(res.summary.longExposure).toBeCloseTo(10_000, 8);
    expect(res.summary.shortExposure).toBeCloseTo(-30_000, 8);
    expect(res.summary.netExposure).toBeCloseTo(-20_000, 8);
  });

  it("an UNSIGNED flagged fund is still held out of the book entirely (the stopgap)", () => {
    seedDefense(null);
    const res = computeDefenseAnalysis(db);
    expect(res.leveragedFundsUnmodelled.symbols).toEqual(["ZZS"]);
    expect(res.summary.longExposure).toBeCloseTo(10_000, 8);
    expect(res.summary.shortExposure).toBeCloseTo(0, 8);
  });
});

describe("QA #44: a flagged fund's sector comes from the index its name states", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, sector, sector_source, fund_category)
       VALUES (1, 'ZZS', 'DIREX DAI SEMI BE 3X ETF-USD', 'ETF', 'Financials', 'ai_classify', NULL)`,
    ).run();
  });

  const sectorOf = (id: number) =>
    db.prepare(`SELECT sector, sector_source FROM securities WHERE id = ?`).get(id) as {
      sector: string;
      sector_source: string | null;
    };

  it("rewrites an AI-guessed sector to the tracked index's sector, and stores the factor", () => {
    const res = applyLeverageFactors(db);
    expect(sectorOf(1)).toEqual({ sector: "Technology", sector_source: "leveraged_index" });
    expect(res.sectorsRewritten).toBe(1);
    expect(
      (db.prepare(`SELECT leverage_factor AS f FROM securities WHERE id = 1`).get() as { f: number }).f,
    ).toBe(-3);
  });

  it("never touches a verified or import-sourced sector", () => {
    db.prepare(`UPDATE securities SET sector_source = 'csv_import' WHERE id = 1`).run();
    expect(applyLeverageFactors(db).sectorsRewritten).toBe(0);
    expect(sectorOf(1).sector).toBe("Financials");

    db.prepare(`UPDATE securities SET sector_source = 'ai_classify', sector_verified_at = '2026-10-01' WHERE id = 1`).run();
    expect(applyLeverageFactors(db).sectorsRewritten).toBe(0);
    expect(sectorOf(1).sector).toBe("Financials");
  });

  it("leaves a fund on a broad index alone — no entry, no sector claim", () => {
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, sector, sector_source, fund_category)
       VALUES (2, 'ZZD', 'PROSHARES ULTRAPRO DOW30', 'Stock', 'Diversified', 'ai_classify', 'Leveraged/Inverse')`,
    ).run();
    applyLeverageFactors(db);
    expect(sectorOf(2).sector).toBe("Diversified");
  });

  it("is idempotent, and a dry run writes nothing", () => {
    const dry = applyLeverageFactors(db, { dryRun: true });
    expect(dry.factorsWritten).toBe(1);
    expect(dry.sectorsRewritten).toBe(1);
    expect(sectorOf(1).sector).toBe("Financials");

    applyLeverageFactors(db);
    const again = applyLeverageFactors(db);
    expect(again.factorsWritten).toBe(0);
    expect(again.sectorsRewritten).toBe(0);
    expect(again.flagged).toHaveLength(1);
  });

  it("clears a factor off a row that is no longer a leveraged fund", () => {
    applyLeverageFactors(db);
    db.prepare(`UPDATE securities SET name = 'AAA Ordinary Corp' WHERE id = 1`).run();
    const res = applyLeverageFactors(db);
    expect(res.factorsCleared).toBe(1);
    expect(
      (db.prepare(`SELECT leverage_factor AS f FROM securities WHERE id = 1`).get() as { f: number | null }).f,
    ).toBeNull();
  });
});
