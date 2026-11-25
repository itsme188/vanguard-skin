import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

// Spy on the driver-bar reader without changing what it returns: a
// single-name run must never read the driver's bars (P20).
vi.mock("@/lib/queries/ohlcv", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/queries/ohlcv")>();
  return { ...m, getOhlcvBars: vi.fn(m.getOhlcvBars) };
});

import { getOhlcvBars } from "@/lib/queries/ohlcv";
import {
  computeGainsAtRisk,
  GAINS_AT_RISK_CASE_KEYS,
  GainsAtRiskInputError,
  type GainsAtRiskInput,
  type GainsAtRiskOptions,
  type GainsAtRiskPosition,
  type GainsAtRiskResult,
  type TrialPositionInput,
} from "@/lib/compute/gains-at-risk";
import { solveTrialEntry, trialCrossing } from "@/lib/compute/gains-at-risk-trial";
import { putPrice, yearsToExpiry } from "@/lib/compute/options-greeks";
import { repriceOptionUnderShock } from "@/lib/compute/option-reprice";
import { loadScenarioPositionsByAccount } from "@/lib/compute/scenario-positions";
import { getRiskFreeRate } from "@/lib/queries/risk-free-rate";

// Gains at risk step 3, task S1: one stock or fund as the driver. Synthetic
// ZZ tickers and invented round figures; clock 2026-11-10 15:00 UTC.
// ZZA is the driver, ZZA2 its share-class sibling (an injected family: the
// shipped map holds real tickers), ZZB another name, ZZQ an index fund, ZZL a
// 2x fund and ZZI an inverse fund, and ZZN an underlying with no row.

const NOW = "2026-11-10T15:00:00Z";
const TODAY = "2026-11-10";
const LATER = "2026-12-18";
const SWEEP = Array.from({ length: 17 }, (_, i) => Math.round((-0.4 + 0.05 * i) * 100) / 100);
const FAMILY = ["ZZA", "ZZA2"];
const siblingsOf = (s: string): readonly string[] => (FAMILY.includes(s.trim().toUpperCase()) ? FAMILY : [s]);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

let db: Database.Database;
let nextId = 100;
let nextKey = 0;
let nextConId = 8000;

function addSecurity(f: {
  symbol: string;
  type: string;
  name?: string;
  fundCategory?: string | null;
  factor?: number | null;
  underlying?: string;
  strike?: number;
  expiry?: string;
  optionType?: string;
  multiplier?: number;
}): number {
  const id = nextId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, fund_category, currency, leverage_factor,
       underlying_symbol, strike_price, expiration_date, option_type, multiplier, ib_con_id)
     VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    f.symbol,
    f.name ?? null,
    f.type,
    f.fundCategory ?? null,
    f.factor ?? null,
    f.underlying ?? null,
    f.strike ?? null,
    f.expiry ?? null,
    f.optionType ?? null,
    f.multiplier ?? 1,
    f.type === "Option" ? null : nextConId++,
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
  ).run(account, id, TODAY, qty, `sn-${++nextKey}`);
}

function stock(symbol: string, close: number, type = "Stock", extra: { name?: string; factor?: number | null } = {}): number {
  const id = addSecurity({ symbol, type, ...extra });
  price(id, close);
  iv(id, 0.3);
  return id;
}

function option(underlying: string, optionType: "PUT" | "CALL", strike: number, expiry: string, own?: number): number {
  const id = addSecurity({
    symbol: `${underlying} ${optionType[0]}${strike} ${expiry}`,
    type: "Option",
    underlying,
    strike,
    expiry,
    optionType,
    multiplier: 100,
  });
  if (own !== undefined) price(id, own);
  return id;
}

interface Ids {
  a: number;
  a2: number;
  b: number;
  q: number;
  aPut: number;
  aCall: number;
  a2Put: number;
  bPut: number;
}

/** The book: ZZA long and short, ZZA2, ZZB, ZZQ, options on ZZA, ZZA2 and ZZB. */
function seedBook(): Ids {
  const a = stock("ZZA", 100);
  hold(a, 100, 1);
  hold(a, -20, 3);
  const a2 = stock("ZZA2", 50);
  hold(a2, 40);
  const b = stock("ZZB", 40);
  hold(b, 200);
  const q = stock("ZZQ", 300, "ETF", { name: "ZZ Index Fund" });
  hold(q, 10);
  const aPut = option("ZZA", "PUT", 95, "2027-01-15", 6);
  hold(aPut, 2);
  const aCall = option("ZZA", "CALL", 105, "2027-01-15", 7);
  hold(aCall, 3);
  const a2Put = option("ZZA2", "PUT", 45, "2027-01-15", 3);
  hold(a2Put, 1);
  const bPut = option("ZZB", "PUT", 38, "2027-01-15", 2);
  hold(bPut, 4);
  return { a, a2, b, q, aPut, aCall, a2Put, bPut };
}

function input(ids: Ids, over: Partial<GainsAtRiskInput> = {}): GainsAtRiskInput {
  return {
    driverSymbol: "QQQ",
    driver: { kind: "single-name", symbol: "ZZA", securityId: ids.a },
    valuationDate: TODAY,
    moves: SWEEP,
    volChangePoints: 0,
    ...over,
  };
}

function run(inp: GainsAtRiskInput, opts: GainsAtRiskOptions = {}): GainsAtRiskResult {
  return computeGainsAtRisk(db, inp, { siblingsOf, trackedIndexSeeds: {}, ...opts });
}

function pos(r: GainsAtRiskResult, securityId: number, accountId?: number): GainsAtRiskPosition {
  const p = r.positions.find((x) => x.securityId === securityId && (accountId === undefined || x.accountId === accountId));
  if (!p) throw new Error(`no position ${securityId}`);
  return p;
}

function expectConservation(r: GainsAtRiskResult): void {
  for (const k of GAINS_AT_RISK_CASE_KEYS) {
    for (const [i, m] of r.cases[k].moves.entries()) {
      const rows = sum(r.positions.map((p) => p.cases[k].pnlByMove[i]));
      expect(Math.abs(m.bookPnlUsd - rows)).toBeLessThan(0.005);
      if (m.move === 0) {
        expect(m.split).toBe("none");
        expect(m.losersPnlUsd).toBe(0);
        expect(m.offsetsPnlUsd).toBe(0);
      } else {
        expect(m.split).toBe(m.move < 0 ? "down" : "up");
        expect(Math.abs(m.bookPnlUsd - (m.losersPnlUsd + m.offsetsPnlUsd))).toBeLessThan(0.005);
        const sideKey = m.move < 0 ? "sideDown" : "sideUp";
        const offsets = sum(r.positions.filter((p) => p.cases[k][sideKey] === "offsets").map((p) => p.cases[k].pnlByMove[i]));
        expect(Math.abs(m.offsetsPnlUsd - offsets)).toBeLessThan(0.005);
      }
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  nextId = 100;
  nextKey = 0;
  nextConId = 8000;
  vi.mocked(getOhlcvBars).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("computeGainsAtRisk: single-name driver (step 3)", () => {
  it("T2 conservation both directions: per move book = Σ rows = losers + offsets to the cent; zero row: book = Σ rows, split none", () => {
    const ids = seedBook();
    for (const over of [{}, { valuationDate: LATER, volChangePoints: 10 }]) {
      const r = run(input(ids, over));
      expect(r.cases.measured.moves.map((m) => m.move)).toEqual(SWEEP);
      expectConservation(r);
      // The zero row's total still carries the options' time value at a later date.
      if (over.valuationDate === LATER) expect(r.cases.measured.moves[8].bookPnlUsd).not.toBe(0);
    }
  });

  it("T3 what moves: ZZA and ZZA2 shares change by exactly value x move; an option on either repriced at the move; ZZB shares exactly 0; a ZZB option equals its time-only figure", () => {
    const ids = seedBook();
    const r = run(input(ids, { valuationDate: LATER }));
    for (const id of [ids.a, ids.a2]) {
      for (const p of r.positions.filter((x) => x.securityId === id)) {
        expect(p.betaSource).toBe("driver");
        for (const k of GAINS_AT_RISK_CASE_KEYS) {
          expect(p.cases[k].beta).toBe(1);
          SWEEP.forEach((m, i) => expect(p.cases[k].pnlByMove[i]).toBe(p.valueUsd! * m === 0 ? 0 : p.valueUsd! * m));
        }
      }
    }
    // An option on the driver or the sibling: priced exactly as an index run whose driver is that name.
    for (const [id, sym] of [[ids.aPut, "ZZA"], [ids.aCall, "ZZA"], [ids.a2Put, "ZZA2"]] as const) {
      const idx = computeGainsAtRisk(db, { driverSymbol: sym, valuationDate: LATER, moves: SWEEP, volChangePoints: 0 }, { trackedIndexSeeds: {} });
      expect(pos(r, id).betaSource).toBe("driver");
      expect(pos(r, id).cases.measured.pnlByMove).toEqual(pos(idx, id).cases.measured.pnlByMove);
      expect(new Set(pos(r, id).cases.measured.pnlByMove).size).toBeGreaterThan(1);
    }
    for (const id of [ids.b, ids.q]) {
      expect(pos(r, id).betaSource).toBe("held-unchanged");
      for (const k of GAINS_AT_RISK_CASE_KEYS) expect(pos(r, id).cases[k].pnlByMove.every((x) => x === 0)).toBe(true);
    }
    // ZZB's option: its value at the date at a 0% move and no volatility change, less its value now.
    const row = loadScenarioPositionsByAccount(db, undefined, { today: TODAY }).find((x) => x.security_id === ids.bPut)!;
    const t = repriceOptionUnderShock(row, {
      underlyingMove: 0, volChange: 0, riskFreeRate: getRiskFreeRate(db), today: TODAY, now: new Date(NOW), valuationDate: LATER, modelWhenUnpriced: true,
    });
    if (!t.modelled) throw new Error("ZZB put must price");
    const want = row.market_value * t.changePercent;
    const bPut = pos(r, ids.bPut);
    expect(bPut.betaSource).toBe("held-unchanged");
    expect(want).toBeLessThan(0);
    for (const x of bPut.cases.measured.pnlByMove) expect(Math.abs(x - want)).toBeLessThan(1e-9);
  });

  it("an option on ZZN (no row) is matched to a driver picked by symbol, securityId null, and is listed, never dropped", () => {
    const ids = seedBook();
    const nPut = option("ZZN", "PUT", 20, "2027-01-15", 1);
    hold(nPut, 5);
    const r = run(input(ids, { driver: { kind: "single-name", symbol: "zzn", securityId: null } }));
    expect(r.driverSymbol).toBe("ZZN");
    // The loader has no underlying price for a name with no row, so the
    // option cannot be repriced in any mode: it is listed as not modelled.
    const p = pos(r, nPut);
    expect(p.unmodelledReason).toBe("no-underlying-price");
    expect(r.cases.measured.disclosures.notModelled.symbols).toContain(p.symbol);
    // Every other name is held unchanged with ZZN as the driver, ZZA included.
    expect(pos(r, ids.a).betaSource).toBe("held-unchanged");
    expectConservation(r);
  });

  it("T4 +20 vol points: ZZB options equal the 0-point run; ZZA options change", () => {
    const ids = seedBook();
    const zero = run(input(ids, { valuationDate: LATER }));
    const up = run(input(ids, { valuationDate: LATER, volChangePoints: 20 }));
    expect(pos(up, ids.bPut).cases).toEqual(pos(zero, ids.bPut).cases);
    for (const id of [ids.aPut, ids.aCall, ids.a2Put]) {
      expect(pos(up, id).cases.measured.pnlByMove).not.toEqual(pos(zero, id).cases.measured.pnlByMove);
      expect(pos(up, id).cases.measured.pnlByMove[8]).toBeGreaterThan(pos(zero, id).cases.measured.pnlByMove[8]);
    }
  });

  it("fix 1: +20 vol points change a call on a seeded 2x fund and on a seeded inverse fund; not an option on an unrelated name", () => {
    const ids = seedBook();
    const l = stock("ZZL", 20, "ETF", { name: "ZZ UltraPro 2X ZZA Fund", factor: 2 });
    const inv = stock("ZZI", 30, "ETF", { name: "ZZ UltraShort ZZA Fund", factor: -1 });
    const lCall = option("ZZL", "CALL", 21, "2027-01-15", 2);
    hold(lCall, 1);
    const iCall = option("ZZI", "CALL", 31, "2027-01-15", 2);
    hold(iCall, 1);
    const opts = { trackedIndexSeeds: { ZZL: "ZZA", ZZI: "ZZA" } };
    const zero = run(input(ids, { valuationDate: LATER }), opts);
    const up = run(input(ids, { valuationDate: LATER, volChangePoints: 20 }), opts);
    for (const id of [lCall, iCall]) {
      expect(pos(up, id).betaSource).toBe("leveraged");
      expect(pos(up, id).cases.measured.pnlByMove[8]).toBeGreaterThan(pos(zero, id).cases.measured.pnlByMove[8]);
    }
    expect(pos(up, ids.bPut).cases).toEqual(pos(zero, ids.bPut).cases);
    // Unseeded, the same funds are held unchanged and their options ignore the volatility change.
    const zeroU = run(input(ids, { valuationDate: LATER }));
    const upU = run(input(ids, { valuationDate: LATER, volChangePoints: 20 }));
    for (const id of [lCall, iCall]) expect(pos(upU, id).cases).toEqual(pos(zeroU, id).cases);
    void l;
    void inv;
  });

  it("T5 betaOverrides on ZZB and ZZA: result equals the run without them; betaOverridesIgnored === 2", () => {
    const ids = seedBook();
    const plain = run(input(ids));
    const withFigures = run(input(ids, { betaOverrides: { [ids.b]: 0.5, [ids.a]: 2 } }));
    expect(plain.betaOverridesIgnored).toBe(0);
    expect(withFigures.betaOverridesIgnored).toBe(2);
    expect({ ...withFigures, betaOverridesIgnored: 0 }).toStrictEqual(plain);
  });

  it("T6 split: up row: short ZZA and a bought ZZA put lose, a bought ZZA call offsets; down row the reverse; an expiring row takes sideDown at -0.4 and sideUp at +0.4", () => {
    const ids = seedBook();
    // A written call that expires before the date: it keeps its premium in a fall, and is assigned in a rise.
    const exp = option("ZZA", "CALL", 105, "2026-11-20", 1);
    hold(exp, -1);
    // A bought put that expires before the date: the worse of the two orders loses its premium both ways.
    const expPut = option("ZZA", "PUT", 95, "2026-11-20", 1);
    hold(expPut, 2);
    const r = run(input(ids, { valuationDate: LATER }));
    for (const k of GAINS_AT_RISK_CASE_KEYS) {
      const short = pos(r, ids.a, 3).cases[k];
      const long = pos(r, ids.a, 1).cases[k];
      const put = pos(r, ids.aPut).cases[k];
      const call = pos(r, ids.aCall).cases[k];
      expect([short.sideUp, put.sideUp, call.sideUp, long.sideUp]).toEqual(["loses", "loses", "offsets", "offsets"]);
      expect([short.sideDown, put.sideDown, call.sideDown, long.sideDown]).toEqual(["offsets", "offsets", "loses", "loses"]);
      // `side` is the down side in this mode.
      for (const c of [short, long, put, call]) expect(c.side).toBe(c.sideDown);
      const e = pos(r, exp).cases[k];
      expect(pos(r, exp).expiresBeforeDate).toBe(true);
      const atDown = e.pnlByMove[0];
      const atUp = e.pnlByMove[SWEEP.length - 1];
      expect(atDown).toBeGreaterThan(0);
      expect(atUp).toBeLessThan(0);
      expect(e.sideDown).toBe("offsets");
      expect(e.sideUp).toBe("loses");
      const p = pos(r, expPut).cases[k];
      expect(p.pnlByMove[0]).toBeLessThan(0);
      expect(p.pnlByMove[SWEEP.length - 1]).toBeLessThan(0);
      expect([p.sideDown, p.sideUp]).toEqual(["loses", "loses"]);
    }
    expectConservation(r);
  });

  it("T7 seed { ZZL: 'ZZA' }: ZZL moves 2x, ZZI against; no seed: both held unchanged and listed under leveragedNotLinked", () => {
    const ids = seedBook();
    const l = stock("ZZL", 20, "ETF", { name: "ZZ UltraPro 2X ZZA Fund", factor: 2 });
    hold(l, 50);
    const inv = stock("ZZI", 30, "ETF", { name: "ZZ UltraShort ZZA Fund", factor: -1 });
    hold(inv, 30);
    const seeded = run(input(ids), { trackedIndexSeeds: { ZZL: "ZZA", ZZI: "ZZA2" } });
    for (const k of GAINS_AT_RISK_CASE_KEYS) {
      SWEEP.forEach((m, i) => {
        expect(pos(seeded, l).cases[k].pnlByMove[i]).toBeCloseTo(1000 * 2 * m, 9);
        expect(pos(seeded, inv).cases[k].pnlByMove[i]).toBeCloseTo(900 * -m, 9);
      });
    }
    expect(pos(seeded, l).betaSource).toBe("leveraged");
    expect(seeded.cases.measured.disclosures.leveragedNotLinked?.count).toBe(0);
    const unseeded = run(input(ids), { trackedIndexSeeds: { ZZL: "ZZQ" } });
    for (const id of [l, inv]) {
      expect(pos(unseeded, id).betaSource).toBe("leveraged-not-linked");
      for (const k of GAINS_AT_RISK_CASE_KEYS) expect(pos(unseeded, id).cases[k].pnlByMove.every((x) => x === 0)).toBe(true);
    }
    for (const k of GAINS_AT_RISK_CASE_KEYS) {
      expect(unseeded.cases[k].disclosures.leveragedNotLinked).toMatchObject({ count: 2, symbols: ["ZZI", "ZZL"] });
    }
    expectConservation(unseeded);
  });

  it("T8 a move of -0.81 or 1.01 throws; selectedMove not in moves throws", () => {
    const ids = seedBook();
    expect(() => run(input(ids, { moves: [-0.81, 0] }))).toThrow(GainsAtRiskInputError);
    expect(() => run(input(ids, { moves: [0, 1.01] }))).toThrow(GainsAtRiskInputError);
    expect(() => run(input(ids, { moves: [-0.8, 0, 1] }))).not.toThrow();
    expect(() => run(input(ids, { selectedMove: 0.33 }))).toThrow(GainsAtRiskInputError);
    expect(() => run(input(ids, { selectedMove: 0.25 }))).not.toThrow();
    expect(() => run(input(ids, { driver: { kind: "single-name", symbol: " ", securityId: null } }))).toThrow(GainsAtRiskInputError);
    expect(() => run(input(ids, { driver: { kind: "single-name", symbol: "ZZA", securityId: 1.5 } }))).toThrow(GainsAtRiskInputError);
    expect(() => run(input(ids, { driver: { kind: "other" } as unknown as GainsAtRiskInput["driver"] }))).toThrow(GainsAtRiskInputError);
    // Index mode keeps today's checks only: a +100% index move still prices (the route bounds it).
    expect(() => computeGainsAtRisk(db, { driverSymbol: "ZZQ", valuationDate: TODAY, moves: [1.01], volChangePoints: 0 })).not.toThrow();
  });

  it("P20 measured and selloff are toStrictEqual; driverKind 'single-name'; betaEvidence.notApplicable; driver bars never read (spy getOhlcvBars)", () => {
    const ids = seedBook();
    const r = run(input(ids, { valuationDate: LATER, volChangePoints: 5 }));
    expect(r.cases.measured).toStrictEqual(r.cases.selloff);
    for (const p of r.positions) expect(p.cases.measured).toStrictEqual(p.cases.selloff);
    expect(r.driverKind).toBe("single-name");
    expect(r.betaEvidence).toEqual({ driverBarsThrough: null, driverBarsMissing: false, namesWaitingForBars: 0, namesNotCaptured: 0, notApplicable: true });
    expect(vi.mocked(getOhlcvBars)).not.toHaveBeenCalled();
    for (const p of r.positions) {
      expect(p.evidence).toBeUndefined();
      expect(p.noMeasuredLinkReason).toBeUndefined();
    }
    // An index run on the same book does read the driver's bars.
    computeGainsAtRisk(db, { driverSymbol: "ZZQ", valuationDate: TODAY, moves: [-0.1], volChangePoints: 0 });
    expect(vi.mocked(getOhlcvBars)).toHaveBeenCalled();
  });

  it("a sweep with no negative move: no crash, sideDown present, every row split 'up' or 'none'", () => {
    const ids = seedBook();
    const exp = option("ZZA", "PUT", 95, "2026-11-20", 1);
    hold(exp, 2);
    const r = run(input(ids, { moves: [0, 0.1, 0.2], valuationDate: LATER }));
    expect(r.cases.measured.moves.map((m) => m.split)).toEqual(["none", "up", "up"]);
    for (const p of r.positions) {
      expect(p.cases.measured.sideDown).toBeDefined();
      expect(p.cases.measured.sideUp).toBeDefined();
    }
    expectConservation(r);
  });

  it("an empty scope prices the trial positions against no book, in this mode's shape", () => {
    const ids = seedBook();
    const r = run(input(ids, { accountIds: [], moves: [-0.1, 0, 0.1], trialPositions: [{ kind: "shares", id: "s", securityId: ids.a, side: "buy", quantity: 10, price: 100 }] }));
    expect(r.positions).toEqual([]);
    expect(r.driverKind).toBe("single-name");
    expect(r.betaEvidence.notApplicable).toBe(true);
    expect(r.cases.measured.moves.map((m) => m.split)).toEqual(["down", "none", "up"]);
    const t = r.trial!.cases.measured.moves.map((m) => m.trialPnlUsd);
    [-100, 0, 100].forEach((want, i) => expect(t[i]).toBeCloseTo(want, 9));
    expect(r.trial?.cases.measured.crossingDirection).toBe("fall");
    // Without trial positions the empty scope is still this mode's shape.
    const bare = run(input(ids, { accountIds: [], moves: [-0.1, 0, 0.1] }));
    expect(bare.driverKind).toBe("single-name");
    expect(bare.cases.measured.disclosures.leveragedNotLinked?.count).toBe(0);
  });

  it("trials: a ZZA trial put moves; a ZZB trial put shows time only; crossingDirection follows selectedMove", () => {
    const ids = seedBook();
    const T = yearsToExpiry("2027-01-15", TODAY, new Date(NOW));
    const rate = getRiskFreeRate(db);
    const trial = (id: string, sec: number, S: number, K: number): TrialPositionInput => {
      const p = putPrice(S, K, T, rate, 0.3);
      const s = solveTrialEntry({ right: "put", strike: K, expiry: "2027-01-15", price: p, underlyingPrice: S, riskFreeRate: rate, today: TODAY, now: new Date(NOW) });
      if (!s.ok) throw new Error("solve");
      return { kind: "option", id, underlyingSecurityId: sec, right: "put", side: "buy", expiry: "2027-01-15", strike: K, contracts: 2, pricePaid: p, entryUnderlyingPrice: S, valuationPriceAtEntry: S, entryVolatility: s.volatility };
    };
    const trialPositions = [trial("a", ids.a, 100, 95), trial("b", ids.b, 40, 38)];
    for (const [selectedMove, dir] of [[-0.2, "fall"], [0, "fall"], [0.2, "rise"], [undefined, "fall"]] as const) {
      const r = run(input(ids, { valuationDate: LATER, volChangePoints: 10, trialPositions, selectedMove }));
      const a = r.trial!.rows.find((x) => x.id === "a")!;
      const b = r.trial!.rows.find((x) => x.id === "b")!;
      expect(a.betaSource).toBe("driver");
      expect(new Set(a.cases.measured.pnlByMove).size).toBeGreaterThan(1);
      expect(b.betaSource).toBe("held-unchanged");
      expect(new Set(b.cases.measured.pnlByMove).size).toBe(1);
      expect(b.cases.measured.pnlByMove[0]).toBeLessThan(0);
      // The ZZB trial ignores the volatility change: equal to the 0-point run.
      const flat = run(input(ids, { valuationDate: LATER, trialPositions, selectedMove }));
      expect(b.cases).toEqual(flat.trial!.rows.find((x) => x.id === "b")!.cases);
      for (const k of GAINS_AT_RISK_CASE_KEYS) {
        const tc = r.trial!.cases[k];
        expect(tc.crossingDirection).toBe(dir);
        expect(tc.crossing).toEqual(trialCrossing(SWEEP, tc.moves.map((m) => m.trialPnlUsd), dir));
      }
    }
  });
});
