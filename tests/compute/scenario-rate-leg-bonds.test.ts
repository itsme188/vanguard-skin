import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeScenario, PRESET_SCENARIOS, type ScenarioResult } from "@/lib/compute/scenarios";
import { couponBondModifiedDuration } from "@/lib/compute/bond-duration";
import { todayET, addDays } from "@/lib/calendar/date-utils";

/**
 * The rate leg of both scenario engines (owner rulings 2026-10-06):
 *  - a bond with no stored duration derives it from its maturity date, and a
 *    bond that cannot be derived is left out and counted, never given 5 years;
 *  - a fixed-income FUND takes the same duration estimate (stored duration,
 *    else a 5-year default), on a custom rate move and on the rate preset.
 * Synthetic figures only.
 */
let db: Database.Database;
let today: string;

const BILL = 1;
const NOTE = 2;
const NO_MATURITY = 3;
const STORED = 4;
const FUND_DEFAULT = 5;
const FUND_STORED = 6;
const CASH = 7;
const STOCK = 8;
const NO_COUPON = 9;
const SHORT_BOND = 10;
const FI_STOCK = 11;
const INVERSE_FUND = 12;
const NULL_SECTOR_FUND = 13;

const RATE_PRESET = "rate_shock_up_25bp";

function seed(
  id: number,
  symbol: string,
  opts: {
    name?: string;
    type: string;
    sector?: string | null;
    fundCategory?: string | null;
    duration?: number | null;
    maturity?: string | null;
    coupon?: number | null;
    price: number;
    quantity: number;
  },
) {
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category, duration_years, maturity_date, coupon_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    symbol,
    opts.name ?? symbol,
    opts.type,
    opts.sector ?? null,
    opts.fundCategory ?? null,
    opts.duration ?? null,
    opts.maturity ?? null,
    opts.coupon ?? null,
  );
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')`).run(id, today, opts.price);
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, ?, ?)`,
  ).run(id, today, opts.quantity, `h-${id}`);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  today = todayET();
  db.prepare(`INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test')`).run();

  seed(BILL, "ZZBILL", { name: "T-Bill (due soon)", type: "Bond", maturity: addDays(today, 60), price: 99, quantity: 10000 });
  seed(NOTE, "ZZNOTE", { name: "ZZ note", type: "Bond", maturity: addDays(today, 3650), coupon: 4, price: 100, quantity: 10000 });
  seed(NO_MATURITY, "ZZNOMAT", { name: "ZZ undated", type: "Bond", price: 100, quantity: 5000 });
  seed(STORED, "ZZSTORED", { name: "ZZ measured", type: "Bond", duration: 7, maturity: addDays(today, 60), price: 100, quantity: 10000 });
  seed(FUND_DEFAULT, "ZZBFUND", {
    name: "ZZ Mortgage Bond Fund", type: "Mutual Fund", sector: "Fixed Income", fundCategory: "US Mortgage-Backed Securities", price: 10, quantity: 1000,
  });
  seed(FUND_STORED, "ZZSFUND", {
    name: "ZZ Short Bond ETF", type: "ETF", sector: "Fixed Income", fundCategory: "ZZ Short Bond", duration: 2, price: 50, quantity: 200,
  });
  seed(CASH, "ZZCASH", {
    name: "ZZ Sweep", type: "Mutual Fund", sector: "Fixed Income", fundCategory: "Cash Equivalent", price: 1, quantity: 5000,
  });
  seed(STOCK, "ZZEQ", { name: "ZZ Equity", type: "Stock", sector: "Technology", price: 100, quantity: 100 });
});

function custom(rateMove: number | undefined, marketMove = 0): ScenarioResult {
  return computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove, rateMove });
}
function preset(id: string): ScenarioResult {
  return computeScenario(db, PRESET_SCENARIOS.find((p) => p.id === id)!);
}
const rowOf = (res: ScenarioResult, id: number) => res.positionImpacts.find((p) => p.securityId === id)!;

describe("custom rate move: individual bonds", () => {
  it("a two-month bill loses about its years to maturity times the move, not the 5-year figure", () => {
    const bill = rowOf(custom(200), BILL);
    expect(bill.changePercent).toBeCloseTo(Math.exp(-(60 / 365) * 0.02) - 1, 10);
    expect(bill.changePercent).toBeGreaterThan(-0.004);
    expect(bill.changePercent).toBeLessThan(-0.003);
    expect(bill.rateDurationSource).toBe("bill-maturity");
    expect(bill.bondUnmodelledReason).toBeUndefined();
  });

  it("a coupon bond with a stored coupon, maturity and price uses the derived modified duration", () => {
    const derived = couponBondModifiedDuration({ couponRatePct: 4, cleanPrice: 100, maturityDate: addDays(today, 3650), today });
    if (!derived.ok) throw new Error("fixture must derive");
    const note = rowOf(custom(200), NOTE);
    expect(note.changePercent).toBeCloseTo(Math.exp(-derived.modifiedDuration * 0.02) - 1, 10);
    expect(note.rateDurationSource).toBe("coupon-yield");
    expect(note.rateDurationYears).toBeCloseTo(derived.modifiedDuration, 10);
    // A 10-year 4% bond at par has a duration near 8 years, well away from 5.
    expect(note.rateDurationYears!).toBeGreaterThan(7.5);
    expect(note.rateDurationYears!).toBeLessThan(8.5);
  });

  it("a stored duration is used as stored", () => {
    const stored = rowOf(custom(200), STORED);
    expect(stored.changePercent).toBeCloseTo(Math.exp(-7 * 0.02) - 1, 10);
    expect(stored.rateDurationSource).toBe("stored");
  });

  it("a bond with no maturity date contributes zero to the rate leg and is counted", () => {
    const res = custom(200);
    const undated = rowOf(res, NO_MATURITY);
    expect(undated.changePercent).toBe(0);
    expect(undated.estimatedChange).toBe(0);
    expect(undated.bondUnmodelledReason).toBe("no-maturity");
    expect(res.bondsUnmodelled.count).toBe(1);
    // 5,000 of 9,900 + 10,000 + 5,000 + 10,000 of individual-bond value.
    expect(res.bondsUnmodelled.valueShare).toBeCloseTo(5000 / 34900, 10);
  });

  it("a coupon bond with no stored coupon is left out too, never given an assumed coupon", () => {
    seed(NO_COUPON, "ZZNOCPN", { name: "ZZ note, coupon not stored", type: "Bond", maturity: addDays(today, 3650), price: 100, quantity: 1000 });
    const res = custom(200);
    expect(rowOf(res, NO_COUPON).changePercent).toBe(0);
    expect(rowOf(res, NO_COUPON).bondUnmodelledReason).toBe("no-coupon");
    expect(res.bondsUnmodelled.count).toBe(2);
  });

  it("an unmodelled bond keeps its market leg: only the rate leg is left out", () => {
    const res = custom(200, -0.1);
    const undated = rowOf(res, NO_MATURITY);
    expect(undated.changePercent).toBeCloseTo(-0.1 * undated.beta, 12);
    expect(undated.bondUnmodelledReason).toBe("no-maturity");
  });

  it("a falling-rate move makes a long bond gain", () => {
    const res = custom(-100);
    for (const id of [BILL, NOTE, STORED, FUND_DEFAULT]) {
      expect(rowOf(res, id).changePercent, String(id)).toBeGreaterThan(0);
      expect(rowOf(res, id).estimatedChange, String(id)).toBeGreaterThan(0);
    }
    expect(rowOf(res, STORED).changePercent).toBeCloseTo(Math.exp(7 * 0.01) - 1, 10);
  });

  it("a short bond position loses dollars when rates fall and gains when they rise", () => {
    seed(SHORT_BOND, "ZZSHORT", { name: "ZZ shorted", type: "Bond", duration: 6, price: 100, quantity: -10000 });
    const fall = rowOf(custom(-100), SHORT_BOND);
    expect(fall.currentValue).toBeLessThan(0);
    expect(fall.changePercent).toBeCloseTo(Math.exp(6 * 0.01) - 1, 10);
    expect(fall.estimatedChange).toBeLessThan(0);
    const rise = rowOf(custom(100), SHORT_BOND);
    expect(rise.estimatedChange).toBeGreaterThan(0);
    expect(rise.estimatedChange).toBeCloseTo(rise.currentValue * (Math.exp(-6 * 0.01) - 1), 8);
  });

  it("a bond within a month of maturity is priced on its time to maturity despite price noise", () => {
    seed(SHORT_BOND, "ZZNEAR", { name: "ZZ note near maturity", type: "Bond", coupon: 4, maturity: addDays(today, 30), price: 98.5, quantity: 1000 });
    const near = rowOf(custom(200), SHORT_BOND);
    expect(near.bondUnmodelledReason).toBeUndefined();
    expect(near.rateDurationSource).toBe("single-flow");
    expect(near.changePercent).toBeCloseTo(Math.exp(-(30 / 365) * 0.02) - 1, 10);
  });

  it("a matured bond with a stored duration is matured, not priced", () => {
    seed(SHORT_BOND, "ZZPAST", { name: "ZZ matured", type: "Bond", duration: 7, maturity: addDays(today, -5), price: 100, quantity: 1000 });
    const res = custom(200);
    expect(rowOf(res, SHORT_BOND).changePercent).toBe(0);
    expect(rowOf(res, SHORT_BOND).bondUnmodelledReason).toBe("matured");
  });

  it("no rate move, nothing left out", () => {
    for (const res of [custom(undefined, -0.1), custom(0, -0.1)]) {
      expect(res.bondsUnmodelled).toEqual({ count: 0, valueShare: 0, fundCount: 0 });
      expect(res.positionImpacts.every((p) => p.bondUnmodelledReason === undefined)).toBe(true);
      expect(res.positionImpacts.every((p) => p.rateDurationSource === undefined)).toBe(true);
    }
  });
});

describe("custom rate move: bond funds and cash", () => {
  it("a bond fund with no stored duration moves on the 5-year default", () => {
    const fund = rowOf(custom(200), FUND_DEFAULT);
    expect(fund.changePercent).toBeCloseTo(Math.exp(-5 * 0.02) - 1, 10);
    expect(fund.rateDurationSource).toBe("fund-default");
    expect(fund.rateDurationYears).toBe(5);
  });

  it("a bond fund with a stored duration uses it", () => {
    const fund = rowOf(custom(200), FUND_STORED);
    expect(fund.changePercent).toBeCloseTo(Math.exp(-2 * 0.02) - 1, 10);
    expect(fund.rateDurationSource).toBe("fund-stored");
  });

  it("an ordinary bond ETF moves", () => {
    expect(rowOf(custom(200), FUND_STORED).securityType).toBe("ETF");
    expect(rowOf(custom(200), FUND_STORED).changePercent).toBeLessThan(0);
  });

  it("a Stock with a Fixed Income sector is not a bond fund: no rate leg, in either engine", () => {
    seed(FI_STOCK, "ZZPREF", { name: "ZZ Preferred", type: "Stock", sector: "Fixed Income", price: 25, quantity: 100 });
    const res = custom(200);
    expect(rowOf(res, FI_STOCK).changePercent).toBe(0);
    expect(rowOf(res, FI_STOCK).rateDurationSource).toBeUndefined();
    expect(rowOf(preset(RATE_PRESET), FI_STOCK).rateDurationSource).toBeUndefined();
  });

  it("an inverse bond fund takes no rate leg from this rule and is not listed as an unmodelled bond", () => {
    seed(INVERSE_FUND, "ZZINV", {
      name: "ZZ Inverse Treasury ETF", type: "ETF", sector: "Fixed Income", fundCategory: "Leveraged/Inverse", price: 20, quantity: 100,
    });
    const res = custom(200);
    expect(rowOf(res, INVERSE_FUND).changePercent).toBe(0);
    expect(rowOf(res, INVERSE_FUND).rateDurationSource).toBeUndefined();
    expect(rowOf(res, INVERSE_FUND).bondUnmodelledReason).toBeUndefined();
    expect(res.bondsUnmodelled.count).toBe(1); // still only the undated bond
    const fromPreset = preset(RATE_PRESET);
    expect(rowOf(fromPreset, INVERSE_FUND).rateDurationSource).toBeUndefined();
    expect(rowOf(fromPreset, INVERSE_FUND).bondUnmodelledReason).toBeUndefined();
    expect(fromPreset.bondsUnmodelled.count).toBe(1);
  });

  it("a bond-category fund with no sector moves, on the custom move and on the preset alike", () => {
    seed(NULL_SECTOR_FUND, "ZZNSF", {
      name: "ZZ Aggregate Bond Fund", type: "Mutual Fund", sector: null, fundCategory: "US Aggregate Bond", price: 10, quantity: 500,
    });
    const row = rowOf(custom(200), NULL_SECTOR_FUND);
    expect(row.changePercent).toBeCloseTo(Math.exp(-5 * 0.02) - 1, 10);
    expect(row.rateDurationSource).toBe("fund-default");
    expect(rowOf(preset(RATE_PRESET), NULL_SECTOR_FUND).changePercent).toBeCloseTo(rowOf(custom(25), NULL_SECTOR_FUND).changePercent, 12);
  });

  it("a cash-equivalent fund has no instantaneous price P&L, even with a Fixed Income sector", () => {
    const cash = rowOf(custom(200), CASH);
    expect(cash.changePercent).toBe(0);
    expect(cash.estimatedChange).toBe(0);
    expect(cash.rateDurationSource).toBeUndefined();
    expect(cash.bondUnmodelledReason).toBeUndefined();
  });

  it("a custom scenario gives a bond fund only its rate leg, not equity beta stacked on top", () => {
    seed(NULL_SECTOR_FUND, "ZZ100K", {
      name: "ZZ Aggregate Bond Fund", type: "Mutual Fund", sector: null, fundCategory: "US Aggregate Bond", price: 100, quantity: 1000,
    });
    const fund = rowOf(custom(100, -0.10), NULL_SECTOR_FUND);
    // Hand-worked: $100,000 position; rates +100bp; default duration 5y.
    // Linear check for the approved rule: -5y x 1% = -5%, so -$5,000
    // from rates and $0 from the -10% equity-market leg.
    expect(fund.currentValue).toBeCloseTo(100_000, 8);
    expect(fund.changePercent).toBeCloseTo(Math.exp(-5 * 0.01) - 1, 12);
    expect(fund.estimatedChange).toBeCloseTo(100_000 * (Math.exp(-5 * 0.01) - 1), 8);
    expect(fund.estimatedChange).toBeCloseTo(-4_877.0575, 4);
    expect(fund.rateDurationSource).toBe("fund-default");
  });

  it("an equity has no rate leg", () => {
    expect(rowOf(custom(200), STOCK).changePercent).toBe(0);
  });
});

describe("rate preset", () => {
  it("prices every bond and bond fund exactly as a custom +25bp move does", () => {
    const fromPreset = preset(RATE_PRESET);
    const fromCustom = custom(25);
    for (const id of [BILL, NOTE, NO_MATURITY, STORED, FUND_DEFAULT, FUND_STORED]) {
      expect(rowOf(fromPreset, id).changePercent, String(id)).toBeCloseTo(rowOf(fromCustom, id).changePercent, 12);
      expect(rowOf(fromPreset, id).rateDurationSource, String(id)).toBe(rowOf(fromCustom, id).rateDurationSource);
      expect(rowOf(fromPreset, id).bondUnmodelledReason, String(id)).toBe(rowOf(fromCustom, id).bondUnmodelledReason);
    }
    expect(fromPreset.bondsUnmodelled).toEqual(fromCustom.bondsUnmodelled);
  });

  it("moves the bond fund by duration: default 5 years, or the stored figure", () => {
    const res = preset(RATE_PRESET);
    expect(rowOf(res, FUND_DEFAULT).changePercent).toBeCloseTo(Math.exp(-5 * 0.0025) - 1, 12);
    expect(rowOf(res, FUND_STORED).changePercent).toBeCloseTo(Math.exp(-2 * 0.0025) - 1, 12);
  });

  it("the bill moves by weeks of duration and the undated bond is left out and counted", () => {
    const res = preset(RATE_PRESET);
    expect(rowOf(res, BILL).changePercent).toBeCloseTo(Math.exp(-(60 / 365) * 0.0025) - 1, 12);
    expect(rowOf(res, NO_MATURITY).changePercent).toBe(0);
    expect(rowOf(res, NO_MATURITY).bondUnmodelledReason).toBe("no-maturity");
    expect(res.bondsUnmodelled.count).toBe(1);
  });

  it("a cash-equivalent fund still takes no preset P&L", () => {
    expect(rowOf(preset(RATE_PRESET), CASH).changePercent).toBe(0);
  });

  it("a preset that is not about rates leaves no bond out and applies no duration", () => {
    for (const scenario of PRESET_SCENARIOS.filter((p) => p.id !== RATE_PRESET)) {
      const res = computeScenario(db, scenario);
      expect(res.bondsUnmodelled, scenario.id).toEqual({ count: 0, valueShare: 0, fundCount: 0 });
      expect(res.positionImpacts.every((p) => p.rateDurationSource === undefined), scenario.id).toBe(true);
    }
  });
});

describe("totals", () => {
  it("every scenario total equals the sum of its rows", () => {
    const results = [custom(200), custom(-150, -0.2), custom(25), ...PRESET_SCENARIOS.map((p) => computeScenario(db, p))];
    for (const res of results) {
      const sum = res.positionImpacts.reduce((s, p) => s + p.estimatedChange, 0);
      expect(res.estimatedChange, res.scenario.id).toBeCloseTo(sum, 8);
      expect(res.estimatedPortfolioValue, res.scenario.id).toBeCloseTo(res.currentPortfolioValue + sum, 8);
      for (const p of res.positionImpacts) {
        expect(p.estimatedChange, p.symbol).toBeCloseTo(p.currentValue * p.changePercent, 8);
      }
    }
  });
});
