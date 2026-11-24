import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays } from "@/lib/calendar/date-utils";
import * as driverBetaModule from "@/lib/compute/driver-beta";
import {
  barSeriesSecurityId,
  resolveDriverBeta,
  type DriverBeta,
  type DriverBetaInput,
} from "@/lib/compute/driver-beta";
import type { DailyBarEvidence } from "@/lib/compute/security-regression";
import {
  LEVERAGED_TRACKED_INDEX_SEEDS,
  trackedIndexFor,
} from "@/lib/securities/leveraged-tracked-index";
import type { LeveragedExposure } from "@/lib/compute/leveraged-fund";

// Gains at risk addendum, Task A2: each position's beta to the driver index,
// measured from daily bars on BOTH legs, or "no measured link" with a reason.
// No estimate. Synthetic ZZ tickers and round numbers only. Fixed clock
// 2026-11-10 (Eastern).

const TODAY = "2026-11-10";
const N_BARS = 120;
const NOT_LEVERAGED: LeveragedExposure = { flagged: false, factor: null };
const DRIVER_ID = 10;

function weekdaysEnding(last: string, count: number): string[] {
  const out: string[] = [];
  let d = last;
  while (out.length < count) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.unshift(d);
    d = addDays(d, -1);
  }
  return out;
}

function driverCum(n: number): number[] {
  const out = [0];
  for (let i = 1; i < n; i++) out.push(out[i - 1] + 0.01 * Math.sin(i * 1.3) + 0.002 * Math.cos(i * 0.7));
  return out;
}

function input(over: Partial<DriverBetaInput>): DriverBetaInput {
  return {
    securityId: 999,
    identitySymbol: "ZZX",
    storedUnderlyingSymbol: null,
    identitySecurityId: null,
    leveraged: NOT_LEVERAGED,
    fixedBeta: null,
    trackedIndexSymbol: null,
    ...over,
  };
}

describe("resolveDriverBeta", () => {
  let db: Database.Database;
  let dates: string[];
  let cum: number[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T15:00:00Z"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    dates = weekdaysEnding("2026-11-09", N_BARS);
    cum = driverCum(N_BARS);
    addSecurity(DRIVER_ID, "ZZQ", { conId: 9010 });
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  function addSecurity(
    id: number,
    symbol: string,
    opts: { type?: string; currency?: string; conId?: number | null } = {},
  ): void {
    db.prepare(
      "INSERT INTO securities (id, symbol, security_type, currency, ib_con_id) VALUES (?, ?, ?, ?, ?)",
    ).run(id, symbol, opts.type ?? "Stock", opts.currency ?? "USD", opts.conId ?? null);
  }

  function bars(id: number, multiple: number, count = N_BARS): void {
    const ins = db.prepare(
      `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
       VALUES (?, ?, '1 day', ?, ?, ?, ?, 1000)`,
    );
    const from = N_BARS - count;
    for (let i = from; i < N_BARS; i++) {
      const c = 100 * Math.exp(multiple * cum[i]);
      ins.run(id, dates[i], c, c, c, c);
    }
  }

  function seedDriver(): void {
    bars(DRIVER_ID, 1);
  }

  const opts = (driverSecurityId: number | null = DRIVER_ID) => ({ today: TODAY, driverSecurityId });

  it("no longer exports the removed rungs", () => {
    const names = Object.keys(driverBetaModule);
    for (const gone of [
      "MEASURED_BETA_EXCLUDED_PRICE_SOURCES",
      "REGRESSION_CACHE_MAX_AGE_DAYS",
      "MIN_USABLE_DRIVER_MARKET_BETA",
      "driverMarketBeta",
    ]) {
      expect(names).not.toContain(gone);
    }
  });

  it("the driver and an option on it are 1, even with no underlying row and no bars", () => {
    expect(resolveDriverBeta(db, input({ identitySymbol: " zzq " }), "ZZQ", opts(null))).toEqual({
      beta: 1,
      source: "driver",
    });
    expect(
      resolveDriverBeta(
        db,
        input({ identitySymbol: "ZZOPT 261218C00500000", storedUnderlyingSymbol: "ZZQ" }),
        "zzq",
        opts(null),
      ),
    ).toEqual({ beta: 1, source: "driver" });
  });

  it("fixed values for cash, bonds and bond funds win over a measurable series", () => {
    seedDriver();
    addSecurity(1, "ZZA");
    bars(1, 1.5);
    expect(resolveDriverBeta(db, input({ identitySymbol: "ZZCASH", fixedBeta: 0 }), "ZZQ", opts())).toEqual({
      beta: 0,
      source: "fixed",
    });
    expect(resolveDriverBeta(db, input({ identitySymbol: "ZZBOND", fixedBeta: 0.1 }), "ZZQ", opts())).toEqual({
      beta: 0.1,
      source: "fixed",
    });
    expect(
      resolveDriverBeta(db, input({ identitySymbol: "ZZA", identitySecurityId: 1, fixedBeta: 0 }), "ZZQ", opts()),
    ).toEqual({ beta: 0, source: "fixed" });
  });

  it("measured from daily bars on both legs, with the evidence", () => {
    seedDriver();
    addSecurity(1, "ZZA");
    bars(1, 1.5);
    const r = resolveDriverBeta(db, input({ identitySymbol: "ZZA", identitySecurityId: 1 }), "ZZQ", opts());
    expect(r.source).toBe("measured");
    if (r.source !== "measured") throw new Error("narrow");
    expect(r.beta).toBeCloseTo(1.5, 10);
    expect(r.evidence).toMatchObject({ outcome: "measured", pairs: N_BARS - 1, securityBars: N_BARS, driverBars: N_BARS });
  });

  it("a name with only prices and benchmark_prices rows has no measured link: no-daily-bars", () => {
    seedDriver();
    addSecurity(2, "ZZB");
    const ins = db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')");
    const insB = db.prepare("INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES (?, ?, ?, 'test')");
    for (let i = 0; i < N_BARS; i++) {
      ins.run(2, dates[i], 100 * Math.exp(1.5 * cum[i]));
      insB.run("ZZQ", dates[i], 100 * Math.exp(cum[i]));
      insB.run("SPY", dates[i], 100 * Math.exp(cum[i]));
    }
    const r = resolveDriverBeta(db, input({ identitySymbol: "ZZB", identitySecurityId: 2 }), "ZZQ", opts());
    expect(r).toMatchObject({ beta: null, source: "no-measured-link", reason: "no-daily-bars" });
  });

  it("an identity with no securities row is no-daily-bars, with empty evidence", () => {
    seedDriver();
    const r = resolveDriverBeta(db, input({ identitySymbol: "ZZNONE" }), "ZZQ", opts());
    expect(r).toMatchObject({ beta: null, source: "no-measured-link", reason: "no-daily-bars" });
    if (r.source !== "no-measured-link") throw new Error("narrow");
    expect(r.evidence).toMatchObject({ outcome: "no-daily-bars", beta: null, pairs: 0, securityBars: 0 });
  });

  it("driverSecurityId null is driver-bars-missing", () => {
    addSecurity(1, "ZZA");
    bars(1, 1.5);
    const r = resolveDriverBeta(db, input({ identitySymbol: "ZZA", identitySecurityId: 1 }), "ZZQ", opts(null));
    expect(r).toMatchObject({ beta: null, source: "no-measured-link", reason: "driver-bars-missing" });
  });

  it("a non-USD name is foreign-session", () => {
    seedDriver();
    addSecurity(3, "ZZF", { currency: "ZZD" });
    bars(3, 1.5);
    const r = resolveDriverBeta(db, input({ identitySymbol: "ZZF", identitySecurityId: 3 }), "ZZQ", opts());
    expect(r).toMatchObject({ beta: null, source: "no-measured-link", reason: "foreign-session" });
  });

  it("short-history and low-fit carry a fitted beta in evidence, but the result has none", () => {
    seedDriver();
    addSecurity(4, "ZZS");
    bars(4, 1.5, 30);
    const r = resolveDriverBeta(db, input({ identitySymbol: "ZZS", identitySecurityId: 4 }), "ZZQ", opts());
    expect(r).toMatchObject({ beta: null, source: "no-measured-link", reason: "short-history" });
    if (r.source !== "no-measured-link") throw new Error("narrow");
    // A1 sets an OLS beta whenever two or more pairs exist; it must not leak as a result beta.
    expect(r.evidence.beta).not.toBeNull();
  });

  it("leveraged: tracked index measured from bars (0.8) times the signed factor", () => {
    seedDriver();
    addSecurity(20, "ZZT", { type: "ETF", conId: 9020 });
    bars(20, 0.8);
    addSecurity(5, "ZZL", { type: "ETF" });
    bars(5, 9); // its own regression would read 9; never consulted
    const lev = (factor: number | null, tracked: string | null): DriverBetaInput =>
      input({
        identitySymbol: "ZZL",
        identitySecurityId: 5,
        leveraged: { flagged: true, factor },
        trackedIndexSymbol: tracked,
        fixedBeta: 0.5,
      });

    const r = resolveDriverBeta(db, lev(2, "ZZT"), "ZZQ", opts());
    expect(r.source).toBe("leveraged");
    if (r.source !== "leveraged") throw new Error("narrow");
    expect(r.trackedBeta).toBeCloseTo(0.8, 10);
    expect(r.factor).toBe(2);
    expect(r.beta).toBeCloseTo(1.6, 10);
    expect(r.evidence?.outcome).toBe("measured");

    // Tracking the driver itself: 1, no evidence needed.
    expect(resolveDriverBeta(db, lev(-3, " zzq "), "ZZQ", opts(null))).toEqual({
      beta: -3,
      source: "leveraged",
      trackedBeta: 1,
      factor: -3,
      evidence: null,
    });

    expect(resolveDriverBeta(db, lev(null, "ZZT"), "ZZQ", opts())).toEqual({
      beta: null,
      source: "not-modelled",
      reason: "leveraged-no-factor",
    });
    expect(resolveDriverBeta(db, lev(3, null), "ZZQ", opts())).toEqual({
      beta: null,
      source: "not-modelled",
      reason: "leveraged-no-tracked-index",
    });
    // A tracked symbol with no securities row: refused, never a throw.
    expect(resolveDriverBeta(db, lev(3, "ZZNOROW"), "ZZQ", opts())).toEqual({
      beta: null,
      source: "not-modelled",
      reason: "tracked-index-not-measured",
    });
    // A flagged fund whose identity is the driver still goes by the leveraged rule.
    expect(
      resolveDriverBeta(db, input({ identitySymbol: "ZZQ", leveraged: { flagged: true, factor: null } }), "ZZQ", opts()),
    ).toEqual({ beta: null, source: "not-modelled", reason: "leveraged-no-factor" });
  });

  it("leveraged: tracked-index-not-measured when the tracked index has no bars", () => {
    seedDriver();
    addSecurity(20, "ZZT", { type: "ETF", conId: 9020 });
    const r = resolveDriverBeta(
      db,
      input({ identitySymbol: "ZZL", leveraged: { flagged: true, factor: 2 }, trackedIndexSymbol: "ZZT" }),
      "ZZQ",
      opts(),
    );
    expect(r).toEqual({ beta: null, source: "not-modelled", reason: "tracked-index-not-measured" });
  });

  it("the five outcomes are a discriminated union: an unmeasured beta is never a number", () => {
    seedDriver();
    addSecurity(4, "ZZS");
    bars(4, 1.5, 30);
    const outcomes: DriverBeta[] = [
      resolveDriverBeta(db, input({ identitySymbol: "ZZQ" }), "ZZQ", opts()),
      resolveDriverBeta(db, input({ fixedBeta: 0 }), "ZZQ", opts()),
      resolveDriverBeta(db, input({ leveraged: { flagged: true, factor: 2 }, trackedIndexSymbol: "ZZQ" }), "ZZQ", opts()),
      resolveDriverBeta(db, input({ identitySecurityId: 4, identitySymbol: "ZZS" }), "ZZQ", opts()),
      resolveDriverBeta(db, input({ leveraged: { flagged: true, factor: null } }), "ZZQ", opts()),
    ];
    expect(outcomes.map((o) => o.source)).toEqual(["driver", "fixed", "leveraged", "no-measured-link", "not-modelled"]);
    for (const o of outcomes) {
      if (o.source === "no-measured-link" || o.source === "not-modelled") expect(o.beta).toBeNull();
      else expect(typeof o.beta).toBe("number");
    }
  });

  it("memoises each regression within one call's memo", () => {
    seedDriver();
    addSecurity(1, "ZZA");
    bars(1, 1.5);
    const memo = new Map<number, DailyBarEvidence>();
    const spy = vi.spyOn(db, "prepare");
    const a = resolveDriverBeta(db, input({ identitySymbol: "ZZA", identitySecurityId: 1 }), "ZZQ", {
      ...opts(),
      regressionMemo: memo,
    });
    const calls = spy.mock.calls.length;
    const b = resolveDriverBeta(db, input({ identitySymbol: "ZZA", identitySecurityId: 1, securityId: 7 }), "ZZQ", {
      ...opts(),
      regressionMemo: memo,
    });
    expect(spy.mock.calls.length).toBe(calls);
    expect(b).toEqual(a);
  });

  it("reads only ohlcv_bars and securities: no prices, no benchmark_prices, no cache; no table changes", () => {
    seedDriver();
    addSecurity(20, "ZZT", { type: "ETF", conId: 9020 });
    bars(20, 0.8);
    addSecurity(1, "ZZA");
    bars(1, 1.5);
    addSecurity(3, "ZZC");
    const changes = () => (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const before = changes();
    const spy = vi.spyOn(db, "prepare");
    resolveDriverBeta(db, input({ identitySymbol: "ZZA", identitySecurityId: 1 }), "ZZQ", opts());
    resolveDriverBeta(db, input({ identitySymbol: "ZZC", identitySecurityId: 3 }), "ZZQ", opts());
    resolveDriverBeta(
      db,
      input({ identitySymbol: "ZZL", leveraged: { flagged: true, factor: 2 }, trackedIndexSymbol: "ZZT" }),
      "ZZQ",
      opts(),
    );
    const sql = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    expect(sql.length).toBeGreaterThan(0);
    for (const s of sql) {
      expect(s).not.toMatch(/\bbenchmark_prices\b/);
      expect(s).not.toMatch(/\bprices\b/);
      expect(s).not.toMatch(/security_regressions|security_betas/);
      expect(s).toMatch(/\b(ohlcv_bars|securities)\b/);
    }
    expect(changes()).toBe(before);
  });

  it("a blank driver symbol is an error, never a driver match", () => {
    expect(() => resolveDriverBeta(db, input({}), "", opts())).toThrow("driverSymbol is required");
    expect(() => resolveDriverBeta(db, input({}), "   ", opts())).toThrow("driverSymbol is required");
  });
});

describe("barSeriesSecurityId", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  afterEach(() => db.close());

  function add(id: number, symbol: string, type: string, conId: number | null): void {
    db.prepare("INSERT INTO securities (id, symbol, security_type, ib_con_id) VALUES (?, ?, ?, ?)").run(
      id,
      symbol,
      type,
      conId,
    );
  }

  function bars(id: number, n: number, opts: { size?: string; bad?: boolean } = {}): void {
    const ins = db.prepare(
      `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1000)`,
    );
    for (let i = 0; i < n; i++) {
      const c = opts.bad ? 0 : 100;
      ins.run(id, addDays("2026-01-01", i), opts.size ?? "1 day", c, c, c, c);
    }
  }

  // securities.symbol is UNIQUE, so rows that share a symbol differ only by
  // case or surrounding space (what the trimmed, upper-cased match unites).
  it("picks the non-option row with a contract id and the most priced daily bars", () => {
    add(1, "ZZQ", "ETF", null); // no contract id: never chosen
    bars(1, 50);
    add(2, "zzq", "ETF", 9002);
    bars(2, 5);
    add(3, "zzq ", "ETF", 9003);
    bars(3, 10);
    bars(3, 40, { size: "1 hour" }); // intraday bars do not count
    add(4, " ZZQ", "Option", 9004);
    bars(4, 100);
    add(5, "Zzq", "ETF", 9005);
    bars(5, 30, { bad: true }); // unpriced bars do not count
    expect(barSeriesSecurityId(db, " zzq ")).toBe(3);
  });

  it("ties go to the lowest id; a row with no bars is still the series row", () => {
    add(7, "ZZR", "Stock", 9007);
    add(6, "zzr", "Stock", 9006);
    expect(barSeriesSecurityId(db, "ZZR")).toBe(6);
    bars(7, 3);
    bars(6, 3);
    expect(barSeriesSecurityId(db, "ZZR")).toBe(6);
  });

  it("null when no row qualifies, and for a blank symbol", () => {
    add(8, "ZZN", "Stock", null);
    add(9, "zzn", "Put", 9009);
    expect(barSeriesSecurityId(db, "ZZN")).toBeNull();
    expect(barSeriesSecurityId(db, "ZZMISSING")).toBeNull();
    expect(barSeriesSecurityId(db, "  ")).toBeNull();
  });
});

describe("trackedIndexFor", () => {
  it("ships with no seed entries", () => {
    expect(Object.keys(LEVERAGED_TRACKED_INDEX_SEEDS)).toEqual([]);
    expect(Object.isFrozen(LEVERAGED_TRACKED_INDEX_SEEDS)).toBe(true);
    expect(trackedIndexFor("ZZL")).toBeNull();
  });

  it("looks up a fund by trimmed, upper-cased symbol in a supplied seed map", () => {
    const seeds = Object.freeze({ ZZL: "zzidx ", ZZBLANK: "  " });
    expect(trackedIndexFor(" zzl ", seeds)).toBe("ZZIDX");
    expect(trackedIndexFor("ZZBLANK", seeds)).toBeNull();
    expect(trackedIndexFor("ZZOTHER", seeds)).toBeNull();
  });
});
