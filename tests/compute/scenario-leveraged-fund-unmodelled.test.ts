import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeScenario, PRESET_SCENARIOS, type ScenarioResult } from "@/lib/compute/scenarios";
import {
  isLeveragedOrInverseFund,
  summarizeUnmodelledLeveragedFunds,
  LEVERAGED_FUND_UNMODELLED_LABEL,
} from "@/lib/compute/leveraged-fund";
import { computeExposureDelta } from "@/lib/compute/exposure-delta";
import { todayET } from "@/lib/calendar/date-utils";

/**
 * Owner ruling 2026-11-01 (item 2, stopgap "B"): a leveraged or inverse fund
 * takes no figure in either scenario engine, is named and counted, and the
 * What-if leaves it out of the beta, sector and factor buckets.
 * Synthetic symbols and round figures only.
 */

describe("isLeveragedOrInverseFund", () => {
  const sec = (security_type: string | null, name: string | null, fund_category: string | null = null) => ({
    security_type,
    name,
    fund_category,
  });

  it("matches the leverage-token name shapes, even on a Stock-typed row", () => {
    expect(isLeveragedOrInverseFund(sec("Stock", "2X LONG VIX FUTURES ETF"))).toBe(true);
    expect(isLeveragedOrInverseFund(sec("Stock", "GRANITESH 2X LNG NVDA ETF"))).toBe(true);
    expect(isLeveragedOrInverseFund(sec("Stock", "DIREX DAIL SEMI BU 3X ET-USD"))).toBe(true);
    expect(isLeveragedOrInverseFund(sec("Stock", "DIREX DAI SEMI BE 3X ETF-USD"))).toBe(true);
    expect(isLeveragedOrInverseFund(sec("Stock", "T-REX 2X INVERSE MSTR DT ETF"))).toBe(true);
    expect(isLeveragedOrInverseFund(sec("ETF", "ZZ Short VIX -1X Fund"))).toBe(true);
    expect(isLeveragedOrInverseFund(sec("Stock", "ZZ ULTRAPRO QQQ"))).toBe(true);
    expect(isLeveragedOrInverseFund(sec("Stock", "ZZ UltraShort Crude"))).toBe(true);
  });

  it("matches the weak name markers only on a fund-typed or categorised row", () => {
    expect(isLeveragedOrInverseFund(sec("ETF", "ZZ Ultra Bloomberg Crude Oil"))).toBe(true);
    expect(isLeveragedOrInverseFund(sec("ETF", "DIREXION DAILY ZZ BEAR"))).toBe(true);
    expect(isLeveragedOrInverseFund(sec("Stock", "ZZ Ultra Crude", "Commodities"))).toBe(true);
  });

  it("matches each stored category shape, case-insensitively", () => {
    for (const cat of ["Leveraged/Inverse", "Leveraged Equity", "Leveraged ETF", "Leveraged/Inverse (Commodities)", "inverse"]) {
      expect(isLeveragedOrInverseFund(sec("ETF", "ZZ Fund", cat))).toBe(true);
      expect(isLeveragedOrInverseFund(sec("Stock", "ZZ Fund", cat))).toBe(true);
    }
    expect(isLeveragedOrInverseFund(sec(" mutual fund ", "ZZ Fund", "LEVERAGED EQUITY"))).toBe(true);
  });

  it("does not match ordinary names, bonds, options or a plain ETF", () => {
    expect(isLeveragedOrInverseFund(sec("Stock", "Build-A-Bear Workshop"))).toBe(false);
    expect(isLeveragedOrInverseFund(sec("Stock", "Ultra Clean Holdings"))).toBe(false);
    expect(isLeveragedOrInverseFund(sec("Bond", "ZZ 3X Inverse Note", "Leveraged/Inverse"))).toBe(false);
    expect(isLeveragedOrInverseFund(sec("Option", "ZZ 2X LONG ETF call", "Leveraged ETF"))).toBe(false);
    expect(isLeveragedOrInverseFund(sec("ETF", "AAA Semiconductor ETF", "Semiconductor"))).toBe(false);
    expect(isLeveragedOrInverseFund(sec("ETF", "ZZ 13X Fund"))).toBe(false);
    expect(isLeveragedOrInverseFund(sec(null, "ZZ 2X Fund"))).toBe(false);
  });
});

describe("summarizeUnmodelledLeveragedFunds", () => {
  it("counts flagged rows, sorts their symbols and gives their share of the book", () => {
    expect(
      summarizeUnmodelledLeveragedFunds([
        { symbol: "ZZB", currentValue: 3000, leveragedFundUnmodelled: true },
        { symbol: "ZZA", currentValue: -1000, leveragedFundUnmodelled: true },
        { symbol: "ZZC", currentValue: 6000 },
      ]),
    ).toEqual({ count: 2, valueShare: 0.4, symbols: ["ZZA", "ZZB"] });
    expect(summarizeUnmodelledLeveragedFunds([])).toEqual({ count: 0, valueShare: 0, symbols: [] });
    expect(LEVERAGED_FUND_UNMODELLED_LABEL).toBe(
      "leveraged or inverse fund, or an option on one, with no stored leverage factor: not modelled (no sign and no multiple to apply)",
    );
  });
});

describe("scenario engines: a leveraged or inverse fund takes no figure", () => {
  let db: Database.Database;
  const LEV = 1;
  const PLAIN = 2;

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
    seed(LEV, "ZZS", "DIREX DAI SEMI BE 3X ETF-USD", "Stock", "Technology", null);
    seed(PLAIN, "AAA", "AAA Semiconductor ETF", "ETF", "Technology", "Semiconductor");
    const factors = db.prepare(
      `INSERT INTO security_factors (security_id, tariff_exposure, ai_exposure) VALUES (?, ?, ?)`,
    );
    factors.run(LEV, "High", "Very High");
    factors.run(PLAIN, "High", "Very High");
  });

  const rowOf = (res: ScenarioResult, id: number) => res.positionImpacts.find((p) => p.securityId === id)!;
  const preset = (id: string) => PRESET_SCENARIOS.find((p) => p.id === id)!;

  function expectLeftOut(res: ScenarioResult) {
    const lev = rowOf(res, LEV);
    expect(lev.currentValue).toBeCloseTo(10_000, 8);
    expect(lev.changePercent).toBe(0);
    expect(lev.estimatedChange).toBe(0);
    expect(lev.beta).toBe(1.0);
    expect(lev.leveragedFundUnmodelled).toBe(true);
    expect(res.leveragedFundsUnmodelled).toEqual({ count: 1, valueShare: 0.5, symbols: ["ZZS"] });
    expect(res.biggestLosers.map((p) => p.symbol)).not.toContain("ZZS");
    expect(res.biggestWinners.map((p) => p.symbol)).not.toContain("ZZS");
    // Still a real position: counted in the book's value.
    expect(res.currentPortfolioValue).toBeCloseTo(20_000, 8);

    const plain = rowOf(res, PLAIN);
    expect(plain.leveragedFundUnmodelled).toBeUndefined();
    expect(plain.changePercent).toBeLessThan(0);
    expect(res.estimatedChange).toBeCloseTo(plain.estimatedChange, 8);
  }

  it("sector-down preset (semis -15%)", () => {
    const res = computeScenario(db, preset("semi_cycle_minus_15pct"));
    expectLeftOut(res);
    expect(rowOf(res, LEV).subjectShare).toBe(0);
  });

  it("custom market -10%", () => {
    expectLeftOut(
      computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove: -0.1 }),
    );
  });

  it("a book with no such fund reports none", () => {
    db.prepare(`DELETE FROM holdings WHERE security_id = ?`).run(LEV);
    const res = computeScenario(db, preset("semi_cycle_minus_15pct"));
    expect(res.leveragedFundsUnmodelled).toEqual({ count: 0, valueShare: 0, symbols: [] });
  });
});

describe("What-if: a leveraged or inverse fund stays out of the exposure buckets", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const today = todayET();
    const sec = db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    sec.run(1, "AAA", "AAA Corp", "Stock", "Healthcare", null);
    sec.run(2, "ZZS", "DIREX DAI SEMI BE 3X ETF-USD", "Stock", "Technology", null);
    sec.run(3, "ZZU", "ZZ Ultra Crude", "ETF", "Energy", "Leveraged/Inverse (Commodities)");
    const fac = db.prepare(`INSERT INTO security_factors (security_id, ai_exposure) VALUES (?, ?)`);
    fac.run(1, "No");
    fac.run(2, "Very High");
    fac.run(3, "Low");
    const beta = db.prepare(
      `INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, 60, ?, '2026-10-01')`,
    );
    beta.run(1, 0.5);
    beta.run(2, 3.0);
    beta.run(3, 2.0);
    const px = db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 100, 'test')`);
    px.run(1, today);
    px.run(2, today);
    px.run(3, today);
    const h = db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, ?, ?)`,
    );
    h.run(1, today, 100, "h-1");
    h.run(3, today, 50, "h-3"); // an existing flagged holding
  });

  it("an existing flagged holding is left out of the buckets and named", () => {
    const res = computeExposureDelta(db, "all", undefined, []);
    expect(res.before.totalValue).toBeCloseTo(10_000, 8);
    expect(res.before.beta).toBeCloseTo(0.5, 12);
    expect(res.before.sectorWeights).toEqual({ Healthcare: 1 });
    expect(res.before.factorTilts.ai_exposure).toEqual({ No: 1 });
    expect(res.before.topConcentrations.map((c) => c.symbol)).toEqual(["AAA"]);
    expect(res.leveragedFundsNotModelled).toEqual(["ZZU"]);
  });

  it("a hypothetical leg on a flagged fund is dropped with the reason and moves no tilt", () => {
    const res = computeExposureDelta(db, "all", undefined, [
      { symbol: "ZZS", action: "buy", dollarAmount: 5000 },
      { symbol: "ZZU", action: "buy", dollarAmount: 5000 },
    ]);
    expect(res.droppedLegs).toEqual([
      { symbol: "ZZS", reason: "leveraged_or_inverse_fund" },
      { symbol: "ZZU", reason: "leveraged_or_inverse_fund" },
    ]);
    expect(res.after).toEqual(res.before);
    expect(res.after.factorTilts.ai_exposure["Very High"]).toBeUndefined();
    expect(res.leveragedFundsNotModelled).toEqual(["ZZS", "ZZU"]);
  });
});
