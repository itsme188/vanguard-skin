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

async function post(body: unknown) {
  const { POST } = await import("@/app/api/compute/gains-at-risk/route");
  const res = await POST(
    new Request("http://localhost/api/compute/gains-at-risk", {
      method: "POST",
      body: JSON.stringify(body),
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
    expect(data.result.moves.map((m: { move: number }) => m.move)).toEqual([-0.1, -0.2]);
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
    for (const m of body.data.result.moves) {
      expect(m.bookPnlUsd).toBe(0);
      expect(m.losersPnlUsd).toBe(0);
      expect(m.offsetsPnlUsd).toBe(0);
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

  it("the shared input module imports nothing from lib/queries", () => {
    const src = readFileSync(join(process.cwd(), "lib/analysis/gains-at-risk-input.ts"), "utf8");
    // Value imports only: a type-only import is erased at build.
    const valueImports = src.split("\n").filter((l) => /^import\s/.test(l) && !/^import\s+type\s/.test(l));
    expect(valueImports.filter((l) => l.includes("@/lib/queries/"))).toEqual([]);
    expect(valueImports.filter((l) => l.includes("better-sqlite3"))).toEqual([]);
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
