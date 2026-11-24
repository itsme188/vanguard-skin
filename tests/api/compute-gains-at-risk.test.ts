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
}));

vi.mock("@/lib/compute/gains-at-risk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compute/gains-at-risk")>();
  return {
    ...actual,
    computeGainsAtRisk: (...args: Parameters<typeof actual.computeGainsAtRisk>) => {
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
    const forbidden = /^@\/lib\/(compute|queries|tws)\/|^@\/lib\/db(\/|$)|^@\/lib\/db\.|better-sqlite3|@stoqey\/ib/;
    expect(valueSources.filter((s) => forbidden.test(s))).toEqual([]);
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
});
