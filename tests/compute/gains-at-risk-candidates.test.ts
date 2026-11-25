import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays } from "@/lib/calendar/date-utils";

// Spies that keep the real behaviour: the book loader must run once per
// request (T11), and call 2 must never solve an entry again (T16).
vi.mock("@/lib/compute/scenario-positions", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/compute/scenario-positions")>();
  return { ...m, loadScenarioPositionsByAccount: vi.fn(m.loadScenarioPositionsByAccount) };
});
vi.mock("@/lib/compute/gains-at-risk-trial", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/compute/gains-at-risk-trial")>();
  return { ...m, solveTrialEntry: vi.fn(m.solveTrialEntry) };
});

import { loadScenarioPositionsByAccount } from "@/lib/compute/scenario-positions";
import { buildTrialEntryById, solveTrialEntry } from "@/lib/compute/gains-at-risk-trial";
import {
  computeGainsAtRisk,
  GAINS_AT_RISK_CASE_KEYS,
  GainsAtRiskInputError,
  type GainsAtRiskInput,
  type GainsAtRiskOptions,
  type TrialPositionInput,
} from "@/lib/compute/gains-at-risk";
import { computeGainsAtRiskCandidates, type CandidateRow } from "@/lib/compute/gains-at-risk-candidates";
import type { CandidateRequestItem } from "@/lib/compute/gains-at-risk-candidate-check";
import { budgetToUnits, sizeCandidate, toMoneyUnits, unitsToUsd } from "@/lib/analysis/gains-at-risk-candidate-money";
import { getRiskFreeRate } from "@/lib/queries/risk-free-rate";
import { putPrice, yearsToExpiry } from "@/lib/compute/options-greeks";

// Gains at risk step 3, task S3: candidates on one run. Synthetic ZZ tickers
// and invented round figures; clock 2026-11-10 15:00 UTC (10:00 Eastern).
// ZZQ is the index driver (its own bars), ZZA moves 1.5x it, ZZB has no bars
// (no measured link), ZZA2 is ZZA's share-class sibling (injected family).

const NOW = "2026-11-10T15:00:00Z";
const TODAY = "2026-11-10";
const EXPIRY = "2027-01-15";
const DAYS = 120;
const FAMILY = ["ZZA", "ZZA2"];
const OPTS: GainsAtRiskOptions = {
  siblingsOf: (s) => (FAMILY.includes(s.trim().toUpperCase()) ? FAMILY : [s]),
};

let db: Database.Database;
let nextId = 100;
let nextKey = 0;
let nextConId = 9000;

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

function bars(id: number, multiple: number): void {
  const dates = tradingDates();
  const ins = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, 1000)`,
  );
  let cum = 0;
  for (let i = 0; i < DAYS; i++) {
    if (i > 0) cum += 0.01 * Math.sin(i * 1.3) + 0.002 * Math.cos(i * 0.7);
    const c = 100 * Math.exp(multiple * cum);
    ins.run(id, dates[i], c, c, c, c);
  }
}

function addSecurity(f: {
  symbol: string;
  type: string;
  underlying?: string;
  strike?: number;
  expiry?: string;
  optionType?: string;
  conId?: number | null;
}): number {
  const id = nextId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, currency, underlying_symbol, strike_price,
       expiration_date, option_type, multiplier, ib_con_id)
     VALUES (?, ?, NULL, ?, 'USD', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    f.symbol,
    f.type,
    f.underlying ?? null,
    f.strike ?? null,
    f.expiry ?? null,
    f.optionType ?? null,
    f.type === "Option" ? 100 : 1,
    f.conId === undefined ? (f.type === "Option" ? null : nextConId++) : f.conId,
  );
  return id;
}

function price(id: number, close: number): void {
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-11-09', ?, 'test')").run(id, close);
}

function hold(id: number, qty: number, account = 1): void {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (?, ?, ?, ?, ?)",
  ).run(account, id, TODAY, qty, `cand-${++nextKey}`);
}

function stock(symbol: string, close: number, beta: number | null, type = "Stock"): number {
  const id = addSecurity({ symbol, type });
  price(id, close);
  if (beta !== null) bars(id, beta);
  return id;
}

interface Book {
  q: number;
  a: number;
  a2: number;
  b: number;
}

/** The book: ZZQ (the driver), ZZA long, ZZB short, ZZA2, a held put on ZZQ. */
function seedBook(): Book {
  const q = stock("ZZQ", 100, 1, "ETF");
  hold(q, 10);
  const a = stock("ZZA", 50, 1.5);
  hold(a, 20);
  const a2 = stock("ZZA2", 50, null);
  hold(a2, 10);
  const b = stock("ZZB", 40, null);
  hold(b, -50, 3);
  const put = addSecurity({ symbol: "ZZQ P95", type: "Option", underlying: "ZZQ", strike: 95, expiry: EXPIRY, optionType: "PUT" });
  price(put, 3);
  hold(put, 2);
  return { q, a, a2, b };
}

const BASE: GainsAtRiskInput = {
  driverSymbol: "ZZQ",
  valuationDate: TODAY,
  moves: [-0.2, -0.1, 0, 0.1],
  volChangePoints: 0,
};

/** A trial put fixed at the click from a model price (R1). */
function trialPut(id: string, underlyingSecurityId: number, strike: number, contracts: number, S = 100): TrialPositionInput {
  const T = yearsToExpiry(EXPIRY, TODAY, new Date(NOW));
  const r = getRiskFreeRate(db);
  const pricePaid = putPrice(S, strike, T, r, 0.3);
  return {
    kind: "option",
    id,
    underlyingSecurityId,
    right: "put",
    side: "buy",
    expiry: EXPIRY,
    strike,
    contracts,
    pricePaid,
    entryUnderlyingPrice: S,
    valuationPriceAtEntry: S,
    entryVolatility: 0.3,
  };
}

/** Call 1, for a test: the entry solved by id at the quote's own underlying, wrapped as call 2's item. */
function candidate(
  conId: number,
  underlyingSecurityId: number,
  right: "put" | "call",
  strike: number,
  bid: number,
  ask: number,
  underlyingPrice: number,
  expiry = EXPIRY,
): CandidateRequestItem {
  const mid = (bid + ask) / 2;
  const entry = buildTrialEntryById(
    db,
    { kind: "option", underlyingSecurityId, right, side: "buy", expiry, strike, contracts: 1, price: mid, quotedUnderlyingPrice: underlyingPrice, brokerContractId: conId },
    { now: () => new Date(NOW) },
  );
  if (!entry.ok || entry.position.kind !== "option") throw new Error(`candidate ${conId} must solve: ${JSON.stringify(entry)}`);
  const p = entry.position;
  return {
    conId,
    underlyingSecurityId,
    right,
    expiry,
    strike,
    multiplier: 100,
    tradingClass: "ZZQ",
    quote: {
      bid,
      ask,
      mid,
      tickKind: "live",
      session: "regular-session",
      optionObservedAt: NOW,
      underlyingObservedAt: NOW,
      underlyingPrice,
    },
    entry: {
      kind: "option",
      underlyingSecurityId: p.underlyingSecurityId,
      right: p.right,
      side: "buy",
      expiry: p.expiry,
      strike: p.strike,
      contracts: p.contracts,
      pricePaid: p.pricePaid,
      entryUnderlyingPrice: p.entryUnderlyingPrice,
      valuationPriceAtEntry: p.valuationPriceAtEntry,
      entryVolatility: p.entryVolatility,
      brokerContractId: p.brokerContractId as number,
    },
  };
}

/** The position a priced row stands for, as a trial at its size (what Add sends). */
function asTrial(item: CandidateRequestItem, contracts: number, id = `t${item.conId}`): TrialPositionInput {
  const { kind: _k, ...e } = item.entry;
  return { kind: "option", id, ...e, contracts };
}

function priced(row: CandidateRow): Extract<CandidateRow, { status: "priced" }> {
  if (row.status !== "priced") throw new Error(`row ${row.conId} is ${row.status}`);
  return row;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  nextId = 100;
  nextKey = 0;
  nextConId = 9000;
  vi.mocked(loadScenarioPositionsByAccount).mockClear();
  vi.mocked(solveTrialEntry).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

/** T9: for every priced row, case and move, (book + trials + row) − (book + trials) = the row's own figure, by a second run. */
function expectT9(input: GainsAtRiskInput, items: CandidateRequestItem[], rows: CandidateRow[]): void {
  const trials = input.trialPositions ?? [];
  const without = computeGainsAtRisk(db, { ...input, trialPositions: [...trials, asTrial(items[0], 1, "anchor")] }, OPTS);
  for (const [n, row] of rows.entries()) {
    if (row.status !== "priced") continue;
    const withIt = computeGainsAtRisk(
      db,
      { ...input, trialPositions: [...trials, asTrial(items[0], 1, "anchor"), asTrial(items[n], row.contracts)] },
      OPTS,
    );
    for (const k of GAINS_AT_RISK_CASE_KEYS) {
      for (const [i, m] of (withIt.trial?.cases[k].moves ?? []).entries()) {
        const diff = m.bookWithTrialPnlUsd - (without.trial?.cases[k].moves[i].bookWithTrialPnlUsd as number);
        expect(Math.abs(diff - row.engine.cases![k].pnlByMove[i]), `${row.conId} ${k} ${m.move}`).toBeLessThan(0.005 + 1e-9);
      }
    }
  }
}

describe("computeGainsAtRiskCandidates: one run, one book", () => {
  it("T9 per case and move: (book + trials + candidate) − (book + trials) === the candidate's own row, within 0.005, by a second engine run with the candidate as a trial", () => {
    const { q, a } = seedBook();
    const items = [
      candidate(7001, q, "put", 95, 2.4, 2.6, 100),
      candidate(7002, q, "put", 90, 1.1, 1.3, 100),
      candidate(7003, a, "call", 55, 1.0, 1.2, 50),
    ];
    const trialPositions = [trialPut("t", q, 92, 3)];
    // Index mode, then single-name (ZZA) with rises.
    const variants: GainsAtRiskInput[] = [
      { ...BASE, trialPositions, valuationDate: "2026-12-18" },
      { ...BASE, trialPositions, moves: [-0.2, 0, 0.2, 0.4], driver: { kind: "single-name", symbol: "ZZA", securityId: a } },
    ];
    for (const input of variants) {
      const selectedMove = input.moves[0];
      const { rows } = computeGainsAtRiskCandidates(db, input, { budgetUsd: 5_000, selectedMove, candidates: items }, OPTS);
      expect(rows.map((r) => r.status)).toEqual(["priced", "priced", "priced"]);
      expectT9(input, items, rows);
    }
  });

  it("T10 result toStrictEqual computeGainsAtRisk with the same input and no candidates", () => {
    const { q, a } = seedBook();
    const items = [candidate(7001, q, "put", 95, 2.4, 2.6, 100), candidate(7003, a, "call", 55, 1.0, 1.2, 50)];
    for (const input of [
      { ...BASE, trialPositions: [trialPut("t", q, 92, 3)] },
      { ...BASE, moves: [-0.2, 0, 0.2], driver: { kind: "single-name" as const, symbol: "ZZA", securityId: a } },
    ]) {
      const out = computeGainsAtRiskCandidates(db, input, { budgetUsd: 2_000, selectedMove: -0.2, candidates: items }, OPTS);
      expect(out.result).toStrictEqual(computeGainsAtRisk(db, { ...input, selectedMove: -0.2 }, OPTS));
      expect("candidates" in out.result).toBe(false);
    }
  });

  it("T11 the position loader is called once for 1 and for 30 candidates (spy on loadScenarioPositionsByAccount)", () => {
    const { q } = seedBook();
    const one = candidate(7001, q, "put", 95, 2.4, 2.6, 100);
    const thirty = Array.from({ length: 30 }, (_, i): CandidateRequestItem => ({
      ...one,
      conId: 7100 + i,
      entry: { ...one.entry, brokerContractId: 7100 + i },
    }));
    for (const candidates of [[one], thirty]) {
      vi.mocked(loadScenarioPositionsByAccount).mockClear();
      const { rows } = computeGainsAtRiskCandidates(db, BASE, { budgetUsd: 1_000, selectedMove: -0.1, candidates }, OPTS);
      expect(rows).toHaveLength(candidates.length);
      expect(loadScenarioPositionsByAccount).toHaveBeenCalledTimes(1);
    }
  });

  it("T16 a budget change changes contracts and dollars only; entry fields identical; no re-solve (spy solveTrialEntry: 0 calls)", () => {
    const { q } = seedBook();
    const items = [candidate(7001, q, "put", 95, 2.4, 2.6, 100)];
    const frozen = JSON.parse(JSON.stringify(items));
    vi.mocked(solveTrialEntry).mockClear();
    const small = priced(computeGainsAtRiskCandidates(db, BASE, { budgetUsd: 1_000, selectedMove: -0.2, candidates: items }, OPTS).rows[0]);
    const large = priced(computeGainsAtRiskCandidates(db, BASE, { budgetUsd: 2_500, selectedMove: -0.2, candidates: items }, OPTS).rows[0]);
    expect(solveTrialEntry).toHaveBeenCalledTimes(0);
    expect(items).toEqual(frozen);
    expect([small.contracts, large.contracts]).toEqual([4, 10]);
    expect([small.costUsd, large.costUsd]).toEqual([1_000, 2_500]);
    expect(small.perContractUsd).toBe(large.perContractUsd);
    for (const k of GAINS_AT_RISK_CASE_KEYS) {
      for (const [i, x] of small.engine.cases![k].pnlByMove.entries()) {
        expect(large.engine.cases![k].pnlByMove[i] / 10).toBeCloseTo(x / 4, 6);
      }
      expect(large.engine.cases![k].beta).toBe(small.engine.cases![k].beta);
    }
  });

  it("T17 a candidate at N contracts equals, to the cent, the same position sent as a trial at N contracts in the next run", () => {
    const { q, a } = seedBook();
    const items = [candidate(7001, q, "put", 95, 2.4, 2.6, 100), candidate(7003, a, "call", 55, 1.0, 1.2, 50)];
    const input = { ...BASE, valuationDate: "2026-12-18", volChangePoints: 5 };
    const { rows } = computeGainsAtRiskCandidates(db, input, { budgetUsd: 3_000, selectedMove: -0.1, candidates: items }, OPTS);
    for (const [n, r] of rows.entries()) {
      const row = priced(r);
      const next = computeGainsAtRisk(db, { ...input, trialPositions: [asTrial(items[n], row.contracts, "added")] }, OPTS);
      const trial = next.trial?.rows[0];
      expect(trial?.cost).toEqual(row.engine.cost);
      expect(trial?.valueUsd).toBe(row.engine.valueUsd);
      for (const k of GAINS_AT_RISK_CASE_KEYS) {
        for (const [i, x] of (trial?.cases[k].pnlByMove ?? []).entries()) {
          expect(Math.abs(x - row.engine.cases![k].pnlByMove[i])).toBeLessThan(0.005);
        }
      }
    }
  });

  it("T30 atZeroMoveUsd is the same with moves [-0.2, -0.1] and [-0.2, -0.1, 0]; the book's sweep is unchanged", () => {
    const { q } = seedBook();
    const items = [candidate(7001, q, "put", 95, 2.4, 2.6, 100)];
    const later = { ...BASE, valuationDate: "2026-12-18" };
    const without0 = computeGainsAtRiskCandidates(db, { ...later, moves: [-0.2, -0.1] }, { budgetUsd: 1_000, selectedMove: -0.2, candidates: items }, OPTS);
    const with0 = computeGainsAtRiskCandidates(db, { ...later, moves: [-0.2, -0.1, 0] }, { budgetUsd: 1_000, selectedMove: -0.2, candidates: items }, OPTS);
    for (const k of GAINS_AT_RISK_CASE_KEYS) {
      const z = priced(with0.rows[0]).engine.cases![k];
      expect(priced(without0.rows[0]).engine.cases![k].atZeroMoveUsd).toBe(z.atZeroMoveUsd);
      expect(z.atZeroMoveUsd).toBe(z.pnlByMove[2]);
      // Time decay to the later date: the cost of waiting is a loss.
      expect(z.atZeroMoveUsd).toBeLessThan(0);
    }
    expect(without0.result).toStrictEqual(computeGainsAtRisk(db, { ...later, moves: [-0.2, -0.1], selectedMove: -0.2 }, OPTS));
    expect(without0.result.cases.measured.moves.map((m) => m.move)).toEqual([-0.2, -0.1]);
  });

  it("T1 an engine run with candidates absent or [] has no candidates key", () => {
    seedBook();
    for (const candidates of [undefined, []]) {
      const r = computeGainsAtRisk(db, { ...BASE, candidates }, OPTS);
      expect("candidates" in r).toBe(false);
      expect(r).toStrictEqual(computeGainsAtRisk(db, BASE, OPTS));
    }
  });

  it("P13a: single-name driver ZZA, a candidate on ZZB is heldUnchanged; on sibling ZZA2 it is not; index measured, a no-link underlying is heldUnchanged in measured and not in selloff", () => {
    const { a, a2, b } = seedBook();
    const onB = candidate(7010, b, "call", 45, 0.8, 1.0, 40);
    const onA2 = candidate(7011, a2, "put", 45, 0.9, 1.1, 50);
    const single = computeGainsAtRiskCandidates(
      db,
      { ...BASE, moves: [-0.2, 0, 0.2], driver: { kind: "single-name", symbol: "ZZA", securityId: a } },
      { budgetUsd: 1_000, selectedMove: 0.2, candidates: [onB, onA2] },
      OPTS,
    );
    const [rb, ra2] = single.rows.map(priced);
    expect(rb.engine.betaSource).toBe("held-unchanged");
    expect(ra2.engine.betaSource).toBe("driver");
    for (const k of GAINS_AT_RISK_CASE_KEYS) {
      expect(rb.engine.cases![k].heldUnchanged).toBe(true);
      expect(ra2.engine.cases![k].heldUnchanged).toBe(false);
    }
    const index = computeGainsAtRiskCandidates(db, BASE, { budgetUsd: 1_000, selectedMove: -0.2, candidates: [onB] }, OPTS);
    const ib = priced(index.rows[0]).engine;
    expect(ib.betaSource).toBe("no-measured-link");
    expect(ib.cases!.measured.heldUnchanged).toBe(true);
    expect(ib.cases!.selloff.heldUnchanged).toBe(false);
  });

  it("D5: a call on ZZA with selectedMove +0.2 reads rise; with -0.2 fall; index mode fall", () => {
    const { a } = seedBook();
    const call = candidate(7003, a, "call", 55, 1.0, 1.2, 50);
    const single = { ...BASE, moves: [-0.2, 0, 0.2], driver: { kind: "single-name" as const, symbol: "ZZA", securityId: a } };
    const up = priced(computeGainsAtRiskCandidates(db, single, { budgetUsd: 1_000, selectedMove: 0.2, candidates: [call] }, OPTS).rows[0]);
    const down = priced(computeGainsAtRiskCandidates(db, single, { budgetUsd: 1_000, selectedMove: -0.2, candidates: [call] }, OPTS).rows[0]);
    const index = priced(
      computeGainsAtRiskCandidates(db, { ...BASE, moves: [-0.2, 0, 0.1] }, { budgetUsd: 1_000, selectedMove: 0.1, candidates: [call] }, OPTS).rows[0],
    );
    for (const k of GAINS_AT_RISK_CASE_KEYS) {
      expect(up.engine.cases![k].crossingDirection).toBe("rise");
      expect(up.engine.cases![k].crossing.kind).toBe("pays-beyond");
      expect(up.engine.cases![k].atSelectedMoveUsd).toBe(up.engine.cases![k].pnlByMove[2]);
      expect(down.engine.cases![k].crossingDirection).toBe("fall");
      expect(down.engine.cases![k].crossing.kind).toBe("worse-at-every-move");
      expect(index.engine.cases![k].crossingDirection).toBe("fall");
    }
  });

  it("zero-contract and refused rows have no book figures and are out of every total", () => {
    const { q } = seedBook();
    const tooDear = candidate(7001, q, "put", 95, 2.4, 2.6, 100); // $250 a contract
    const fits = candidate(7002, q, "put", 90, 1.1, 1.3, 100); // $120 a contract
    // A contract kept from an earlier pull that has since expired: refused by the engine, sized all the same.
    const lapsed: CandidateRequestItem = { ...fits, conId: 7003, expiry: "2026-11-06", entry: { ...fits.entry, expiry: "2026-11-06", brokerContractId: 7003 } };
    const input = { ...BASE, trialPositions: [trialPut("t", q, 92, 3)] };
    const out = computeGainsAtRiskCandidates(db, input, { budgetUsd: 200, selectedMove: -0.1, candidates: [tooDear, fits, lapsed] }, OPTS);
    expect(out.rows[0]).toEqual({ conId: 7001, status: "zero-contracts", perContractUsd: 250, quote: { ...tooDear.quote, source: "client-supplied" } });
    expect(out.rows[1]).toMatchObject({ conId: 7002, status: "priced", contracts: 1, costUsd: 120, unspentUsd: 80 });
    expect(out.rows[2]).toEqual({
      conId: 7003,
      status: "refused",
      refusal: "expired",
      contracts: 1,
      perContractUsd: 120,
      quote: { ...lapsed.quote, source: "client-supplied" },
    });
    // Out of every total: the book and the trial list are those of the run without candidates.
    expect(out.result).toStrictEqual(computeGainsAtRisk(db, { ...input, selectedMove: -0.1 }, OPTS));
  });

  it("Review Focus 4: a candidate whose quote underlying (100) differs from the stored price (90) is 0 at move 0 today and never refused", () => {
    seedBook();
    const r = stock("ZZR", 90, null);
    hold(r, 10);
    const item = candidate(7020, r, "put", 95, 2.4, 2.6, 100);
    expect(item.entry.entryUnderlyingPrice).toBe(100);
    expect(item.entry.valuationPriceAtEntry).toBe(90);
    const out = computeGainsAtRiskCandidates(db, { ...BASE, moves: [-0.1, 0] }, { budgetUsd: 1_000, selectedMove: -0.1, candidates: [item] }, OPTS);
    const row = priced(out.rows[0]);
    expect(row.engine.refusal).toBeUndefined();
    for (const k of GAINS_AT_RISK_CASE_KEYS) {
      expect(row.engine.cases![k].atZeroMoveUsd).toBe(0);
      expect(row.engine.cases![k].pnlByMove[1]).toBe(0);
    }
  });

  it("F5/P13 an entry underlying that is not the quote's is refused, so no row can show a non-zero 0% figure today", () => {
    const { q } = seedBook();
    const good = candidate(7001, q, "put", 95, 2.4, 2.6, 101);
    const bad: CandidateRequestItem = { ...good, entry: { ...good.entry, entryUnderlyingPrice: 150 } };
    const input = { ...BASE, moves: [-0.1, 0] };
    expect(() => computeGainsAtRiskCandidates(db, input, { budgetUsd: 1_000, selectedMove: -0.1, candidates: [bad] }, OPTS)).toThrow(
      /candidates\[0\]\.entry\.entryUnderlyingPrice/,
    );
    expect(() => computeGainsAtRiskCandidates(db, input, { budgetUsd: 1_000, selectedMove: -0.1, candidates: [bad] }, OPTS)).toThrow(
      GainsAtRiskInputError,
    );
    // The entry as solved: exactly 0 at the click.
    const row = priced(computeGainsAtRiskCandidates(db, input, { budgetUsd: 1_000, selectedMove: -0.1, candidates: [good] }, OPTS).rows[0]);
    for (const k of GAINS_AT_RISK_CASE_KEYS) {
      expect(row.engine.cases![k].atZeroMoveUsd).toBe(0);
      expect(row.engine.cases![k].pnlByMove[1]).toBe(0);
    }
  });

  it("Review Focus 5: accountIds [] with one trial and two candidates: book zero, rows priced, T9 holds", () => {
    const { q, a } = seedBook();
    const items = [candidate(7001, q, "put", 95, 2.4, 2.6, 100), candidate(7003, a, "call", 55, 1.0, 1.2, 50)];
    const input = { ...BASE, accountIds: [], trialPositions: [trialPut("t", q, 92, 3)] };
    const out = computeGainsAtRiskCandidates(db, input, { budgetUsd: 1_000, selectedMove: -0.2, candidates: items }, OPTS);
    expect(out.result.positions).toEqual([]);
    for (const k of GAINS_AT_RISK_CASE_KEYS) for (const m of out.result.cases[k].moves) expect(m.bookPnlUsd).toBe(0);
    expect(out.rows.map((r) => r.status)).toEqual(["priced", "priced"]);
    expectT9(input, items, out.rows);
  });

  it("engine costUsd for each priced row equals unitsToUsd(costUnits) to the cent", () => {
    const { q, a } = seedBook();
    const items = [
      candidate(7001, q, "put", 95, 2.4, 2.6, 100),
      candidate(7002, q, "put", 90, 1.1, 1.3, 100),
      candidate(7003, a, "call", 55, 1.0, 1.2, 50),
    ];
    const budget = 4_321.09;
    const { rows } = computeGainsAtRiskCandidates(db, BASE, { budgetUsd: budget, selectedMove: -0.1, candidates: items }, OPTS);
    for (const [n, r] of rows.entries()) {
      const row = priced(r);
      const s = sizeCandidate(budgetToUnits(budget)!, toMoneyUnits(items[n].quote.bid)!, toMoneyUnits(items[n].quote.ask)!);
      expect(row.contracts).toBe(s.contracts);
      expect(row.costUsd).toBe(unitsToUsd(s.costUnits));
      expect(row.costUsd + row.unspentUsd).toBeCloseTo(budget, 9);
      expect(row.engine.cost?.kind).toBe("premium-paid");
      expect(Math.abs((row.engine.cost?.usd as number) - row.costUsd)).toBeLessThan(0.005);
    }
  });

  it("refuses a bad body as an input error before any engine run", () => {
    const { q } = seedBook();
    const item = candidate(7001, q, "put", 95, 2.4, 2.6, 100);
    vi.mocked(loadScenarioPositionsByAccount).mockClear();
    expect(() => computeGainsAtRiskCandidates(db, BASE, { budgetUsd: 10.005, selectedMove: -0.1, candidates: [item] }, OPTS)).toThrow(GainsAtRiskInputError);
    const bad = { ...item, quote: { ...item.quote, mid: 2.6 } };
    expect(() => computeGainsAtRiskCandidates(db, BASE, { budgetUsd: 100, selectedMove: -0.1, candidates: [bad] }, OPTS)).toThrow(/quote\.mid/);
    expect(loadScenarioPositionsByAccount).toHaveBeenCalledTimes(0);
    // The engine itself: a candidate needs a selected move among the moves, and a bought option.
    const pos = { ...asTrial(item, 1), kind: "option" as const } as Extract<TrialPositionInput, { kind: "option" }>;
    expect(() => computeGainsAtRisk(db, { ...BASE, candidates: [{ id: "c", position: pos }] })).toThrow(GainsAtRiskInputError);
    expect(() => computeGainsAtRisk(db, { ...BASE, selectedMove: 0.3, candidates: [{ id: "c", position: pos }] })).toThrow(GainsAtRiskInputError);
    expect(() =>
      computeGainsAtRisk(db, { ...BASE, selectedMove: -0.1, candidates: [{ id: "c", position: { ...pos, side: "write" } }] }),
    ).toThrow(GainsAtRiskInputError);
  });
});
