import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays } from "@/lib/calendar/date-utils";
import {
  computeGainsAtRisk,
  GAINS_AT_RISK_CASE_KEYS,
  GainsAtRiskInputError,
  type GainsAtRiskCaseKey,
  type GainsAtRiskInput,
  type GainsAtRiskPosition,
  type GainsAtRiskResult,
} from "@/lib/compute/gains-at-risk";
import { BETA_OVERRIDE_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";
import { repriceOptionUnderShock } from "@/lib/compute/option-reprice";
import { loadScenarioPositionsByAccount } from "@/lib/compute/scenario-positions";
import { getRiskFreeRate } from "@/lib/queries/risk-free-rate";

// Gains at risk: the engine, in its two cases (addendum Task A2). Driver QQQ
// (a benchmark symbol, never a held name of the owner), clock 2026-11-10
// 15:00 UTC (10:00 Eastern). Betas are measured from daily bars on BOTH legs:
// every ZZ name's bars move a fixed multiple of the driver's daily log return,
// so its measured beta is that multiple. Synthetic ZZ tickers, round numbers.

const NOW = "2026-11-10T15:00:00Z";
const TODAY = "2026-11-10";
const DAYS = 120;
const SEEDS = { ZZ3X: "QQQ", ZZ3S: "QQQ", ZZ2I: "ZZT" };
const CASES: readonly GainsAtRiskCaseKey[] = GAINS_AT_RISK_CASE_KEYS;

function tradingDates(): string[] {
  const out: string[] = [];
  let d = "2026-11-09";
  while (out.length < DAYS) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.unshift(d);
    d = addDays(d, -1);
  }
  return out;
}

function driverCum(): number[] {
  const out = [0];
  for (let i = 1; i < DAYS; i++) out.push(out[i - 1] + 0.01 * Math.sin(i * 1.3) + 0.002 * Math.cos(i * 0.7));
  return out;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

let db: Database.Database;
let nextId = 100;
let nextKey = 0;
let nextConId = 5000;

function addSecurity(fields: {
  symbol: string;
  type: string;
  name?: string;
  sector?: string | null;
  fundCategory?: string | null;
  currency?: string;
  factor?: number | null;
  underlying?: string;
  strike?: number;
  expiry?: string;
  optionType?: string;
  multiplier?: number;
  conId?: boolean;
  id?: number;
}): number {
  const id = fields.id ?? nextId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category, currency, leverage_factor,
       underlying_symbol, strike_price, expiration_date, option_type, multiplier, ib_con_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    fields.symbol,
    fields.name ?? null,
    fields.type,
    fields.sector ?? null,
    fields.fundCategory ?? null,
    fields.currency ?? "USD",
    fields.factor ?? null,
    fields.underlying ?? null,
    fields.strike ?? null,
    fields.expiry ?? null,
    fields.optionType ?? null,
    fields.multiplier ?? 1,
    fields.conId === false ? null : nextConId++,
  );
  return id;
}

function price(id: number, close: number, date = "2026-11-09"): void {
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')").run(id, date, close);
}

function iv(id: number, value: number): void {
  db.prepare("INSERT INTO security_quotes (security_id, as_of_date, iv_underlying) VALUES (?, ?, ?)").run(id, TODAY, value);
}

function hold(id: number, qty: number, account = 1): void {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (?, ?, ?, ?, ?)",
  ).run(account, id, TODAY, qty, `gar-${++nextKey}`);
}

/** Daily bars whose log return is `multiple` times the driver's each day (the last `count` days). */
function bars(id: number, multiple: number, count = DAYS): void {
  const dates = tradingDates();
  const cum = driverCum();
  const ins = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, 1000)`,
  );
  for (let i = DAYS - count; i < DAYS; i++) {
    const c = 100 * Math.exp(multiple * cum[i]);
    ins.run(id, dates[i], c, c, c, c);
  }
}

/** QQQ held as a security, priced 100 with a broker IV and its own daily bars (the driver's series). */
function addDriverUnderlying(withBars = true): number {
  const id = addSecurity({ symbol: "QQQ", type: "ETF", name: "Driver index fund" });
  price(id, 100);
  iv(id, 0.3);
  if (withBars) bars(id, 1);
  return id;
}

/** A priced stock whose daily bars measure `beta` against the driver (no bars when beta is null). */
function stock(symbol: string, close: number, beta: number | null, extra: { sector?: string; currency?: string } = {}): number {
  const id = addSecurity({ symbol, type: "Stock", sector: extra.sector ?? "Technology", currency: extra.currency });
  price(id, close);
  if (beta !== null) bars(id, beta);
  return id;
}

function option(underlying: string, optionType: "PUT" | "CALL", strike: number, expiry: string, extra: { currency?: string } = {}): number {
  return addSecurity({
    symbol: `${underlying} ${optionType[0]}${strike} ${expiry}`,
    type: "Option",
    underlying,
    strike,
    expiry,
    optionType,
    multiplier: 100,
    conId: false,
    ...extra,
  });
}

const BASE: GainsAtRiskInput = {
  driverSymbol: "QQQ",
  valuationDate: TODAY,
  moves: [-0.2, -0.1, 0, 0.1],
  volChangePoints: 0,
};

function run(over: Partial<GainsAtRiskInput> = {}): GainsAtRiskResult {
  return computeGainsAtRisk(db, { ...BASE, ...over }, { trackedIndexSeeds: SEEDS });
}

function pos(r: GainsAtRiskResult, symbol: string, accountId?: number): GainsAtRiskPosition {
  const p = r.positions.find((x) => x.symbol === symbol && (accountId === undefined || x.accountId === accountId));
  if (!p) throw new Error(`no position ${symbol}`);
  return p;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  nextId = 100;
  nextKey = 0;
  nextConId = 5000;
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

/** A mixed book: stocks long and short, cash, a bond, options own-priced and model-priced, a name with no bars. */
function seedMixedBook(): void {
  const q = addDriverUnderlying();
  hold(q, 10);
  const a = stock("ZZA", 50, 1.5);
  hold(a, 20);
  const b = stock("ZZB", 40, null, { sector: "Utilities" }); // no daily bars
  hold(b, -50, 3);
  const mm = addSecurity({ symbol: "ZZMM", type: "Mutual Fund", fundCategory: "Cash Equivalent" });
  price(mm, 1);
  hold(mm, 1000);
  const bond = addSecurity({ symbol: "ZZBOND", type: "Bond" });
  price(bond, 98);
  hold(bond, 1000);
  const put = option("QQQ", "PUT", 95, "2027-01-15");
  price(put, 3);
  hold(put, 2);
  const call = option("QQQ", "CALL", 110, "2027-01-15");
  price(call, 2);
  hold(call, -1, 3);
  const modelPut = option("QQQ", "PUT", 90, "2027-01-15");
  hold(modelPut, 1);
  const nopx = addSecurity({ symbol: "ZZNP", type: "Stock", sector: "Industrials" });
  hold(nopx, 10);
}

function expectConservation(r: GainsAtRiskResult): void {
  for (const k of CASES) {
    const c = r.cases[k];
    expect(c.moves.map((m) => m.move)).toEqual(r.cases.measured.moves.map((m) => m.move));
    for (const [i, m] of c.moves.entries()) {
      expect(Math.abs(m.bookPnlUsd - sum(r.positions.map((p) => p.cases[k].pnlByMove[i])))).toBeLessThan(0.005);
      expect(Math.abs(m.bookPnlUsd - (m.losersPnlUsd + m.offsetsPnlUsd))).toBeLessThan(0.005);
      expect(
        Math.abs(m.offsetsPnlUsd - sum(r.positions.filter((p) => p.cases[k].side === "offsets").map((p) => p.cases[k].pnlByMove[i]))),
      ).toBeLessThan(0.005);
      expect(
        Math.abs(m.losersPnlUsd - sum(r.positions.filter((p) => p.cases[k].side !== "offsets").map((p) => p.cases[k].pnlByMove[i]))),
      ).toBeLessThan(0.005);
    }
  }
}

describe("computeGainsAtRisk: base behaviour, in both cases", () => {
  it("conservation: book = Σ rows = losers + offsets, to the cent, for every move and case", () => {
    seedMixedBook();
    const r = run();
    expect(r.cases.measured.moves.map((m) => m.move)).toEqual(BASE.moves);
    expectConservation(r);
    expect(r.positions).toHaveLength(9);
    expect(pos(r, "ZZNP").unmodelledReason).toBe("no-price");
    for (const k of CASES) {
      expect(pos(r, "ZZA").cases[k].side).toBe("loses");
      expect(pos(r, "QQQ P95 2027-01-15").cases[k].side).toBe("offsets");
      expect(pos(r, "ZZMM").cases[k].side).toBe("flat");
    }
    // The short with no measured link is held unchanged when measured, and offsets in the selloff case.
    expect(pos(r, "ZZB").cases.measured.side).toBe("flat");
    expect(pos(r, "ZZB").cases.selloff.side).toBe("offsets");
  });

  it("identity at rest: 0% today with no vol change is zero for every position in both cases", () => {
    seedMixedBook();
    const r = run({ moves: [0] });
    for (const k of CASES) {
      for (const p of r.positions) expect(p.cases[k].pnlByMove[0]).toBe(0);
      expect(r.cases[k].moves[0]).toEqual({ move: 0, bookPnlUsd: 0, losersPnlUsd: 0, offsetsPnlUsd: 0 });
    }
  });

  it("time decay: 0% at a later date loses on a long option, gains on a written one, nothing on a stock", () => {
    seedMixedBook();
    const r = run({ moves: [0], valuationDate: "2026-12-18" });
    for (const k of CASES) {
      expect(pos(r, "QQQ P95 2027-01-15").cases[k].pnlByMove[0]).toBeLessThan(0);
      expect(pos(r, "QQQ P90 2027-01-15").cases[k].pnlByMove[0]).toBeLessThan(0);
      expect(pos(r, "QQQ C110 2027-01-15").cases[k].pnlByMove[0]).toBeGreaterThan(0);
      expect(pos(r, "ZZA").cases[k].pnlByMove[0]).toBe(0);
      expect(pos(r, "QQQ").cases[k].pnlByMove[0]).toBe(0);
    }
  });

  it("expiry before the date: the worse case for a long put AND for a written put", () => {
    addDriverUnderlying();
    const longPut = option("QQQ", "PUT", 95, "2026-11-20");
    price(longPut, 1);
    hold(longPut, 2);
    const shortPut = option("QQQ", "PUT", 90, "2026-11-20");
    price(shortPut, 0.5);
    hold(shortPut, -1);
    const r = run({ moves: [-0.2], valuationDate: "2026-12-18" });
    const shock = { underlyingMove: -0.2, riskFreeRate: getRiskFreeRate(db), today: TODAY, now: new Date(NOW), valuationDate: "2026-12-18" };
    const terms = { underlying_price: 100, underlying_iv: 0.3, expiration_date: "2026-11-20", option_type: "PUT" };
    const l = repriceOptionUnderShock({ ...terms, strike_price: 95, own_price: 1 }, shock);
    const s = repriceOptionUnderShock({ ...terms, strike_price: 90, own_price: 0.5 }, shock);
    if (!l.modelled || !s.modelled) throw new Error("test contracts must price");
    for (const k of CASES) {
      expect(pos(r, "QQQ P95 2026-11-20").cases[k].pnlByMove[0]).toBeCloseTo((0 - l.v0) * 2 * 100, 6);
      expect(pos(r, "QQQ P90 2026-11-20").cases[k].pnlByMove[0]).toBeCloseTo((10 - s.v0) * -1 * 100, 6);
      expect(r.cases[k].disclosures.expiresBeforeDate.count).toBe(2);
      expect(r.cases[k].disclosures.expiresBeforeDate.symbols).toEqual(["QQQ P90 2026-11-20", "QQQ P95 2026-11-20"]);
    }
    expect(pos(r, "QQQ P95 2026-11-20")).toMatchObject({ expiresBeforeDate: true, expiry: "2026-11-20" });
  });

  it("expires on the date: intrinsic at the moved price", () => {
    addDriverUnderlying();
    const put = option("QQQ", "PUT", 95, "2026-11-20");
    price(put, 1);
    hold(put, 1);
    const r = run({ moves: [-0.2], valuationDate: "2026-11-20" });
    const l = repriceOptionUnderShock(
      { strike_price: 95, own_price: 1, underlying_price: 100, underlying_iv: 0.3, expiration_date: "2026-11-20", option_type: "PUT" },
      { underlyingMove: -0.2, riskFreeRate: getRiskFreeRate(db), today: TODAY, now: new Date(NOW), valuationDate: "2026-11-20" },
    );
    if (!l.modelled) throw new Error("must price");
    expect(l.v1).toBe(15);
    for (const k of CASES) expect(pos(r, "QQQ P95 2026-11-20").cases[k].pnlByMove[0]).toBeCloseTo((15 - l.v0) * 100, 6);
    expect(pos(r, "QQQ P95 2026-11-20").expiresBeforeDate).toBeUndefined();
  });

  it("leveraged: a 3x fund on the driver moves three times, not nine; an inverse fund gains in a fall", () => {
    addDriverUnderlying();
    const bull = addSecurity({ symbol: "ZZ3X", type: "ETF", name: "ZZ UltraPro 3X Index Fund", factor: 3 });
    price(bull, 50);
    bars(bull, 9); // its own regression against QQQ would read 9
    hold(bull, 10);
    const bear = addSecurity({ symbol: "ZZ3S", type: "ETF", name: "ZZ UltraPro Short 3X Index Fund", factor: -3 });
    price(bear, 20);
    hold(bear, 50);
    const r = run({ moves: [-0.1] });
    for (const k of CASES) {
      const b = pos(r, "ZZ3X");
      expect(b.betaSource).toBe("leveraged");
      expect(b.cases[k].beta).toBe(3);
      expect(b.cases[k].pnlByMove[0]).toBeCloseTo(500 * -0.3, 6);
      const s = pos(r, "ZZ3S");
      expect(s.cases[k].beta).toBe(-3);
      expect(s.cases[k].pnlByMove[0]).toBeCloseTo(1000 * 0.3, 6);
      expect(s.cases[k].side).toBe("offsets");
    }
  });

  it("leveraged with a factor but no tracked index is not modelled and listed, in both cases", () => {
    addDriverUnderlying();
    const f = addSecurity({ symbol: "ZZ2L", type: "ETF", name: "ZZ Ultra 2X Sector Fund", factor: 2 });
    price(f, 25);
    hold(f, 40);
    const r = run();
    const p = pos(r, "ZZ2L");
    expect(p).toMatchObject({ unmodelledReason: "leveraged-no-tracked-index", betaSource: "not-modelled", valueUsd: 1000 });
    for (const k of CASES) {
      expect(p.cases[k]).toMatchObject({ side: "flat", beta: null, exposureUsd: 0 });
      expect(p.cases[k].pnlByMove.every((x) => x === 0)).toBe(true);
      expect(r.cases[k].disclosures.notModelled).toMatchObject({ count: 1, symbols: ["ZZ2L"], shareOfBook: 1, unknownValueCount: 0 });
    }
  });

  it("an option on the driver with no underlying row has beta 1 through the loader", () => {
    const c = option("QQQ", "CALL", 100, "2027-01-15");
    price(c, 5);
    hold(c, 1);
    const r = run();
    const p = pos(r, "QQQ C100 2027-01-15");
    expect(p.identitySecurityId).toBeNull();
    // The driver rule fired (an identity with no row would otherwise read no-daily-bars) ...
    expect(p.noMeasuredLinkReason).toBeUndefined();
    // ... but no underlying row means no underlying price: listed, never priced from a guess,
    // and nothing on the row reads as a measured beta.
    expect(p.unmodelledReason).toBe("no-underlying-price");
    expect(p.betaSource).toBe("not-modelled");
    expect(p.measuredBeta).toBeNull();
    for (const k of CASES) expect(p.cases[k].beta).toBeNull();
    expect(p.valueUsd).toBe(500);
  });

  it("unpriced option: modelled from the broker IV and flagged; with no IV listed with value unknown", () => {
    addDriverUnderlying();
    const put = option("QQQ", "PUT", 95, "2027-01-15");
    hold(put, 2);
    const u = stock("ZZNV", 50, null);
    void u;
    const noIv = option("ZZNV", "CALL", 55, "2027-01-15");
    hold(noIv, 1);
    const r = run({ moves: [-0.1] });
    const direct = repriceOptionUnderShock(
      { strike_price: 95, own_price: null, underlying_price: 100, underlying_iv: 0.3, expiration_date: "2027-01-15", option_type: "PUT" },
      { underlyingMove: -0.1, riskFreeRate: getRiskFreeRate(db), today: TODAY, now: new Date(NOW), valuationDate: TODAY, modelWhenUnpriced: true },
    );
    if (!direct.modelled) throw new Error("must price");
    const p = pos(r, "QQQ P95 2027-01-15");
    expect(p.priceSource).toBe("model");
    expect(p.modelPricePerShare).toBeCloseTo(direct.v0, 9);
    expect(p.valueUsd).toBeCloseTo(direct.v0 * 2 * 100, 6);
    for (const k of CASES) {
      expect(p.cases[k].pnlByMove[0]).toBeCloseTo(direct.perShareChange * 2 * 100, 6);
      expect(r.cases[k].disclosures.pricedFromModel).toMatchObject({ count: 1, symbols: ["QQQ P95 2027-01-15"] });
      expect(r.cases[k].disclosures.notModelled.unknownValueCount).toBe(1);
    }
    const n = pos(r, "ZZNV C55 2027-01-15");
    expect(n).toMatchObject({ unmodelledReason: "no-volatility", valueUsd: null });
    expect(r.unknownValueCount).toBe(1);
    const modelGross = r.grossBookUsd;
    expect(modelGross).toBeCloseTo(direct.v0 * 200, 6);

    const withOverride = run({ moves: [-0.1], priceOverrides: { [put]: 4 } });
    const o = pos(withOverride, "QQQ P95 2027-01-15");
    expect(o.priceSource).toBe("override");
    expect(o.valueUsd).toBeCloseTo(4 * 2 * 100, 9);
    expect(withOverride.grossBookUsd).toBeCloseTo(800, 9);
    expect(withOverride.cases.measured.disclosures.pricedFromModel.count).toBe(0);
    const cleared = run({ moves: [-0.1] });
    expect(pos(cleared, "QQQ P95 2027-01-15").valueUsd).toBeCloseTo(direct.v0 * 200, 9);
    expect(cleared.grossBookUsd).toBeCloseTo(modelGross, 9);
  });

  it("an unpriced stock is listed as not modelled, never dropped", () => {
    const s = addSecurity({ symbol: "ZZNP", type: "Stock", sector: "Industrials" });
    hold(s, 100);
    const r = run();
    expect(pos(r, "ZZNP")).toMatchObject({ unmodelledReason: "no-price", valueUsd: null, priceSource: null, betaSource: "not-modelled" });
    for (const k of CASES) {
      expect(pos(r, "ZZNP").cases[k].side).toBe("flat");
      expect(r.cases[k].disclosures.notModelled.symbols).toEqual(["ZZNP"]);
    }
  });

  it("overrides: accepted, below intrinsic, and above the no-arbitrage bound", () => {
    addDriverUnderlying();
    const put = option("QQQ", "PUT", 95, "2027-01-15");
    hold(put, 1);
    const itm = option("QQQ", "PUT", 120, "2027-01-15");
    hold(itm, 1);
    const call = option("ZZC", "CALL", 50, "2027-01-15");
    const c = stock("ZZC", 60, null);
    iv(c, 0.3);
    hold(call, 1);
    const priced = option("QQQ", "CALL", 105, "2027-01-15");
    price(priced, 3);
    hold(priced, 1);
    const neg = option("QQQ", "CALL", 120, "2027-01-15");
    hold(neg, 1);
    const r = run({ priceOverrides: { [put]: 4, [itm]: 0.01, [call]: 70, [priced]: 9, [neg]: 0 } });
    expect(pos(r, "QQQ P95 2027-01-15")).toMatchObject({ priceSource: "override" });
    expect(pos(r, "QQQ P95 2027-01-15").overrideRefusal).toBeUndefined();
    expect(pos(r, "QQQ P120 2027-01-15")).toMatchObject({ overrideRefusal: "below-intrinsic", priceSource: "model" });
    expect(pos(r, "ZZC C50 2027-01-15")).toMatchObject({ overrideRefusal: "not-solvable", priceSource: "model" });
    expect(pos(r, "QQQ C105 2027-01-15")).toMatchObject({ overrideRefusal: "row-has-price", priceSource: "own-price", valueUsd: 300 });
    expect(pos(r, "QQQ C120 2027-01-15")).toMatchObject({ overrideRefusal: "not-positive", priceSource: "model" });
  });

  it("beta source: measured from bars, otherwise no measured link, listed and counted with its share", () => {
    addDriverUnderlying();
    const m = stock("ZZME", 50, 1.5);
    hold(m, 10);
    const e = stock("ZZES", 50, null);
    hold(e, 10);
    const r = run({ moves: [-0.1] });
    const mp = pos(r, "ZZME");
    expect(mp.betaSource).toBe("measured");
    expect(mp.measuredBeta).toBeCloseTo(1.5, 6);
    expect(mp.evidence?.outcome).toBe("measured");
    for (const k of CASES) expect(mp.cases[k].beta).toBeCloseTo(1.5, 6);
    const ep = pos(r, "ZZES");
    expect(ep).toMatchObject({ betaSource: "no-measured-link", measuredBeta: null, noMeasuredLinkReason: "no-daily-bars" });
    expect(ep.cases.measured).toMatchObject({ beta: 0, pnlByMove: [0], exposureUsd: 0, side: "flat" });
    expect(ep.cases.selloff.beta).toBe(1);
    expect(ep.cases.selloff.pnlByMove[0]).toBeCloseTo(-50, 9);
    for (const k of CASES) {
      expect(r.cases[k].disclosures.noMeasuredLink).toMatchObject({ count: 1, symbols: ["ZZES"] });
      expect(r.cases[k].disclosures.noMeasuredLink.shareOfBook).toBeCloseTo(500 / r.grossBookUsd, 9);
      expect(r.cases[k].disclosures.noMeasuredLink.reasons["no-daily-bars"]).toBe(1);
    }
  });

  it("gross book is per account: a long and an equal short in two accounts both count", () => {
    addDriverUnderlying();
    const s = stock("ZZLS", 50, 0.9, { sector: "Healthcare" });
    hold(s, 100, 1);
    hold(s, -100, 3);
    const r = run({ moves: [-0.1] });
    expect(r.positions).toHaveLength(2);
    expect(r.grossBookUsd).toBe(2 * 5000);
    for (const k of CASES) {
      expect(pos(r, "ZZLS", 1).cases[k].side).toBe("loses");
      expect(pos(r, "ZZLS", 3).cases[k].side).toBe("offsets");
      expect(r.cases[k].moves[0].bookPnlUsd).toBeCloseTo(0, 9);
    }
    expect(pos(r, "ZZLS", 3).accountName.length).toBeGreaterThan(0);
  });

  it("a foreign-currency unpriced option converts once; a currency with no rate is not modelled", () => {
    db.prepare("INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('ZZD', 0.5, ?, 'manual')").run(TODAY);
    addDriverUnderlying();
    const fx = option("QQQ", "PUT", 95, "2027-01-15", { currency: "ZZD" });
    hold(fx, 2);
    const none = option("QQQ", "PUT", 90, "2027-01-15", { currency: "ZZQ" });
    hold(none, 1);
    const r = run({ moves: [-0.1] });
    const direct = repriceOptionUnderShock(
      { strike_price: 95, own_price: null, underlying_price: 100, underlying_iv: 0.3, expiration_date: "2027-01-15", option_type: "PUT" },
      { underlyingMove: -0.1, riskFreeRate: getRiskFreeRate(db), today: TODAY, now: new Date(NOW), valuationDate: TODAY, modelWhenUnpriced: true },
    );
    if (!direct.modelled) throw new Error("must price");
    const p = pos(r, "QQQ P95 2027-01-15");
    for (const k of CASES) expect(p.cases[k].pnlByMove[0]).toBeCloseTo(direct.perShareChange * 2 * 100 * 0.5, 6);
    expect(p.valueUsd).toBeCloseTo(direct.v0 * 2 * 100 * 0.5, 6);
    expect(pos(r, "QQQ P90 2027-01-15")).toMatchObject({ unmodelledReason: "no-fx-rate", valueUsd: null });
  });

  it("a book of only unknown values prints share null, never 0% or NaN", () => {
    const s = addSecurity({ symbol: "ZZNP", type: "Stock" });
    hold(s, 100);
    const r = run();
    expect(r.grossBookUsd).toBe(0);
    for (const k of CASES) {
      expect(r.cases[k].disclosures.notModelled).toEqual({ count: 1, shareOfBook: null, unknownValueCount: 1, symbols: ["ZZNP"] });
      expect(r.cases[k].disclosures.noMeasuredLink.shareOfBook).toBeNull();
      expect(r.cases[k].disclosures.ownerFigure.shareOfBook).toBeNull();
    }
  });

  it("expired after the close contributes zero and is listed", () => {
    addDriverUnderlying();
    const put = option("QQQ", "PUT", 95, TODAY);
    price(put, 1);
    hold(put, 1);
    const r = run({ now: new Date("2026-11-10T21:00:00Z") });
    const p = pos(r, `QQQ P95 ${TODAY}`);
    expect(p.unmodelledReason).toBe("expired");
    for (const k of CASES) {
      expect(p.cases[k].pnlByMove.every((x) => x === 0)).toBe(true);
      expect(r.cases[k].disclosures.notModelled.symbols).toEqual([`QQQ P95 ${TODAY}`]);
    }
    expect(p.valueUsd).toBe(100);
  });

  it("empty scope reads nothing", () => {
    seedMixedBook();
    const spy = vi.spyOn(db, "prepare");
    const r = computeGainsAtRisk(db, { ...BASE, accountIds: [], betaOverrides: { 7: 1 } });
    expect(spy).not.toHaveBeenCalled();
    expect(r.positions).toEqual([]);
    for (const k of CASES) {
      expect(r.cases[k].moves.map((m) => m.bookPnlUsd)).toEqual(BASE.moves.map(() => 0));
      expect(r.cases[k].disclosures.notModelled).toEqual({ count: 0, shareOfBook: null, unknownValueCount: 0, symbols: [] });
      expect(r.cases[k].disclosures.noMeasuredLink.reasons["no-daily-bars"]).toBe(0);
    }
    expect(r.betaOverridesIgnored).toBe(1);
  });

  it("a scope reads only its own accounts", () => {
    seedMixedBook();
    const r = run({ accountIds: [3] });
    expect(r.positions.map((p) => p.symbol).sort()).toEqual(["QQQ C110 2027-01-15", "ZZB"]);
  });

  it("an impossible, past or blank input throws a worded error instead of printing zeros", () => {
    seedMixedBook();
    expect(() => run({ valuationDate: "2026-11-31" })).toThrow("valuationDate is not a valid date");
    expect(() => run({ valuationDate: "2026-11-09" })).toThrow("valuationDate is before today");
    expect(() => run({ driverSymbol: "  " })).toThrow("driverSymbol is required");
    expect(() => run({ moves: [Number.NaN] })).toThrow(/moves/);
    expect(() => run({ volChangePoints: Number.POSITIVE_INFINITY })).toThrow(/volChangePoints/);
    for (const bad of [
      { valuationDate: "2026-11-31" },
      { valuationDate: "2026-11-09" },
      { driverSymbol: "  " },
      { moves: [Number.NaN] },
      { moves: [-1.5] },
      { volChangePoints: Number.POSITIVE_INFINITY },
    ] as Partial<GainsAtRiskInput>[]) {
      expect(() => run(bad)).toThrow(GainsAtRiskInputError);
    }
  });

  it("exposure is the dollar change per unit driver move at today's prices, per case", () => {
    seedMixedBook();
    const r = run({ moves: [-0.1], valuationDate: "2026-12-18" });
    const a = pos(r, "ZZA");
    for (const k of CASES) expect(a.cases[k].exposureUsd).toBeCloseTo(a.valueUsd! * a.cases[k].beta!, 6);
    expect(pos(r, "ZZNP").cases.measured.exposureUsd).toBe(0);
    // ZZB (short, no measured link): nothing when measured, -value x 1 in the selloff case.
    expect(pos(r, "ZZB").cases.measured.exposureUsd).toBe(0);
    expect(pos(r, "ZZB").cases.selloff.exposureUsd).toBeCloseTo(-2000, 6);
  });

  it("a move below -100% is refused; exactly -100% is accepted with every figure finite", () => {
    const inv = addSecurity({ symbol: "ZZ3S", type: "ETF", name: "ZZ UltraPro Short 3X Index Fund", factor: -1 });
    price(inv, 20);
    hold(inv, 50);
    seedMixedBook();
    expect(() => run({ moves: [-1.5] })).toThrow("moves must be at least -1");
    const r = run({ moves: [-1] });
    for (const k of CASES) {
      for (const p of r.positions) for (const x of p.cases[k].pnlByMove) expect(Number.isFinite(x)).toBe(true);
      for (const m of r.cases[k].moves) {
        expect(Number.isFinite(m.bookPnlUsd)).toBe(true);
        expect(Number.isFinite(m.losersPnlUsd)).toBe(true);
        expect(Number.isFinite(m.offsetsPnlUsd)).toBe(true);
      }
      expect(pos(r, "ZZ3S").cases[k].pnlByMove[0]).toBeCloseTo(1000, 6);
    }
  });

  it("a priced row left out for no FX rate has no price source", () => {
    const f = stock("ZZFQ", 30, null, { sector: "Utilities", currency: "ZZQ" });
    hold(f, 10);
    const r = run();
    expect(pos(r, "ZZFQ")).toMatchObject({ unmodelledReason: "no-fx-rate", valueUsd: null, priceSource: null });
  });

  it("an override keyed to a non-option is refused as not an option", () => {
    const a = stock("ZZPS", 50, null);
    hold(a, 10);
    const b = addSecurity({ symbol: "ZZUS", type: "Stock", sector: "Technology" });
    hold(b, 10);
    const r = run({ priceOverrides: { [a]: 60, [b]: 60 } });
    expect(pos(r, "ZZPS")).toMatchObject({ overrideRefusal: "not-an-option", priceSource: "own-price", valueUsd: 500 });
    expect(pos(r, "ZZUS")).toMatchObject({ overrideRefusal: "not-an-option", unmodelledReason: "no-price", valueUsd: null, priceSource: null });
  });
});

describe("computeGainsAtRisk: the two cases (addendum)", () => {
  it("no measured link: a stock is exactly 0 in measured and moves 1:1 in selloff", () => {
    addDriverUnderlying();
    const s = stock("ZZNL", 50, null);
    hold(s, 100);
    const r = run();
    const p = pos(r, "ZZNL");
    expect(p.cases.measured.pnlByMove).toEqual([0, 0, 0, 0]);
    expect(p.cases.measured.beta).toBe(0);
    expect(p.cases.selloff.beta).toBe(1);
    expect(p.cases.selloff.pnlByMove).toEqual([-1000, -500, 0, 500].map((x) => expect.closeTo(x, 9)));
  });

  it("no measured link: options on it are still repriced at a 0% underlying move", () => {
    addDriverUnderlying();
    const u = stock("ZZU", 100, null);
    iv(u, 0.3);
    const call = option("ZZU", "CALL", 105, "2027-03-19");
    hold(call, 1);
    const put = option("ZZU", "PUT", 95, "2027-03-19");
    hold(put, -1);
    const valuationDate = addDays(TODAY, 30);
    const moves = [-0.1, 0, 0.1];
    const r = run({ moves, valuationDate });
    const c = pos(r, "ZZU C105 2027-03-19");
    const w = pos(r, "ZZU P95 2027-03-19");
    for (const p of [c, w]) {
      expect(p.unmodelledReason).toBeUndefined();
      expect(p.betaSource).toBe("no-measured-link");
      expect(p.cases.measured.beta).toBe(0);
      // Underlying held unchanged: one figure at every move (time decay only).
      expect(new Set(p.cases.measured.pnlByMove).size).toBe(1);
    }
    for (const x of c.cases.measured.pnlByMove) expect(x).toBeLessThan(0);
    for (const x of w.cases.measured.pnlByMove) expect(x).toBeGreaterThan(0);
    const direct = repriceOptionUnderShock(
      { strike_price: 105, own_price: null, underlying_price: 100, underlying_iv: 0.3, expiration_date: "2027-03-19", option_type: "CALL" },
      { underlyingMove: 0, riskFreeRate: getRiskFreeRate(db), today: TODAY, now: new Date(NOW), valuationDate, modelWhenUnpriced: true },
    );
    if (!direct.modelled) throw new Error("must price");
    expect(c.cases.measured.pnlByMove[0]).toBeCloseTo(direct.perShareChange * 100, 6);
    // The selloff case moves the underlying one-for-one.
    expect(c.cases.selloff.pnlByMove[0]).toBeLessThan(c.cases.selloff.pnlByMove[2]);
    expectConservation(r);
  });

  it("selloff floors 0.6 at 1, keeps 1.4, and turns -0.5 into 1", () => {
    addDriverUnderlying();
    hold(stock("ZZLO", 50, 0.6), 10);
    hold(stock("ZZHI", 50, 1.4), 10);
    hold(stock("ZZNG", 50, -0.5), 10);
    const r = run({ moves: [-0.1] });
    const want: Record<string, [number, number]> = { ZZLO: [0.6, 1], ZZHI: [1.4, 1.4], ZZNG: [-0.5, 1] };
    for (const [sym, [m, s]] of Object.entries(want)) {
      const p = pos(r, sym);
      expect(p.betaSource).toBe("measured");
      expect(p.measuredBeta).toBeCloseTo(m, 6);
      expect(p.cases.measured.beta).toBeCloseTo(m, 6);
      expect(p.cases.selloff.beta).toBeCloseTo(s, 6);
      expect(p.cases.selloff.pnlByMove[0]).toBeCloseTo(500 * -0.1 * s, 6);
    }
    // A negative measured beta is no protection in the selloff case.
    expect(pos(r, "ZZNG").cases.measured.side).toBe("offsets");
    expect(pos(r, "ZZNG").cases.selloff.side).toBe("loses");
  });

  it("a short of a negative-beta name loses in measured and offsets in selloff", () => {
    addDriverUnderlying();
    const s = stock("ZZNB", 50, -0.5);
    hold(s, -100);
    const r = run({ moves: [-0.1] });
    const p = pos(r, "ZZNB");
    expect(p.cases.measured.beta).toBeCloseTo(-0.5, 6);
    expect(p.cases.measured.side).toBe("loses");
    expect(p.cases.measured.pnlByMove[0]).toBeCloseTo(-250, 6);
    expect(p.cases.selloff.beta).toBe(1);
    expect(p.cases.selloff.side).toBe("offsets");
    expect(p.cases.selloff.pnlByMove[0]).toBeCloseTo(500, 6);
  });

  it("an inverse fund still offsets in the selloff case", () => {
    addDriverUnderlying();
    const t = addSecurity({ symbol: "ZZT", type: "ETF", name: "ZZ Tracked Index Fund" });
    bars(t, 0.8);
    const f = addSecurity({ symbol: "ZZ2I", type: "ETF", name: "ZZ UltraPro Short 2X Index Fund", factor: -2 });
    price(f, 25);
    hold(f, 40);
    const r = run({ moves: [-0.1] });
    const p = pos(r, "ZZ2I");
    expect(p.betaSource).toBe("leveraged");
    // Tracked index measured at 0.8: as measured when measured, floored at 1 in the selloff case.
    expect(p.cases.measured.beta).toBeCloseTo(-1.6, 6);
    expect(p.cases.selloff.beta).toBeCloseTo(-2, 9);
    for (const k of CASES) expect(p.cases[k].side).toBe("offsets");
    expect(p.cases.measured.pnlByMove[0]).toBeCloseTo(1000 * 0.16, 6);
    expect(p.cases.selloff.pnlByMove[0]).toBeCloseTo(1000 * 0.2, 6);
  });

  it("fixed rows are the same in both cases", () => {
    addDriverUnderlying();
    const mm = addSecurity({ symbol: "ZZMM", type: "Mutual Fund", fundCategory: "Cash Equivalent" });
    price(mm, 1);
    bars(mm, 1.5); // a measurable series never overrides a fixed value
    hold(mm, 1000);
    const bond = addSecurity({ symbol: "ZZBOND", type: "Bond" });
    price(bond, 98);
    hold(bond, 1000);
    const r = run({ moves: [-0.2] });
    expect(pos(r, "ZZMM").betaSource).toBe("fixed");
    expect(pos(r, "ZZBOND").betaSource).toBe("fixed");
    for (const sym of ["ZZMM", "ZZBOND"]) {
      expect(pos(r, sym).cases.selloff).toEqual(pos(r, sym).cases.measured);
    }
    expect(pos(r, "ZZMM").cases.measured.beta).toBe(0);
    expect(pos(r, "ZZBOND").cases.measured.beta).toBe(0.1);
  });

  it("an underlying held only through options takes one owner's figure for all its options", () => {
    addDriverUnderlying();
    const u = stock("ZZO", 100, null);
    iv(u, 0.3);
    const call = option("ZZO", "CALL", 105, "2027-01-15");
    hold(call, 1);
    const put = option("ZZO", "PUT", 95, "2027-01-15");
    hold(put, 2);
    const r = run({ moves: [-0.1], betaOverrides: { [u]: 0.4, [call]: 2, 99999: 1 } });
    for (const sym of ["ZZO C105 2027-01-15", "ZZO P95 2027-01-15"]) {
      const p = pos(r, sym);
      expect(p.betaSource).toBe("owner");
      expect(p.identitySecurityId).toBe(u);
      expect(p.noMeasuredLinkReason).toBe("no-daily-bars");
      expect(p.betaOverrideRefusal).toBeUndefined();
      for (const k of CASES) expect(p.cases[k].beta).toBe(0.4);
      expect(p.cases.selloff.pnlByMove).toEqual(p.cases.measured.pnlByMove);
    }
    // The option's own id is not an identity, and 99999 is nobody: both ignored and counted.
    expect(r.betaOverridesIgnored).toBe(2);
    for (const k of CASES) {
      expect(r.cases[k].disclosures.ownerFigure).toMatchObject({ count: 2 });
      expect(r.cases[k].disclosures.noMeasuredLink.count).toBe(0);
    }
  });

  it("an owner's figure is refused on a cash fund, the driver, out of bounds; an unknown id is ignored and counted", () => {
    const q = addDriverUnderlying();
    hold(q, 10);
    const qCall = option("QQQ", "CALL", 110, "2027-01-15");
    price(qCall, 2);
    hold(qCall, 1);
    const mm = addSecurity({ symbol: "ZZMM", type: "Mutual Fund", fundCategory: "Cash Equivalent" });
    price(mm, 1);
    hold(mm, 1000);
    const a = stock("ZZA", 50, 1.5);
    hold(a, 10);
    const b = stock("ZZB", 50, null);
    hold(b, 10);
    const c = stock("ZZC", 50, null);
    hold(c, 10);
    const d = stock("ZZD", 50, 1.2);
    hold(d, 10);
    const { min, max } = BETA_OVERRIDE_BOUNDS;
    const r = run({
      moves: [-0.1],
      betaOverrides: { [mm]: 0.5, [q]: 0.5, [a]: max + 0.5, [b]: Number.NaN, [c]: min, [d]: 0.3, 424242: 1 },
    });
    expect(pos(r, "ZZMM")).toMatchObject({ betaOverrideRefusal: "fixed-row", betaSource: "fixed" });
    expect(pos(r, "QQQ")).toMatchObject({ betaOverrideRefusal: "is-driver", betaSource: "driver" });
    expect(pos(r, "QQQ C110 2027-01-15")).toMatchObject({ betaOverrideRefusal: "is-driver", betaSource: "driver" });
    expect(pos(r, "ZZA")).toMatchObject({ betaOverrideRefusal: "out-of-bounds", betaSource: "measured" });
    expect(pos(r, "ZZA").cases.measured.beta).toBeCloseTo(1.5, 6);
    expect(pos(r, "ZZB")).toMatchObject({ betaOverrideRefusal: "out-of-bounds", betaSource: "no-measured-link" });
    // The bound itself is accepted; an owner's figure beats a measured beta in both cases.
    expect(pos(r, "ZZC").betaSource).toBe("owner");
    for (const k of CASES) expect(pos(r, "ZZC").cases[k].beta).toBe(min);
    expect(pos(r, "ZZD")).toMatchObject({ betaSource: "owner" });
    expect(pos(r, "ZZD").measuredBeta).toBeCloseTo(1.2, 6);
    for (const k of CASES) expect(pos(r, "ZZD").cases[k].beta).toBe(0.3);
    expect(r.betaOverridesIgnored).toBe(1);
  });

  it("driver bars missing: every measured candidate reports driver-bars-missing and betaEvidence.driverBarsMissing", () => {
    addDriverUnderlying(false);
    hold(stock("ZZA", 50, 1.5), 10);
    hold(stock("ZZB", 50, null), 10);
    const r = run({ moves: [-0.1] });
    for (const sym of ["ZZA", "ZZB"]) {
      const p = pos(r, sym);
      expect(p).toMatchObject({ betaSource: "no-measured-link", noMeasuredLinkReason: "driver-bars-missing" });
      expect(p.cases.measured.pnlByMove[0]).toBe(0);
      expect(p.cases.selloff.beta).toBe(1);
    }
    expect(r.betaEvidence).toEqual({ driverBarsThrough: null, driverBarsMissing: true, namesWaitingForBars: 0 });
    expect(r.cases.measured.disclosures.noMeasuredLink.reasons["driver-bars-missing"]).toBe(2);

    // No securities row for the driver at all: the same, never a throw.
    db.prepare("UPDATE securities SET ib_con_id = NULL WHERE symbol = 'QQQ'").run();
    const r2 = run({ moves: [-0.1] });
    expect(pos(r2, "ZZA").noMeasuredLinkReason).toBe("driver-bars-missing");
    expect(r2.betaEvidence.driverBarsMissing).toBe(true);
  });

  it("driver bars on file: betaEvidence names the last close before today", () => {
    addDriverUnderlying();
    hold(stock("ZZA", 50, 1.5), 10);
    const r = run({ moves: [-0.1] });
    expect(r.betaEvidence).toEqual({ driverBarsThrough: "2026-11-09", driverBarsMissing: false, namesWaitingForBars: 0 });
  });

  it("namesWaitingForBars counts no-daily-bars only", () => {
    db.prepare("INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('ZZD', 0.5, ?, 'manual')").run(TODAY);
    addDriverUnderlying();
    const none = stock("ZZW", 50, null);
    hold(none, 10, 1);
    hold(none, 5, 3); // the same name twice counts once
    const short = addSecurity({ symbol: "ZZSH", type: "Stock" });
    price(short, 50);
    bars(short, 1.2, 30);
    hold(short, 10);
    const foreign = stock("ZZFX", 50, 1.2, { currency: "ZZD" });
    hold(foreign, 10);
    const r = run({ moves: [-0.1] });
    expect(pos(r, "ZZSH").noMeasuredLinkReason).toBe("short-history");
    expect(pos(r, "ZZFX").noMeasuredLinkReason).toBe("foreign-session");
    expect(r.betaEvidence.namesWaitingForBars).toBe(1);
    expect(r.cases.measured.disclosures.noMeasuredLink.reasons).toEqual({
      "foreign-session": 1,
      "driver-bars-missing": 0,
      "no-daily-bars": 2,
      "short-history": 1,
      "flat-driver": 0,
      "low-fit": 0,
    });
    // A short-history beta exists in the evidence but is never used.
    expect(pos(r, "ZZSH").evidence?.beta).not.toBeNull();
    expect(pos(r, "ZZSH").measuredBeta).toBeNull();
    expect(pos(r, "ZZSH").cases.measured.beta).toBe(0);
  });

  it("conservation holds per case to the cent", () => {
    seedMixedBook();
    hold(stock("ZZNG", 50, -0.5), 10);
    const u = stock("ZZU", 100, null);
    iv(u, 0.3);
    const call = option("ZZU", "CALL", 105, "2027-03-19");
    hold(call, 3);
    const t = addSecurity({ symbol: "ZZT", type: "ETF" });
    bars(t, 0.8);
    const f = addSecurity({ symbol: "ZZ2I", type: "ETF", name: "ZZ UltraPro Short 2X Index Fund", factor: -2 });
    price(f, 25);
    hold(f, 40);
    const r = run({ moves: [-0.3, -0.2, -0.1, -0.05, 0, 0.05], valuationDate: "2026-12-18", volChangePoints: 10 });
    expectConservation(r);
    // The two cases differ where they should.
    expect(r.cases.selloff.moves[0].bookPnlUsd).not.toBeCloseTo(r.cases.measured.moves[0].bookPnlUsd, 2);
  });

  it("reads no benchmark_prices, no regression cache and no prices row beyond the loader's valuation read", () => {
    seedMixedBook();
    const t = addSecurity({ symbol: "ZZT", type: "ETF" });
    bars(t, 0.8);
    const f = addSecurity({ symbol: "ZZ2I", type: "ETF", name: "ZZ UltraPro Short 2X Index Fund", factor: -2 });
    price(f, 25);
    hold(f, 40);
    const loaderSpy = vi.spyOn(db, "prepare");
    loadScenarioPositionsByAccount(db, undefined, { today: TODAY });
    getRiskFreeRate(db);
    const allowed = new Set(loaderSpy.mock.calls.map((c) => String(c[0])));
    loaderSpy.mockRestore();

    const changes = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = changes();
    const spy = vi.spyOn(db, "prepare");
    run({ betaOverrides: { 7: 1 } });
    const sql = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    expect(sql.length).toBeGreaterThan(allowed.size);
    for (const s of sql) {
      expect(s).not.toMatch(/benchmark_prices|security_regressions|security_betas/);
      if (/\bprices\b/.test(s)) expect(allowed.has(s)).toBe(true);
    }
    expect(changes()).toBe(before);
  });

  it("one regression per identity per run: many options on one underlying do not re-read its bars", () => {
    addDriverUnderlying();
    const u = stock("ZZU", 100, 1.2);
    iv(u, 0.3);
    for (const k of [90, 95, 100, 105, 110]) hold(option("ZZU", "CALL", k, "2027-01-15"), 1);
    hold(u, 10);
    const spy = vi.spyOn(db, "prepare");
    run({ moves: [-0.1] });
    const barReads = spy.mock.calls.map((c) => String(c[0])).filter((s) => /FROM ohlcv_bars/.test(s) && !/COUNT/.test(s));
    spy.mockRestore();
    // The driver's bars once for the evidence line, then one regression (two bar reads) for ZZU.
    expect(barReads.length).toBe(3);
  });

});

describe("computeGainsAtRisk: review fix round 1", () => {
  it("equity-like is read through the type mapper in every spelling; other types keep their measured beta", () => {
    addDriverUnderlying();
    const spellings: [string, boolean][] = [
      ["mutual_fund", true],
      ["MUTUAL FUND", true],
      [" stock", true],
      ["etf", true],
      ["ADR", true],
      ["REIT", true],
      ["Closed-End Fund", true],
      ["Future", false],
      ["Forex", false],
      ["Warrant", false],
      ["Cash", false],
      ["ZZUnknownType", false],
    ];
    spellings.forEach(([type], i) => {
      const id = addSecurity({ symbol: `ZZT${i}`, type });
      price(id, 50);
      bars(id, -0.5);
      hold(id, 10);
    });
    const r = run({ moves: [-0.1] });
    spellings.forEach(([type, floored], i) => {
      const p = pos(r, `ZZT${i}`);
      expect(p.betaSource, type).toBe("measured");
      expect(p.cases.measured.beta, type).toBeCloseTo(-0.5, 6);
      if (floored) {
        expect(p.cases.selloff.beta, type).toBe(1);
        expect(p.cases.selloff.side, type).toBe("loses");
      } else {
        expect(p.cases.selloff.beta, type).toBeCloseTo(-0.5, 6);
        expect(p.cases.selloff.side, type).toBe("offsets");
      }
    });
  });

  it("an option on a mutual_fund-typed underlying is floored too", () => {
    addDriverUnderlying();
    const u = addSecurity({ symbol: "ZZMF", type: "mutual_fund" });
    price(u, 100);
    iv(u, 0.3);
    bars(u, -0.5);
    hold(option("ZZMF", "CALL", 100, "2027-01-15"), 1);
    const r = run({ moves: [-0.1] });
    expect(pos(r, "ZZMF C100 2027-01-15").cases.selloff.beta).toBe(1);
  });

  it("a row with no exposure takes its side from its own P&L: decay losses lose, decay gains offset", () => {
    addDriverUnderlying();
    const u = stock("ZZO", 100, null);
    iv(u, 0.3);
    hold(u, 10);
    const call = option("ZZO", "CALL", 105, "2027-03-19");
    hold(call, 1);
    const put = option("ZZO", "PUT", 95, "2027-03-19");
    hold(put, -3);
    const r = run({ moves: [-0.2, -0.1, 0, 0.1], valuationDate: "2026-12-18", betaOverrides: { [u]: 0 } });
    for (const k of CASES) {
      const c = pos(r, "ZZO C105 2027-03-19").cases[k];
      const w = pos(r, "ZZO P95 2027-03-19").cases[k];
      const s = pos(r, "ZZO").cases[k];
      expect(c.exposureUsd).toBe(0);
      expect(c.side).toBe("loses");
      expect(w.side).toBe("offsets");
      expect(s).toMatchObject({ side: "flat", exposureUsd: 0, pnlByMove: [0, 0, 0, 0] });
      for (const [i, m] of r.cases[k].moves.entries()) {
        expect(m.losersPnlUsd).toBeCloseTo(c.pnlByMove[i], 6);
        expect(m.offsetsPnlUsd).toBeCloseTo(w.pnlByMove[i], 6);
        expect(m.losersPnlUsd).toBeLessThan(0);
        expect(m.offsetsPnlUsd).toBeGreaterThan(0);
      }
    }
    expectConservation(r);
    // Measured case with no figure: the same rule (no measured link, held unchanged).
    const r2 = run({ moves: [-0.1], valuationDate: "2026-12-18" });
    expect(pos(r2, "ZZO C105 2027-03-19").cases.measured.side).toBe("loses");
    expect(pos(r2, "ZZO P95 2027-03-19").cases.measured.side).toBe("offsets");
    expect(pos(r2, "ZZO").cases.measured.side).toBe("flat");
    expectConservation(r2);
  });

  it("an owner's figure on a fund the ladder refused is used, and the refusal is carried", () => {
    addDriverUnderlying();
    const f = addSecurity({ symbol: "ZZ2L", type: "ETF", name: "ZZ Ultra 2X Sector Fund", factor: 2 });
    price(f, 25);
    hold(f, 40);
    const g = addSecurity({ symbol: "ZZ3X", type: "ETF", name: "ZZ UltraPro 3X Index Fund", factor: 3 });
    price(g, 50);
    hold(g, 10);
    const r = run({ moves: [-0.1], betaOverrides: { [f]: 1.5, [g]: 2 } });
    const p = pos(r, "ZZ2L");
    expect(p).toMatchObject({ betaSource: "owner", ladderRefusal: "leveraged-no-tracked-index" });
    expect(p.unmodelledReason).toBeUndefined();
    for (const k of CASES) {
      expect(p.cases[k].beta).toBe(1.5);
      expect(p.cases[k].pnlByMove[0]).toBeCloseTo(1000 * -0.15, 6);
    }
    // On a modelled fund the figure replaces the fund's whole move: no factor applied.
    const q = pos(r, "ZZ3X");
    expect(q.betaSource).toBe("owner");
    expect(q.ladderRefusal).toBeUndefined();
    for (const k of CASES) expect(q.cases[k].pnlByMove[0]).toBeCloseTo(500 * -0.2, 6);
    // Without a figure the refused fund carries no ladderRefusal field; its reason is the unmodelled reason.
    const r0 = run({ moves: [-0.1] });
    expect(pos(r0, "ZZ2L").unmodelledReason).toBe("leveraged-no-tracked-index");
    expect(pos(r0, "ZZ2L").ladderRefusal).toBeUndefined();
  });

  it("an owner's figure keyed to a row left out for no price or no FX rate is ignored and counted", () => {
    addDriverUnderlying();
    const np = addSecurity({ symbol: "ZZNP", type: "Stock" });
    hold(np, 10);
    const fx = stock("ZZFQ", 30, null, { currency: "ZZQ" });
    hold(fx, 10);
    const ok = stock("ZZOK", 30, null);
    hold(ok, 10);
    const r = run({ moves: [-0.1], betaOverrides: { [np]: 1, [fx]: 1, [ok]: 1 } });
    expect(r.betaOverridesIgnored).toBe(2);
    expect(pos(r, "ZZNP").betaSource).toBe("not-modelled");
    expect(pos(r, "ZZOK").betaSource).toBe("owner");
  });

  it("an option left out for an option reason never reads as measured; its underlying's evidence is kept apart", () => {
    addDriverUnderlying();
    const u = stock("ZZNV", 50, 1.2); // measured underlying, no IV
    hold(u, 10);
    const c = option("ZZNV", "CALL", 55, "2027-01-15");
    hold(c, 1);
    const r = run({ moves: [-0.1], betaOverrides: { [u]: 0.7 } });
    const p = pos(r, "ZZNV C55 2027-01-15");
    expect(p.unmodelledReason).toBe("no-volatility");
    expect(p.betaSource).toBe("not-modelled");
    expect(p.measuredBeta).toBeNull();
    for (const k of CASES) expect(p.cases[k]).toMatchObject({ beta: null, side: "flat", exposureUsd: 0, pnlByMove: [0] });
    expect(p.evidence?.outcome).toBe("measured");
    for (const k of CASES) {
      expect(r.cases[k].disclosures.notModelled.symbols).toEqual(["ZZNV C55 2027-01-15"]);
      expect(r.cases[k].disclosures.ownerFigure.symbols).toEqual(["ZZNV"]);
      expect(r.cases[k].disclosures.noMeasuredLink.count).toBe(0);
    }
    // The figure still applied to the stock, so the key is not ignored.
    expect(r.betaOverridesIgnored).toBe(0);
  });
});
