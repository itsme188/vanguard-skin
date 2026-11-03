import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeScenario, PRESET_SCENARIOS, type ScenarioResult } from "@/lib/compute/scenarios";
import { computeExposureDelta } from "@/lib/compute/exposure-delta";
import {
  isLeveragedOrInverseExposure,
  LEVERAGED_FUND_UNMODELLED_LABEL,
} from "@/lib/compute/leveraged-fund";
import { todayET, addDays } from "@/lib/calendar/date-utils";

/**
 * QA regression (2026-11-03): the 2026-11-01 stopgap read the held row's own
 * type, so an OPTION on a daily-reset leveraged fund was repriced off a 1x
 * underlying move (a call on a 2x crude fund topped the oil shock's winners).
 * An option on such a fund is treated exactly like the fund.
 * Synthetic symbols and round figures only.
 */

const LEV_CAT = "Leveraged/Inverse (Commodities)";

describe("isLeveragedOrInverseExposure", () => {
  const sec = (security_type: string | null, name: string | null, fund_category: string | null = null) => ({
    security_type,
    name,
    fund_category,
  });

  it("matches an option whose underlying is a leveraged or inverse fund", () => {
    expect(
      isLeveragedOrInverseExposure(sec("Option", "ZZZ call", "Options"), sec("ETF", "ZZZ Fund", LEV_CAT)),
    ).toBe(true);
    expect(isLeveragedOrInverseExposure(sec(" call ", "ZZZ call"), sec("Stock", "ZZ 2X LONG CRUDE ETF"))).toBe(true);
  });

  it("does not match an option on a plain ETF, or a plain stock with no underlying", () => {
    expect(
      isLeveragedOrInverseExposure(sec("Option", "AAA call"), sec("ETF", "AAA Energy ETF", "Energy")),
    ).toBe(false);
    expect(isLeveragedOrInverseExposure(sec("Option", "AAA call"), null)).toBe(false);
    expect(isLeveragedOrInverseExposure(sec("Stock", "AAA Corp"), null)).toBe(false);
  });

  it("still matches the fund itself, and a non-option never matches through an underlying", () => {
    expect(isLeveragedOrInverseExposure(sec("ETF", "ZZZ Fund", LEV_CAT), null)).toBe(true);
    expect(isLeveragedOrInverseExposure(sec("Stock", "AAA Corp"), sec("ETF", "ZZZ Fund", LEV_CAT))).toBe(false);
    expect(isLeveragedOrInverseExposure(sec("Bond", "AAA Note"), sec("ETF", "ZZZ Fund", LEV_CAT))).toBe(false);
  });

  it("the disclosure label names an option on one", () => {
    expect(LEVERAGED_FUND_UNMODELLED_LABEL).toBe(
      "leveraged or inverse fund, or an option on one: not modelled (daily-reset leverage is not a linear leg)",
    );
  });
});

describe("scenario engines: an option on a leveraged fund takes no figure", () => {
  let db: Database.Database;
  const LEV_FUND = 1; // not held; only the underlying of the call
  const LEV_CALL = 2;
  const PLAIN_ETF = 3; // not held; underlying of the plain call
  const PLAIN_CALL = 4;
  const LEV_CALL_SYMBOL = "ZZZ 261120C00065000";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const today = todayET();
    const expiry = addDays(today, 90);
    db.prepare(`INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test')`).run();
    const fund = db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category) VALUES (?, ?, ?, 'ETF', 'Energy', ?)`,
    );
    fund.run(LEV_FUND, "ZZZ", "ZZZ Fund", LEV_CAT);
    fund.run(PLAIN_ETF, "AAA", "AAA Energy ETF", "Energy");
    const opt = db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, underlying_symbol, strike_price, expiration_date, option_type, multiplier, fund_category)
       VALUES (?, ?, ?, 'Option', ?, 60, ?, 'CALL', 100, 'Options')`,
    );
    opt.run(LEV_CALL, LEV_CALL_SYMBOL, "ZZZ call", "ZZZ", expiry);
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

  const rowOf = (res: ScenarioResult, id: number) => res.positionImpacts.find((p) => p.securityId === id)!;

  function expectOptionLeftOut(res: ScenarioResult) {
    const lev = rowOf(res, LEV_CALL);
    expect(lev.leveragedFundUnmodelled).toBe(true);
    expect(lev.changePercent).toBe(0);
    expect(lev.estimatedChange).toBe(0);
    expect(lev.beta).toBe(1.0);
    expect(lev.currentValue).toBeCloseTo(1000, 8);
    expect(res.leveragedFundsUnmodelled).toEqual({ count: 1, valueShare: 0.5, symbols: [LEV_CALL_SYMBOL] });
    expect(res.biggestWinners.map((p) => p.symbol)).not.toContain(LEV_CALL_SYMBOL);
    expect(res.biggestLosers.map((p) => p.symbol)).not.toContain(LEV_CALL_SYMBOL);

    const plain = rowOf(res, PLAIN_CALL);
    expect(plain.leveragedFundUnmodelled).toBeUndefined();
  }

  it("custom engine: the call on the 2x fund is left out, the plain call is repriced", () => {
    const res = computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove: -0.1 });
    expectOptionLeftOut(res);
    const plain = rowOf(res, PLAIN_CALL);
    expect(typeof plain.underlyingMove).toBe("number");
    expect(plain.changePercent).toBeLessThan(0);
  });

  it("preset engine (oil shock): the call on the 2x fund is left out", () => {
    const preset = PRESET_SCENARIOS.find((p) => p.id === "oil_shock_10dollar")!;
    const res = computeScenario(db, preset);
    expectOptionLeftOut(res);
    expect(rowOf(res, LEV_CALL).subjectShare).toBe(0);
    expect(typeof rowOf(res, PLAIN_CALL).underlyingMove).toBe("number");
  });

  it("What-if: a held call on the 2x fund stays out of the buckets and is named", () => {
    const res = computeExposureDelta(db, "all", undefined, []);
    expect(res.leveragedFundsNotModelled).toEqual([LEV_CALL_SYMBOL]);
    expect(res.before.topConcentrations.map((c) => c.symbol)).not.toContain(LEV_CALL_SYMBOL);
  });

  it("What-if: a hypothetical leg on a call on the 2x fund is dropped", () => {
    const res = computeExposureDelta(db, "all", undefined, [
      { symbol: LEV_CALL_SYMBOL, action: "buy", dollarAmount: 500 },
    ]);
    expect(res.droppedLegs).toEqual([{ symbol: LEV_CALL_SYMBOL, reason: "leveraged_or_inverse_fund" }]);
  });
});
