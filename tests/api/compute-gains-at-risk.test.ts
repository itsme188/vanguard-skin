/**
 * POST /api/compute/gains-at-risk (Gains at risk, step 1, Task 5).
 *
 * A thin route: it validates the body, resolves the scope (a scope word that
 * matches no account reads NOTHING, never every account), calls the engine,
 * and returns the engine result with the year's gain for ALL accounts and two
 * freshness readings (all accounts, and the stress scope).
 *
 * Synthetic ZZ tickers and round numbers only. Clock fixed at
 * 2026-11-10 15:00 UTC (10:00 Eastern).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays } from "@/lib/calendar/date-utils";
import { classifyRoute } from "@/lib/auth/route-policy";
import { gainsAtRiskBodyProblem } from "@/lib/analysis/gains-at-risk-input";
import { BETA_OVERRIDE_BOUNDS } from "@/lib/analysis/gains-at-risk-constants";
import { computeGainsAtRisk } from "@/lib/compute/gains-at-risk";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const state = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  /** Forces the engine to throw, past the body check: "input" (typed) or "internal". */
  engineThrows: null as null | "input" | "internal",
  /** The input the route last handed the engine. */
  lastInput: null as unknown,
}));

vi.mock("@/lib/compute/gains-at-risk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compute/gains-at-risk")>();
  return {
    ...actual,
    computeGainsAtRisk: (...args: Parameters<typeof actual.computeGainsAtRisk>) => {
      state.lastInput = args[1];
      if (state.engineThrows === "input") throw new actual.GainsAtRiskInputError("valuationDate is before today");
      if (state.engineThrows === "internal") throw new Error("SQLITE_ERROR: no such column zz_secret_detail");
      return actual.computeGainsAtRisk(...args);
    },
  };
});

vi.mock("@/lib/db", () => ({
  get db() {
    return state.db;
  },
}));

const NOW = "2026-11-10T15:00:00Z";
const TODAY = "2026-11-10";

// Migration 002 seeds 1 "Vanguard Taxable", 2 "Vanguard Roth IRA", 3 "IBKR".
const VANGUARD = 1;
const ROTH = 2;
const IBKR = 3;

let nextKey = 0;

function addStock(db: Database.Database, id: number, symbol: string): number {
  db.prepare(
    "INSERT INTO securities (id, symbol, name, security_type, currency, multiplier) VALUES (?, ?, ?, 'Stock', 'USD', 1)",
  ).run(id, symbol, `${symbol} Corp`);
  return id;
}

function price(db: Database.Database, id: number, close: number, date = "2026-11-09"): void {
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')").run(id, date, close);
}

function hold(db: Database.Database, account: number, id: number, qty: number): void {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (?, ?, ?, ?, ?)",
  ).run(account, id, TODAY, qty, `tws-gar-${++nextKey}`);
}

function seedBook(db: Database.Database): void {
  const a = addStock(db, 101, "ZZAA");
  const b = addStock(db, 102, "ZZBB");
  const c = addStock(db, 103, "ZZCC");
  price(db, a, 100);
  price(db, b, 50);
  price(db, c, 20);
  hold(db, VANGUARD, a, 10);
  hold(db, ROTH, b, 20);
  hold(db, IBKR, c, 50);
}

function validBody(): Record<string, unknown> {
  return {
    scope: "ibkr",
    driverSymbol: "SPY",
    valuationDate: TODAY,
    moves: [-0.1, -0.2],
    volChangePoints: 0,
  };
}

/** A driver series row (SPY, not held) and daily bars; a name's bars move `multiple` times the driver's daily log return. */
const BAR_DAYS = 120;
function barDates(): string[] {
  const out: string[] = [];
  let d = "2026-11-09";
  while (out.length < BAR_DAYS) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.unshift(d);
    d = addDays(d, -1);
  }
  return out;
}
function seedBars(db: Database.Database, id: number, multiple: number): void {
  const dates = barDates();
  const ins = db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, 1000)`,
  );
  let cum = 0;
  for (let i = 0; i < BAR_DAYS; i++) {
    if (i > 0) cum += 0.01 * Math.sin(i * 1.3) + 0.002 * Math.cos(i * 0.7);
    const c = 100 * Math.exp(multiple * cum);
    ins.run(id, dates[i], c, c, c, c);
  }
}
function seedDriverBars(db: Database.Database): void {
  db.prepare(
    "INSERT INTO securities (id, symbol, name, security_type, currency, multiplier, ib_con_id) VALUES (900, 'SPY', 'Driver index fund', 'ETF', 'USD', 1, 9000)",
  ).run();
  seedBars(db, 900, 1);
}

async function post(body: unknown) {
  return postRaw(JSON.stringify(body));
}

async function postRaw(raw: string) {
  const { POST } = await import("@/app/api/compute/gains-at-risk/route");
  const res = await POST(
    new Request("http://localhost/api/compute/gains-at-risk", {
      method: "POST",
      body: raw,
      headers: { "content-type": "application/json" },
    }) as never,
  );
  return { res, body: await res.json() };
}

describe("POST /api/compute/gains-at-risk", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(NOW));
    state.db = new Database(":memory:");
    state.db.pragma("foreign_keys = ON");
    runMigrations(state.db);
    seedBook(state.db);
  });

  afterEach(() => {
    state.engineThrows = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
    state.db.close();
  });

  it("returns the engine result, the all-accounts year's gain, and two freshness readings", async () => {
    const { res, body } = await post(validBody());
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    const data = body.data;

    // The stress scope: IBKR rows only.
    expect(data.result.driverSymbol).toBe("SPY");
    expect(data.result.valuationDate).toBe(TODAY);
    for (const k of ["measured", "selloff"]) {
      expect(data.result.cases[k].moves.map((m: { move: number }) => m.move)).toEqual([-0.1, -0.2]);
    }
    expect(data.result.betaEvidence).toEqual(expect.objectContaining({ driverBarsMissing: expect.any(Boolean) }));
    expect(data.result.betaOverridesIgnored).toBe(0);
    expect(data.result.positions.length).toBeGreaterThan(0);
    for (const p of data.result.positions) expect(p.accountId).toBe(IBKR);
    expect(data.result.positions.map((p: { symbol: string }) => p.symbol)).toEqual(["ZZCC"]);

    // The year's gain reads every account, whatever the stress scope.
    const yearIds = data.yearGain.accounts.map((a: { accountId: number }) => a.accountId).sort();
    expect(yearIds).toEqual([VANGUARD, ROTH, IBKR]);

    // Freshness: all accounts, and the stress scope.
    const allIds = data.yearGainFreshness.accounts.map((a: { accountId: number }) => a.accountId).sort();
    expect(allIds).toEqual([VANGUARD, ROTH, IBKR]);
    expect(data.scopeFreshness.accounts.map((a: { accountId: number }) => a.accountId)).toEqual([IBKR]);
  });

  const yesterday = addDays(TODAY, -1);
  const threeYearsOut = addDays(TODAY, 3 * 365 + 1);

  it.each([
    [{ scope: "everything" }, "scope"],
    [{ scope: 3 }, "scope"],
    [{ scope: undefined }, "scope"],
    [{ driverSymbol: "ZZZZ" }, "driverSymbol"],
    [{ moves: [0.7] }, "moves"],
    [{ moves: Array(42).fill(0) }, "moves"],
    [{ volChangePoints: 61 }, "volChangePoints"],
    [{ valuationDate: yesterday }, "valuationDate"],
    [{ valuationDate: threeYearsOut }, "valuationDate"],
    [{ valuationDate: "2026-02-30" }, "valuationDate"],
    [{ priceOverrides: { abc: 1 } }, "priceOverrides"],
  ])("refuses %o with 400 naming %s", async (patch, field) => {
    const { res, body } = await post({ ...validBody(), ...patch });
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain(field);
  });

  it.each([
    [{ moves: [] }, "moves"],
    [{ moves: [-0.61] }, "moves"],
    [{ moves: ["0.1"] }, "moves"],
    [{ moves: "x" }, "moves"],
    [{ driverSymbol: "" }, "driverSymbol"],
    [{ driverSymbol: undefined }, "driverSymbol"],
    [{ volChangePoints: -21 }, "volChangePoints"],
    [{ volChangePoints: "5" }, "volChangePoints"],
    [{ valuationDate: "2026-11-1" }, "valuationDate"],
    [{ valuationDate: 20261110 }, "valuationDate"],
    [{ priceOverrides: { "0": 1 } }, "priceOverrides"],
    [{ priceOverrides: { "101": "2" } }, "priceOverrides"],
    [{ priceOverrides: [1, 2] }, "priceOverrides"],
    [{ priceOverrides: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [String(i + 1), 1])) }, "priceOverrides"],
  ])("also refuses %o with 400 naming %s", async (patch, field) => {
    const { res, body } = await post({ ...validBody(), ...patch });
    expect(res.status).toBe(400);
    expect(body.error).toContain(field);
  });

  it.each([
    [[]],
    ["x"],
    [null],
    [{ abc: 1 }],
    [{ "01": 1 }],
    [{ "0": 1 }],
    [{ "-7": 1 }],
    [{ "7.5": 1 }],
    [{ 7: 5.5 }],
    [{ 7: -5.01 }],
    [{ 7: null }],
    [{ 7: "1" }],
    [Object.fromEntries(Array.from({ length: 201 }, (_, i) => [String(i + 1), 1]))],
  ])("refuses betaOverrides %o with 400 naming betaOverrides", async (overrides) => {
    const { res, body } = await post({ ...validBody(), betaOverrides: overrides });
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain("betaOverrides");
  });

  it("refuses a __proto__ key in betaOverrides (sent as raw JSON)", async () => {
    const raw = JSON.stringify(validBody()).replace(/}$/, ',"betaOverrides":{"__proto__":1}}');
    const { res, body } = await postRaw(raw);
    expect(res.status).toBe(400);
    expect(body.error).toContain("betaOverrides");
  });

  it("refuses a non-finite betaOverrides value (checked directly: JSON cannot carry one)", () => {
    for (const v of [Infinity, -Infinity, NaN]) {
      expect(gainsAtRiskBodyProblem({ ...validBody(), betaOverrides: { 7: v } }, TODAY)).toContain("betaOverrides");
    }
  });

  it("accepts betaOverrides at the bounds, exactly 200 entries, and an empty object", () => {
    expect(BETA_OVERRIDE_BOUNDS.maxEntries).toBe(200);
    const ok = (o: unknown) => gainsAtRiskBodyProblem({ ...validBody(), betaOverrides: o }, TODAY);
    expect(ok({ 7: BETA_OVERRIDE_BOUNDS.min, 8: BETA_OVERRIDE_BOUNDS.max, 9: 0 })).toBeNull();
    expect(ok({})).toBeNull();
    expect(ok(Object.fromEntries(Array.from({ length: 200 }, (_, i) => [String(i + 1), 1])))).toBeNull();
  });

  it("an accepted owner's figure prices the name at that figure in both cases", async () => {
    const { res, body } = await post({ ...validBody(), betaOverrides: { "103": 1.5 } });
    expect(res.status).toBe(200);
    const p = body.data.result.positions.find((x: { symbol: string }) => x.symbol === "ZZCC");
    expect(p.identitySecurityId).toBe(103);
    expect(p.betaSource).toBe("owner");
    expect(p.cases.measured.beta).toBe(1.5);
    expect(p.cases.selloff.beta).toBe(1.5);
    // 50 shares at 20 = 1,000; a -10% driver move at 1.5 is -150 in both cases.
    expect(p.cases.measured.pnlByMove[0]).toBeCloseTo(-150, 6);
    expect(p.cases.selloff.pnlByMove[0]).toBeCloseTo(-150, 6);
    expect(body.data.result.betaOverridesIgnored).toBe(0);
  });

  it("an owner's figure for an id not in the book is ignored and counted", async () => {
    const { res, body } = await post({ ...validBody(), betaOverrides: { "999": 1 } });
    expect(res.status).toBe(200);
    expect(body.data.result.betaOverridesIgnored).toBe(1);
    const p = body.data.result.positions.find((x: { symbol: string }) => x.symbol === "ZZCC");
    expect(p.betaSource).not.toBe("owner");
  });

  it("measures a beta from daily bars and reports the driver's bar evidence", async () => {
    seedDriverBars(state.db);
    seedBars(state.db, 103, 2);
    const { res, body } = await post(validBody());
    expect(res.status).toBe(200);
    const p = body.data.result.positions.find((x: { symbol: string }) => x.symbol === "ZZCC");
    expect(p.betaSource).toBe("measured");
    expect(p.measuredBeta).toBeCloseTo(2, 3);
    expect(p.cases.measured.beta).toBeCloseTo(2, 3);
    expect(body.data.result.betaEvidence.driverBarsMissing).toBe(false);
    expect(body.data.result.betaEvidence.driverBarsThrough).toBe("2026-11-09");
  });

  it("passes the engine result through untouched", async () => {
    seedDriverBars(state.db);
    seedBars(state.db, 103, 2);
    const req = { ...validBody(), scope: "all", betaOverrides: { "101": 0.5, "999": 1 }, priceOverrides: { "103": 5 } };
    const { body } = await post(req);
    const direct = computeGainsAtRisk(state.db, {
      accountIds: undefined,
      driverSymbol: "SPY",
      valuationDate: TODAY,
      moves: [-0.1, -0.2],
      volChangePoints: 0,
      priceOverrides: { 103: 5 },
      betaOverrides: { 101: 0.5, 999: 1 },
      today: TODAY,
    });
    expect(body.data.result).toEqual(JSON.parse(JSON.stringify(direct)));
    expect(Object.keys(body.data).sort()).toEqual(["result", "scopeFreshness", "yearGain", "yearGainFreshness"]);
  });

  it("refuses a body that is not an object, and malformed JSON, with 400", async () => {
    expect((await post([1, 2])).res.status).toBe(400);
    expect((await post(null)).res.status).toBe(400);
    const { POST } = await import("@/app/api/compute/gains-at-risk/route");
    const res = await POST(
      new Request("http://localhost/api/compute/gains-at-risk", { method: "POST", body: "{not json" }) as never,
    );
    expect(res.status).toBe(400);
  });

  it("a scope token matching no account returns an empty result, never every account", async () => {
    state.db.prepare("UPDATE accounts SET name = 'Vanguard Retirement' WHERE id = ?").run(ROTH);
    const { res, body } = await post({ ...validBody(), scope: "roth" });
    expect(res.status).toBe(200);
    expect(body.data.result.positions).toEqual([]);
    for (const k of ["measured", "selloff"]) {
      for (const m of body.data.result.cases[k].moves) {
        expect(m.bookPnlUsd).toBe(0);
        expect(m.losersPnlUsd).toBe(0);
        expect(m.offsetsPnlUsd).toBe(0);
      }
    }
    expect(body.data.scopeFreshness.accounts).toEqual([]);
    // The year's gain still reads every account.
    expect(body.data.yearGain.accounts.length).toBe(3);
  });

  it("scope 'all' stresses every account", async () => {
    const { res, body } = await post({ ...validBody(), scope: "all" });
    expect(res.status).toBe(200);
    const ids = [...new Set(body.data.result.positions.map((p: { accountId: number }) => p.accountId))].sort();
    expect(ids).toEqual([VANGUARD, ROTH, IBKR]);
  });

  it("accepts a valuation date of today", async () => {
    const { res, body } = await post({ ...validBody(), valuationDate: TODAY });
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("accepts the boundaries: moves of +/-0.6, 41 moves, vol 60, a date two years on", async () => {
    const { res } = await post({
      ...validBody(),
      moves: [-0.6, 0.6, ...Array(39).fill(0)],
      volChangePoints: 60,
      valuationDate: "2028-11-10",
      priceOverrides: { "103": 5 },
    });
    expect(res.status).toBe(200);
    expect((await post({ ...validBody(), valuationDate: "2028-11-11" })).res.status).toBe(400);
  });

  it("an engine input error that gets past the body check answers 400 with its sentence", async () => {
    state.engineThrows = "input";
    const { res, body } = await post(validBody());
    expect(res.status).toBe(400);
    expect(body).toEqual({ success: false, error: "valuationDate is before today" });
  });

  it("an internal failure answers 500 with a fixed sentence and logs only a content-free line", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    state.engineThrows = "internal";
    const { res, body } = await post(validBody());
    expect(res.status).toBe(500);
    expect(body).toEqual({ success: false, error: "Could not compute gains at risk." });
    expect(JSON.stringify(body)).not.toContain("zz_secret_detail");
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]).toEqual(["[gains-at-risk]", "SQLITE_ERROR: no such column zz_secret_detail"]);
  });

  it("the shared input module value-imports no server code (C12: it reaches the browser build)", () => {
    const src = readFileSync(join(process.cwd(), "lib/analysis/gains-at-risk-input.ts"), "utf8");
    // Every import statement, multi-line ones included. Only `import type` is erased at build;
    // an inline `{ type X }` list is treated as a value import (the safe side).
    const statements = [...src.matchAll(/^import\s[\s\S]*?from\s+["']([^"']+)["'];?/gm)];
    expect(statements.length).toBeGreaterThan(0);
    const valueSources = statements.filter((m) => !/^import\s+type\s/.test(m[0])).map((m) => m[1]);
    const forbidden = /^@\/lib\/(compute|queries|tws|calendar|mutations)\/|^@\/lib\/db(\/|$)|^@\/lib\/db\.|better-sqlite3|@stoqey\/ib/;
    expect(valueSources.filter((s) => forbidden.test(s))).toEqual([]);
    // Step 2 (Task S3): the value imports are exactly the scope list and the import-free constants.
    expect([...new Set(valueSources)].sort()).toEqual(["@/lib/analysis/gains-at-risk-constants", "@/lib/analysis/view-param"]);
    // The override bounds come from the import-free constants module only.
    expect(valueSources).toContain("@/lib/analysis/gains-at-risk-constants");
    expect(src).not.toMatch(/\brequire\(|\bimport\(/);
    expect(src).not.toMatch(/gainsAtRiskAccountIds/);
  });

  it("the latest-date sentence names a real day when today is Feb 29", () => {
    const problem = gainsAtRiskBodyProblem(
      { scope: "all", driverSymbol: "SPY", valuationDate: "2030-03-01", moves: [-0.1], volChangePoints: 0 },
      "2028-02-29",
    );
    expect(problem).toContain("2030-02-28");
    expect(problem).not.toContain("2030-02-29");
    expect(
      gainsAtRiskBodyProblem(
        { scope: "all", driverSymbol: "SPY", valuationDate: "2030-02-28", moves: [-0.1], volChangePoints: 0 },
        "2028-02-29",
      ),
    ).toBeNull();
  });

  it("is a human route", () => {
    expect(classifyRoute("POST", "/api/compute/gains-at-risk")).toBe("human");
  });

  // ─── Trial positions (step 2, Task S3, rulings P9 and P11) ───────────────
  const opt = {
    kind: "option",
    id: "t-put",
    underlyingSecurityId: 103,
    right: "put",
    side: "buy",
    expiry: "2027-03-19",
    strike: 20,
    contracts: 2,
    pricePaid: 1.5,
    entryUnderlyingPrice: 20,
    entryVolatility: 0.35,
    valuationPriceAtEntry: 20,
  };
  const shares = { kind: "shares", id: "t-sell", securityId: 101, side: "sell", quantity: 5, price: 100 };

  it.each([
    [{ trialPositions: {} }],
    [{ trialPositions: Array(13).fill(opt) }],
    [{ trialPositions: Array.from({ length: 13 }, (_, i) => ({ ...opt, id: `t${i}` })) }],
    [{ trialPositions: [opt, opt] }], // duplicate id
    [{ trialPositions: [{ ...opt, contracts: 1.5 }] }],
    [{ trialPositions: [{ ...opt, expiry: "2026-02-30" }] }],
    [{ trialPositions: [{ ...shares, price: 0 }] }],
    [{ trialPositions: [{ ...opt, id: "" }] }],
    [{ trialPositions: [{ ...opt, id: "x".repeat(41) }] }],
    [{ trialPositions: [{ ...opt, id: 7 }] }],
    [{ trialPositions: [{ ...opt, kind: "future" }] }],
    [{ trialPositions: [{ ...opt, right: "P" }] }],
    [{ trialPositions: [{ ...opt, side: "sell" }] }],
    [{ trialPositions: [{ ...shares, side: "write" }] }],
    [{ trialPositions: [{ ...opt, contracts: 0 }] }],
    [{ trialPositions: [{ ...opt, contracts: 501 }] }],
    [{ trialPositions: [{ ...opt, strike: -1 }] }],
    [{ trialPositions: [{ ...opt, strike: 100_001 }] }],
    [{ trialPositions: [{ ...opt, pricePaid: 0 }] }],
    [{ trialPositions: [{ ...opt, entryUnderlyingPrice: 100_001 }] }],
    [{ trialPositions: [{ ...opt, entryVolatility: 0 }] }],
    [{ trialPositions: [{ ...opt, entryVolatility: 10.01 }] }],
    [{ trialPositions: [{ ...opt, expiry: "20270319" }] }],
    [{ trialPositions: [{ ...shares, quantity: 1_000_001 }] }],
    [{ trialPositions: [{ ...shares, quantity: 2.5 }] }],
    [{ trialPositions: [{ ...shares, price: "100" }] }],
    [{ trialPositions: [null] }],
    [{ trialPositions: [{ ...opt, underlyingSecurityId: 0 }] }],
    [{ trialPositions: [{ ...opt, underlyingSecurityId: 1.5 }] }],
    [{ trialPositions: [{ ...shares, securityId: "101" }] }],
    [{ trialPositions: [{ ...shares, securityId: 9007199254740993 }] }],
    [{ trialPositions: [{ ...opt, valuationPriceAtEntry: undefined }] }],
    [{ trialPositions: [{ ...opt, valuationPriceAtEntry: 0 }] }],
    [{ trialPositions: [{ ...opt, valuationPriceAtEntry: -5 }] }],
    [{ trialPositions: [{ ...opt, valuationPriceAtEntry: 100_001 }] }],
    [{ trialPositions: [{ ...opt, valuationPriceAtEntry: "20" }] }],
  ])("refuses %o with 400 naming trialPositions", async (patch) => {
    const { res, body } = await post({ ...validBody(), ...patch });
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toContain("trialPositions");
  });

  it("the trial body check refuses a non-finite figure (checked directly: JSON cannot carry one)", () => {
    for (const v of [Infinity, NaN]) {
      expect(gainsAtRiskBodyProblem({ ...validBody(), trialPositions: [{ ...opt, entryVolatility: v }] }, TODAY)).toContain(
        "trialPositions",
      );
      expect(gainsAtRiskBodyProblem({ ...validBody(), trialPositions: [{ ...shares, price: v }] }, TODAY)).toContain("trialPositions");
      expect(
        gainsAtRiskBodyProblem({ ...validBody(), trialPositions: [{ ...opt, valuationPriceAtEntry: v }] }, TODAY),
      ).toContain("valuationPriceAtEntry");
    }
  });

  it("accepts twelve positions and the bounds exactly", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ ...opt, id: `t${i}` }));
    expect(gainsAtRiskBodyProblem({ ...validBody(), trialPositions: twelve }, TODAY)).toBeNull();
    expect(gainsAtRiskBodyProblem({ ...validBody(), trialPositions: [] }, TODAY)).toBeNull();
    expect(
      gainsAtRiskBodyProblem(
        {
          ...validBody(),
          trialPositions: [
            {
              ...opt,
              contracts: 500,
              strike: 100_000,
              pricePaid: 100_000,
              entryUnderlyingPrice: 100_000,
              entryVolatility: 10,
              valuationPriceAtEntry: 100_000,
              id: "x".repeat(40),
            },
            { ...shares, quantity: 1_000_000, price: 100_000 },
          ],
        },
        TODAY,
      ),
    ).toBeNull();
  });

  it("passes trial positions to the engine and returns its result untouched", async () => {
    const trialPositions = [opt, shares];
    const { res, body } = await post({ ...validBody(), scope: "all", trialPositions });
    expect(res.status).toBe(200);
    const direct = computeGainsAtRisk(state.db, {
      accountIds: undefined,
      driverSymbol: "SPY",
      valuationDate: TODAY,
      moves: [-0.1, -0.2],
      volChangePoints: 0,
      trialPositions: trialPositions as never,
      today: TODAY,
    });
    expect(direct.trial).toBeDefined();
    expect(body.data.result).toEqual(JSON.parse(JSON.stringify(direct)));
    expect(body.data.result.trial.rows.map((r: { id: string }) => r.id)).toEqual(["t-put", "t-sell"]);

    // valuationPriceAtEntry reaches the engine with the rest of the option's fixed record.
    const handed = (state.lastInput as { trialPositions: Record<string, unknown>[] }).trialPositions;
    expect(handed[0]).toEqual(opt);
    expect(handed[0].valuationPriceAtEntry).toBe(20);

    // Unknown keys on a trial are not passed through.
    const extra = await post({ ...validBody(), scope: "all", trialPositions: [{ ...opt, zzExtra: 1 }, shares] });
    expect(extra.body.data.result).toEqual(body.data.result);

    // An empty list is the same as none: step 1's result, no trial key.
    const none = await post({ ...validBody(), trialPositions: [] });
    expect(none.res.status).toBe(200);
    expect(none.body.data.result.trial).toBeUndefined();
  });

  it("accepts a retained trial whose expiry has passed; the engine returns it refused expired", async () => {
    const { res, body } = await post({ ...validBody(), trialPositions: [{ ...opt, expiry: "2026-11-06" }, shares] });
    expect(res.status).toBe(200);
    const rows = body.data.result.trial.rows;
    expect(rows.find((r: { id: string }) => r.id === "t-put").refusal).toBe("expired");
    expect(rows.find((r: { id: string }) => r.id === "t-sell").refusal).toBeUndefined();
  });

  it("refuses a trial security id that is not a positive safe integer (400); a bad security is the engine's row refusal", async () => {
    const zero = await post({ ...validBody(), trialPositions: [{ ...shares, securityId: -4 }] });
    expect(zero.res.status).toBe(400);
    expect(zero.body.error).toContain("trialPositions");

    state.db
      .prepare("INSERT INTO securities (id, symbol, name, security_type, currency) VALUES (201, 'ZZJP', 'ZZ Japan', 'Stock', 'JPY')")
      .run();
    state.db
      .prepare(
        "INSERT INTO securities (id, symbol, name, security_type, currency) VALUES (202, 'ZZCC 270319P00020000', 'ZZCC put', 'Option', 'USD')",
      )
      .run();
    // A retained trial whose security is now unknown, an option, or not in dollars: the run still
    // answers 200, that row is refused with zero effect, and the other trial computes (P11's intent).
    for (const [bad, refusal] of [
      [{ ...shares, id: "t-bad", securityId: 999 }, "unknown-security"],
      [{ ...shares, id: "t-bad", securityId: 202 }, "is-an-option"],
      [{ ...opt, id: "t-bad", underlyingSecurityId: 201 }, "foreign-currency"],
    ] as const) {
      const { res, body } = await post({ ...validBody(), trialPositions: [bad, opt] });
      expect(res.status).toBe(200);
      const rows = body.data.result.trial.rows;
      const badRow = rows.find((r: { id: string }) => r.id === "t-bad");
      expect(badRow.refusal).toBe(refusal);
      expect(badRow.cost).toBeNull();
      for (const k of ["measured", "selloff"]) {
        expect(badRow.cases[k].pnlByMove.every((v: number) => v === 0)).toBe(true);
      }
      const good = rows.find((r: { id: string }) => r.id === "t-put");
      expect(good.refusal).toBeUndefined();
      expect(body.data.result.trial.refusedCount).toBe(1);
    }
  });

  it("the compute route never looks a trial's security up itself (shape only)", () => {
    const src = readFileSync(join(process.cwd(), "app/api/compute/gains-at-risk/route.ts"), "utf8");
    expect(src).not.toMatch(/checkTrialSecurity/);
  });

  it("a trial on a name with no broker contract is still accepted (the contract is needed only for a quote)", async () => {
    // 103 (ZZCC) has no ib_con_id in the seed.
    const { res } = await post({ ...validBody(), trialPositions: [opt] });
    expect(res.status).toBe(200);
  });

  // ─── Step 3 (Task S4): the single-name driver (P1, P5, P8, T1, T8, T20) and F3 ───────────

  it("T1 no driver: the engine input carries no step 3 key and the reply equals the direct step 2 engine run", async () => {
    for (const extra of [{}, { trialPositions: [opt, shares] }]) {
      const { res, body } = await post({ ...validBody(), scope: "all", ...extra });
      expect(res.status).toBe(200);
      const handed = state.lastInput as Record<string, unknown>;
      for (const k of ["driver", "selectedMove", "candidates"]) expect(k in handed).toBe(false);
      const direct = computeGainsAtRisk(state.db, {
        accountIds: undefined,
        driverSymbol: "SPY",
        valuationDate: TODAY,
        moves: [-0.1, -0.2],
        volChangePoints: 0,
        trialPositions: (extra as { trialPositions?: never }).trialPositions,
        today: TODAY,
      });
      expect(JSON.stringify(body.data.result)).toBe(JSON.stringify(direct));
      expect("driverKind" in body.data.result).toBe(false);
      expect(Object.keys(body.data).sort()).toEqual(["result", "scopeFreshness", "yearGain", "yearGainFreshness"]);
    }
  });

  it("T1 an index-mode selectedMove (one of moves) leaves the reply unchanged", async () => {
    const plain = await post(validBody());
    const selected = await post({ ...validBody(), selectedMove: -0.2 });
    expect(selected.res.status).toBe(200);
    expect(JSON.stringify(selected.body.data)).toBe(JSON.stringify(plain.body.data));
    expect((await post({ ...validBody(), selectedMove: -0.3 })).res.status).toBe(400);
  });

  it("T20 a driver not on the list is 400; a listed name by id is 200 with driverKind single-name", async () => {
    const ok = await post({ ...validBody(), scope: "all", driver: { kind: "single-name", securityId: 101 }, moves: [-0.2, 0, 0.2] });
    expect(ok.res.status).toBe(200);
    expect(ok.body.data.result.driverKind).toBe("single-name");
    expect(ok.body.data.result.driverSymbol).toBe("ZZAA");
    expect((state.lastInput as { driver: unknown }).driver).toEqual({ kind: "single-name", symbol: "ZZAA", securityId: 101 });

    state.db.prepare("INSERT INTO securities (id, symbol, name, security_type, currency) VALUES (150, 'ZZNH', 'Not held', 'Stock', 'USD')").run();
    for (const driver of [
      { kind: "single-name", securityId: 150 }, // known, not held, not a trial
      { kind: "single-name", securityId: 999 }, // unknown
      { kind: "single-name", symbol: "ZZAA" }, // a name with a row is named by id, never by symbol
      { kind: "single-name", symbol: "ZZNOROW" }, // no row: no price, so never listed (fix round 1)
    ]) {
      const { res, body } = await post({ ...validBody(), driver });
      expect(res.status).toBe(400);
      expect(body).toEqual({ success: false, error: "driver is not one of the names this page can stress." });
    }
  });

  it("T20 a trial underlying joins the list for that request", async () => {
    state.db.prepare("INSERT INTO securities (id, symbol, name, security_type, currency) VALUES (150, 'ZZNH', 'Not held', 'Stock', 'USD')").run();
    price(state.db, 150, 40);
    const driver = { kind: "single-name", securityId: 150 };
    expect((await post({ ...validBody(), driver })).res.status).toBe(400);
    const trial = { ...shares, id: "t-buy", securityId: 150, side: "buy", price: 40 };
    expect((await post({ ...validBody(), driver, trialPositions: [trial] })).res.status).toBe(200);
  });

  it("fix 3: a non-dollar trial underlying never makes its name a driver", async () => {
    state.db.prepare("INSERT INTO securities (id, symbol, name, security_type, currency) VALUES (160, 'ZZJP', 'ZZ Japan', 'Stock', 'JPY')").run();
    price(state.db, 160, 900);
    const trial = { ...shares, id: "t-jp", securityId: 160, side: "buy", price: 900 };
    const { res } = await post({ ...validBody(), driver: { kind: "single-name", securityId: 160 }, trialPositions: [trial] });
    expect(res.status).toBe(400);
  });

  it.each([
    [{ kind: "index" }],
    [{ kind: "single-name" }],
    [{ kind: "single-name", securityId: 101, symbol: "ZZAA" }],
    [{ kind: "single-name", securityId: 0 }],
    [{ kind: "single-name", securityId: "101" }],
    [{ kind: "single-name", symbol: "" }],
    ["ZZAA"],
  ])("a malformed driver %o is 400 naming driver", async (driver) => {
    const { res, body } = await post({ ...validBody(), driver });
    expect(res.status).toBe(400);
    expect(body.error).toContain("driver");
  });

  it("T8 single-name: -0.81 or 1.01 is 400; 1.0 and -0.8 pass; index: 0.61 is 400 as today", async () => {
    const driver = { kind: "single-name", securityId: 101 };
    for (const moves of [[-0.81], [1.01]]) {
      const { res, body } = await post({ ...validBody(), driver, moves });
      expect(res.status).toBe(400);
      expect(body.error).toContain("moves");
    }
    expect((await post({ ...validBody(), driver, moves: [-0.8, 1.0] })).res.status).toBe(200);
    expect((await post({ ...validBody(), moves: [0.61] })).res.status).toBe(400);
    expect((await post({ ...validBody(), moves: [-0.6, 0.6] })).res.status).toBe(200);
    expect((await post({ ...validBody(), moves: [-0.8] })).res.status).toBe(400);
  });

  it("F3 brokerContractId round-trips through cleanTrialPositions; without it a trial keeps exactly today's keys; 0 is 400", async () => {
    await post({ ...validBody(), trialPositions: [opt] });
    expect(Object.keys((state.lastInput as { trialPositions: object[] }).trialPositions[0]).sort()).toEqual(Object.keys(opt).sort());

    await post({ ...validBody(), trialPositions: [{ ...opt, brokerContractId: 77001 }] });
    expect((state.lastInput as { trialPositions: object[] }).trialPositions[0]).toEqual({ ...opt, brokerContractId: 77001 });

    for (const bad of [0, 1.5, "7", -3]) {
      const { res, body } = await post({ ...validBody(), trialPositions: [{ ...opt, brokerContractId: bad }] });
      expect(res.status).toBe(400);
      expect(body.error).toContain("brokerContractId");
    }
  });
});
