import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays } from "@/lib/calendar/date-utils";
import {
  computeGainsAtRisk,
  GainsAtRiskInputError,
  type GainsAtRiskInput,
  type GainsAtRiskResult,
} from "@/lib/compute/gains-at-risk";
import { repriceOptionUnderShock } from "@/lib/compute/option-reprice";
import { getRiskFreeRate } from "@/lib/queries/risk-free-rate";

// Gains at risk, Task 4: the engine. Driver QQQ, clock 2026-11-10 15:00 UTC
// (10:00 Eastern). Synthetic ZZ tickers and round numbers only; the driver
// and the broad market are benchmark symbols, never a held name.

const NOW = "2026-11-10T15:00:00Z";
const TODAY = "2026-11-10";
const DAYS = 60;
const SEEDS = { ZZ3X: "QQQ", ZZ3S: "QQQ" };

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

function spyCumLog(): number[] {
  const out = [0];
  for (let i = 1; i < DAYS; i++) out.push(out[i - 1] + 0.01 * Math.sin(i * 1.3) + 0.002 * Math.cos(i * 0.7));
  return out;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

let db: Database.Database;
let nextId = 100;
let nextKey = 0;

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
  id?: number;
}): number {
  const id = fields.id ?? nextId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector, fund_category, currency, leverage_factor,
       underlying_symbol, strike_price, expiration_date, option_type, multiplier)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

/** A price series that moves `multipleOfSpy` times SPY's log return each day. */
function series(id: number, multipleOfSpy: number, base = 100): void {
  const dates = tradingDates();
  const cum = spyCumLog();
  for (let i = 0; i < DAYS; i++) price(id, base * Math.exp(multipleOfSpy * cum[i]), dates[i]);
}

function bench(symbol: string, multipleOfSpy: number): void {
  const dates = tradingDates();
  const cum = spyCumLog();
  const ins = db.prepare("INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES (?, ?, ?, 'test')");
  for (let i = 0; i < DAYS; i++) ins.run(symbol, dates[i], 400 * Math.exp(multipleOfSpy * cum[i]));
}

/** QQQ held as a security, priced 100 with a broker IV: options on it have beta 1 to the driver. */
function addDriverUnderlying(): number {
  const id = addSecurity({ symbol: "QQQ", type: "ETF", name: "Driver index fund" });
  price(id, 100);
  iv(id, 0.3);
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

function pos(r: GainsAtRiskResult, symbol: string, accountId?: number) {
  const p = r.positions.find((x) => x.symbol === symbol && (accountId === undefined || x.accountId === accountId));
  if (!p) throw new Error(`no position ${symbol}`);
  return p;
}

const at = (r: GainsAtRiskResult, move: number) => {
  const i = r.moves.findIndex((m) => m.move === move);
  if (i < 0) throw new Error(`no move ${move}`);
  return i;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  nextId = 100;
  nextKey = 0;
  bench("SPY", 1);
  bench("QQQ", 1.25);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

/** A mixed book: stocks long and short, an ETF, cash, a bond, options own-priced and model-priced. */
function seedMixedBook(): void {
  const q = addDriverUnderlying();
  hold(q, 10);
  const a = addSecurity({ symbol: "ZZA", type: "Stock", sector: "Technology" });
  series(a, 1.5 * 1.25);
  hold(a, 20);
  const b = addSecurity({ symbol: "ZZB", type: "Stock", sector: "Utilities" });
  price(b, 40);
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

describe("computeGainsAtRisk", () => {
  it("conservation: book = Σ rows = losers + offsets, to the cent, for every move", () => {
    seedMixedBook();
    const r = run();
    expect(r.moves.map((m) => m.move)).toEqual(BASE.moves);
    for (const [i, m] of r.moves.entries()) {
      expect(Math.abs(m.bookPnlUsd - sum(r.positions.map((p) => p.pnlByMove[i])))).toBeLessThan(0.005);
      expect(Math.abs(m.bookPnlUsd - (m.losersPnlUsd + m.offsetsPnlUsd))).toBeLessThan(0.005);
      expect(Math.abs(m.offsetsPnlUsd - sum(r.positions.filter((p) => p.side === "offsets").map((p) => p.pnlByMove[i])))).toBeLessThan(0.005);
    }
    // Every held row lands somewhere: nine securities, ten rows (none dropped).
    expect(r.positions).toHaveLength(9);
    expect(pos(r, "ZZNP").unmodelledReason).toBe("no-price");
    // The long put and the short stock offset a fall; the long stock loses.
    expect(pos(r, "ZZA").side).toBe("loses");
    expect(pos(r, "ZZB").side).toBe("offsets");
    expect(pos(r, "QQQ P95 2027-01-15").side).toBe("offsets");
    expect(pos(r, "ZZMM").side).toBe("flat");
  });

  it("identity at rest: 0% today with no vol change is zero for every position", () => {
    seedMixedBook();
    const r = run({ moves: [0] });
    for (const p of r.positions) expect(p.pnlByMove[0]).toBe(0);
    expect(r.moves[0]).toEqual({ move: 0, bookPnlUsd: 0, losersPnlUsd: 0, offsetsPnlUsd: 0 });
  });

  it("time decay: 0% at a later date loses on a long option, gains on a written one, nothing on a stock", () => {
    seedMixedBook();
    const r = run({ moves: [0], valuationDate: "2026-12-18" });
    expect(pos(r, "QQQ P95 2027-01-15").pnlByMove[0]).toBeLessThan(0);
    expect(pos(r, "QQQ P90 2027-01-15").pnlByMove[0]).toBeLessThan(0);
    expect(pos(r, "QQQ C110 2027-01-15").pnlByMove[0]).toBeGreaterThan(0);
    expect(pos(r, "ZZA").pnlByMove[0]).toBe(0);
    expect(pos(r, "QQQ").pnlByMove[0]).toBe(0);
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
    // Long put: the move lands after expiry, so the time value is lost and the fall pays nothing.
    expect(pos(r, "QQQ P95 2026-11-20").pnlByMove[0]).toBeCloseTo((0 - l.v0) * 2 * 100, 6);
    // Written put: the move lands first and the put is exercised at the moved price.
    expect(pos(r, "QQQ P90 2026-11-20").pnlByMove[0]).toBeCloseTo((10 - s.v0) * -1 * 100, 6);
    expect(pos(r, "QQQ P90 2026-11-20").pnlByMove[0]).toBeLessThan(0);
    expect(r.disclosures.expiresBeforeDate.count).toBe(2);
    expect(r.disclosures.expiresBeforeDate.symbols).toEqual(["QQQ P90 2026-11-20", "QQQ P95 2026-11-20"]);
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
    expect(pos(r, "QQQ P95 2026-11-20").pnlByMove[0]).toBeCloseTo((15 - l.v0) * 100, 6);
    expect(pos(r, "QQQ P95 2026-11-20").expiresBeforeDate).toBeUndefined();
  });

  it("leveraged: a 3x fund on the driver moves three times, not nine; an inverse fund gains in a fall", () => {
    const bull = addSecurity({ symbol: "ZZ3X", type: "ETF", name: "ZZ UltraPro 3X Index Fund", factor: 3 });
    series(bull, 9 * 1.25, 50); // its own regression against QQQ would read 9
    hold(bull, 10);
    const bear = addSecurity({ symbol: "ZZ3S", type: "ETF", name: "ZZ UltraPro Short 3X Index Fund", factor: -3 });
    price(bear, 20);
    hold(bear, 50);
    const r = run({ moves: [-0.1] });
    const b = pos(r, "ZZ3X");
    expect(b.betaSource).toBe("leveraged");
    expect(b.assumedMovePerUnitDriver).toBe(3);
    expect(b.pnlByMove[0]).toBeCloseTo(b.valueUsd! * -0.3, 6);
    const s = pos(r, "ZZ3S");
    expect(s.assumedMovePerUnitDriver).toBe(-3);
    expect(s.pnlByMove[0]).toBeCloseTo(1000 * 0.3, 6);
    expect(s.side).toBe("offsets");
  });

  it("leveraged with a factor but no tracked index is not modelled and listed", () => {
    const f = addSecurity({ symbol: "ZZ2L", type: "ETF", name: "ZZ Ultra 2X Sector Fund", factor: 2 });
    price(f, 25);
    hold(f, 40);
    const r = run();
    const p = pos(r, "ZZ2L");
    expect(p).toMatchObject({ unmodelledReason: "leveraged-no-tracked-index", side: "flat", betaSource: "not-modelled", valueUsd: 1000 });
    expect(p.pnlByMove.every((x) => x === 0)).toBe(true);
    expect(r.disclosures.notModelled).toMatchObject({ count: 1, symbols: ["ZZ2L"], shareOfBook: 1, unknownValueCount: 0 });
  });

  it("an option on the driver with no underlying row has beta 1 through the loader", () => {
    const c = option("QQQ", "CALL", 100, "2027-01-15");
    price(c, 5);
    hold(c, 1);
    const r = run();
    const p = pos(r, "QQQ C100 2027-01-15");
    expect(p.beta).toBe(1);
    expect(p.betaSource).toBe("driver");
    // No underlying row means no underlying price: listed, never priced from a guess.
    expect(p.unmodelledReason).toBe("no-underlying-price");
    expect(p.valueUsd).toBe(500);
  });

  it("unpriced option: modelled from the broker IV and flagged; with no IV listed with value unknown", () => {
    addDriverUnderlying();
    const put = option("QQQ", "PUT", 95, "2027-01-15");
    hold(put, 2);
    const u = addSecurity({ symbol: "ZZNV", type: "Stock", sector: "Technology" });
    price(u, 50);
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
    expect(p.pnlByMove[0]).toBeCloseTo(direct.perShareChange * 2 * 100, 6);
    expect(r.disclosures.pricedFromModel).toMatchObject({ count: 1, symbols: ["QQQ P95 2027-01-15"] });
    const n = pos(r, "ZZNV C55 2027-01-15");
    expect(n).toMatchObject({ unmodelledReason: "no-volatility", valueUsd: null });
    expect(r.disclosures.notModelled.unknownValueCount).toBe(1);
    expect(r.unknownValueCount).toBe(1);
    const modelGross = r.grossBookUsd;
    expect(modelGross).toBeCloseTo(direct.v0 * 200, 6);

    // An accepted override sets the value; clearing it returns the model figures.
    const withOverride = run({ moves: [-0.1], priceOverrides: { [put]: 4 } });
    const o = pos(withOverride, "QQQ P95 2027-01-15");
    expect(o.priceSource).toBe("override");
    expect(o.valueUsd).toBeCloseTo(4 * 2 * 100, 9);
    expect(withOverride.grossBookUsd).toBeCloseTo(800, 9);
    expect(withOverride.disclosures.pricedFromModel.count).toBe(0);
    const cleared = run({ moves: [-0.1] });
    expect(pos(cleared, "QQQ P95 2027-01-15").valueUsd).toBeCloseTo(direct.v0 * 200, 9);
    expect(cleared.grossBookUsd).toBeCloseTo(modelGross, 9);
  });

  it("an unpriced stock is listed as not modelled, never dropped", () => {
    const s = addSecurity({ symbol: "ZZNP", type: "Stock", sector: "Industrials" });
    hold(s, 100);
    const r = run();
    expect(pos(r, "ZZNP")).toMatchObject({ unmodelledReason: "no-price", valueUsd: null, side: "flat", priceSource: null });
    expect(r.disclosures.notModelled.symbols).toEqual(["ZZNP"]);
  });

  it("overrides: accepted, below intrinsic, and above the no-arbitrage bound", () => {
    addDriverUnderlying();
    const put = option("QQQ", "PUT", 95, "2027-01-15");
    hold(put, 1);
    const itm = option("QQQ", "PUT", 120, "2027-01-15");
    hold(itm, 1);
    const call = option("ZZC", "CALL", 50, "2027-01-15");
    const c = addSecurity({ symbol: "ZZC", type: "Stock", sector: "Technology" });
    price(c, 60);
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

  it("beta source: measured when the gate passes, otherwise estimated, flagged and counted", () => {
    const m = addSecurity({ symbol: "ZZME", type: "Stock", sector: "Technology" });
    series(m, 1.5 * 1.25);
    hold(m, 10);
    const e = addSecurity({ symbol: "ZZES", type: "Stock", sector: "Technology" });
    price(e, 50);
    hold(e, 10);
    const r = run({ moves: [-0.1] });
    const mp = pos(r, "ZZME");
    expect(mp.betaSource).toBe("measured");
    expect(mp.beta).toBeCloseTo(1.5, 6);
    const ep = pos(r, "ZZES");
    expect(ep.betaSource).toBe("estimated");
    // Technology heuristic 1.15 converted through QQQ's own SPY beta (1.25).
    expect(ep.beta).toBeCloseTo(1.15 / 1.25, 6);
    expect(ep.pnlByMove[0]).toBeCloseTo(500 * -0.1 * (1.15 / 1.25), 6);
    expect(ep.exposureUsd).toBeCloseTo(500 * (1.15 / 1.25), 6);
    expect(r.disclosures.betaEstimated).toMatchObject({ count: 1, symbols: ["ZZES"] });
    expect(r.disclosures.betaEstimated.shareOfBook).toBeCloseTo(500 / r.grossBookUsd, 9);
  });

  it("gross book is per account: a long and an equal short in two accounts both count", () => {
    const s = addSecurity({ symbol: "ZZLS", type: "Stock", sector: "Healthcare" });
    price(s, 50);
    hold(s, 100, 1);
    hold(s, -100, 3);
    const r = run({ moves: [-0.1] });
    expect(r.positions).toHaveLength(2);
    expect(r.grossBookUsd).toBe(2 * 5000);
    expect(pos(r, "ZZLS", 1).side).toBe("loses");
    expect(pos(r, "ZZLS", 3).side).toBe("offsets");
    expect(r.moves[0].bookPnlUsd).toBeCloseTo(0, 9);
    expect(pos(r, "ZZLS", 3).accountName.length).toBeGreaterThan(0);
  });

  it("a short of a negative-beta name loses in a fall", () => {
    const s = addSecurity({ symbol: "ZZNB", type: "Stock" });
    series(s, -0.5 * 1.25);
    hold(s, -100);
    const r = run({ moves: [-0.1] });
    const p = pos(r, "ZZNB");
    expect(p.beta).toBeCloseTo(-0.5, 6);
    expect(p.side).toBe("loses");
    expect(p.pnlByMove[0]).toBeLessThan(0);
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
    expect(p.pnlByMove[0]).toBeCloseTo(direct.perShareChange * 2 * 100 * 0.5, 6);
    expect(p.valueUsd).toBeCloseTo(direct.v0 * 2 * 100 * 0.5, 6);
    expect(pos(r, "QQQ P90 2027-01-15")).toMatchObject({ unmodelledReason: "no-fx-rate", valueUsd: null });
  });

  it("a book of only unknown values prints share null, never 0% or NaN", () => {
    const s = addSecurity({ symbol: "ZZNP", type: "Stock" });
    hold(s, 100);
    const r = run();
    expect(r.grossBookUsd).toBe(0);
    expect(r.disclosures.notModelled).toEqual({ count: 1, shareOfBook: null, unknownValueCount: 1, symbols: ["ZZNP"] });
    expect(r.disclosures.betaEstimated.shareOfBook).toBeNull();
  });

  it("expired after the close contributes zero and is listed", () => {
    addDriverUnderlying();
    const put = option("QQQ", "PUT", 95, TODAY);
    price(put, 1);
    hold(put, 1);
    const r = run({ now: new Date("2026-11-10T21:00:00Z") });
    const p = pos(r, `QQQ P95 ${TODAY}`);
    expect(p.unmodelledReason).toBe("expired");
    expect(p.pnlByMove.every((x) => x === 0)).toBe(true);
    expect(p.valueUsd).toBe(100);
    expect(r.disclosures.notModelled.symbols).toEqual([`QQQ P95 ${TODAY}`]);
  });

  it("empty scope reads nothing", () => {
    seedMixedBook();
    const spy = vi.spyOn(db, "prepare");
    const r = computeGainsAtRisk(db, { ...BASE, accountIds: [] });
    expect(spy).not.toHaveBeenCalled();
    expect(r.positions).toEqual([]);
    expect(r.moves.map((m) => m.bookPnlUsd)).toEqual(BASE.moves.map(() => 0));
    expect(r.disclosures.notModelled).toEqual({ count: 0, shareOfBook: null, unknownValueCount: 0, symbols: [] });
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
    // Every input refusal is typed, so the route answers 400 by class, never by message.
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

  it("exposure is the dollar change per unit driver move at today's prices", () => {
    seedMixedBook();
    const r = run({ moves: [-0.1], valuationDate: "2026-12-18" });
    const a = pos(r, "ZZA");
    expect(a.exposureUsd).toBeCloseTo(a.valueUsd! * a.beta!, 6);
    expect(pos(r, "ZZNP").exposureUsd).toBe(0);
  });

  it("a move below -100% is refused; exactly -100% is accepted with every figure finite", () => {
    const inv = addSecurity({ symbol: "ZZ3S", type: "ETF", name: "ZZ UltraPro Short 3X Index Fund", factor: -1 });
    price(inv, 20);
    hold(inv, 50);
    seedMixedBook();
    expect(() => run({ moves: [-1.5] })).toThrow("moves must be at least -1");
    const r = run({ moves: [-1] });
    for (const p of r.positions) for (const x of p.pnlByMove) expect(Number.isFinite(x)).toBe(true);
    for (const m of r.moves) {
      expect(Number.isFinite(m.bookPnlUsd)).toBe(true);
      expect(Number.isFinite(m.losersPnlUsd)).toBe(true);
      expect(Number.isFinite(m.offsetsPnlUsd)).toBe(true);
    }
    // The inverse fund can gain at most its whole value.
    expect(pos(r, "ZZ3S").pnlByMove[0]).toBeCloseTo(1000, 6);
  });

  it("a priced row left out for no FX rate has no price source", () => {
    const f = addSecurity({ symbol: "ZZFQ", type: "Stock", sector: "Utilities", currency: "ZZQ" });
    price(f, 30);
    hold(f, 10);
    const r = run();
    expect(pos(r, "ZZFQ")).toMatchObject({ unmodelledReason: "no-fx-rate", valueUsd: null, priceSource: null });
  });

  it("an override keyed to a non-option is refused as not an option", () => {
    const a = addSecurity({ symbol: "ZZPS", type: "Stock", sector: "Technology" });
    price(a, 50);
    hold(a, 10);
    const b = addSecurity({ symbol: "ZZUS", type: "Stock", sector: "Technology" });
    hold(b, 10);
    const r = run({ priceOverrides: { [a]: 60, [b]: 60 } });
    expect(pos(r, "ZZPS")).toMatchObject({ overrideRefusal: "not-an-option", priceSource: "own-price", valueUsd: 500 });
    expect(pos(r, "ZZUS")).toMatchObject({ overrideRefusal: "not-an-option", unmodelledReason: "no-price", valueUsd: null, priceSource: null });
  });
});

