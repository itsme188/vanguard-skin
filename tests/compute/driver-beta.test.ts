import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays } from "@/lib/calendar/date-utils";
import {
  MEASURED_BETA_EXCLUDED_PRICE_SOURCES,
  MIN_USABLE_DRIVER_MARKET_BETA,
  REGRESSION_CACHE_MAX_AGE_DAYS,
  driverMarketBeta,
  resolveDriverBeta,
  type DriverBetaInput,
} from "@/lib/compute/driver-beta";
import {
  LEVERAGED_TRACKED_INDEX_SEEDS,
  trackedIndexFor,
} from "@/lib/securities/leveraged-tracked-index";
import type { LeveragedExposure } from "@/lib/compute/leveraged-fund";

// Gains at risk, Task 2: each position's beta to the driver index, with an
// honest source label and a refusal (never a guess) when none can be
// justified. Synthetic ZZ tickers and round numbers only.

const DAYS = 60;
const NOT_LEVERAGED: LeveragedExposure = { flagged: false, factor: null };

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
  for (let i = 1; i < DAYS; i++) {
    out.push(out[i - 1] + 0.01 * Math.sin(i * 1.3) + 0.002 * Math.cos(i * 0.7));
  }
  return out;
}

function closeAt(i: number, multipleOfSpy: number, base = 100): number {
  return base * Math.exp(multipleOfSpy * spyCumLog()[i]);
}

function input(over: Partial<DriverBetaInput>): DriverBetaInput {
  return {
    securityId: 999,
    identitySymbol: "ZZX",
    storedUnderlyingSymbol: null,
    identitySecurityId: null,
    leveraged: NOT_LEVERAGED,
    fixedBeta: null,
    heuristicMarketBeta: 1.15,
    trackedIndexSymbol: null,
    ...over,
  };
}

describe("resolveDriverBeta", () => {
  let db: Database.Database;
  let dates: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T15:00:00Z"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    dates = tradingDates();
  });

  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  function seedBench(symbol: string, multipleOfSpy: number, base = 400): void {
    const ins = db.prepare(
      "INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES (?, ?, ?, 'test')",
    );
    for (let i = 0; i < DAYS; i++) ins.run(symbol, dates[i], closeAt(i, multipleOfSpy, base));
  }

  function addSecurity(id: number, symbol: string, type = "Stock"): void {
    db.prepare("INSERT INTO securities (id, symbol, security_type) VALUES (?, ?, ?)").run(
      id,
      symbol,
      type,
    );
  }

  function seedPrices(id: number, multipleOfSpy: number, source: string): void {
    const ins = db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, ?)",
    );
    for (let i = 0; i < DAYS; i++) ins.run(id, dates[i], closeAt(i, multipleOfSpy), source);
  }

  function cacheRow(id: number, benchmark: string, beta: number, day: string): void {
    db.prepare(
      `INSERT INTO security_regressions
         (security_id, benchmark_symbol, computed_at_day, beta, vol, correlation, r_squared, data_points)
       VALUES (?, ?, ?, ?, 0.2, 1, 1, 59)`,
    ).run(id, benchmark, day, beta);
  }

  it("exports the stated constants", () => {
    expect(MEASURED_BETA_EXCLUDED_PRICE_SOURCES).toEqual(["plaid"]);
    expect(REGRESSION_CACHE_MAX_AGE_DAYS).toBe(7);
    expect(MIN_USABLE_DRIVER_MARKET_BETA).toBe(0.2);
  });

  it("the driver and an option on it are 1, even with no underlying row", () => {
    expect(resolveDriverBeta(db, input({ identitySymbol: " qqq " }), "QQQ")).toEqual({
      beta: 1,
      source: "driver",
    });
    expect(
      resolveDriverBeta(
        db,
        input({
          identitySymbol: "ZZOPT 261218C00500000",
          storedUnderlyingSymbol: "QQQ",
          identitySecurityId: null,
        }),
        "qqq",
      ),
    ).toEqual({ beta: 1, source: "driver" });
  });

  it("measured against the driver when the gate passes", () => {
    seedBench("SPY", 1);
    seedBench("QQQ", 1.25);
    addSecurity(1, "ZZA");
    seedPrices(1, 1.5 * 1.25, "tws");
    const r = resolveDriverBeta(db, input({ identitySymbol: "ZZA", identitySecurityId: 1 }), "QQQ");
    expect(r.source).toBe("measured");
    expect(r.beta).toBeCloseTo(1.5, 10);
  });

  it("market-converted: SPY beta over the driver's benchmark SPY beta", () => {
    seedBench("SPY", 1);
    seedBench("QQQ", 1.25);
    addSecurity(2, "ZZB");
    // No ZZB price rows, so no regression against QQQ; a fresh measured SPY
    // regression (1.5) sits in the cache.
    cacheRow(2, "SPY", 1.5, "2026-11-09");
    const r = resolveDriverBeta(db, input({ identitySymbol: "ZZB", identitySecurityId: 2 }), "QQQ");
    expect(r.source).toBe("market-converted");
    expect(r.beta).toBeCloseTo(1.2, 10);
  });

  it("estimated: heuristic over the driver's SPY beta", () => {
    seedBench("SPY", 1);
    seedBench("QQQ", 1.25);
    addSecurity(3, "ZZC");
    const r = resolveDriverBeta(
      db,
      input({ identitySymbol: "ZZC", identitySecurityId: 3, heuristicMarketBeta: 1.15 }),
      "QQQ",
    );
    expect(r.source).toBe("estimated");
    expect(r.beta).toBeCloseTo(0.92, 10);
    // An identity not on file at all is estimated the same way.
    const off = resolveDriverBeta(db, input({ identitySymbol: "ZZD" }), "QQQ");
    expect(off.source).toBe("estimated");
    expect(off.beta).toBeCloseTo(0.92, 10);
    // Against SPY the driver market beta is exactly 1: the heuristic itself.
    expect(resolveDriverBeta(db, input({ identitySymbol: "ZZD" }), "SPY")).toEqual({
      beta: 1.15,
      source: "estimated",
    });
  });

  it("no usable driver conversion: not modelled, never divided by 1", () => {
    seedBench("SPY", 1);
    const refusal = { beta: null, source: "not-modelled", reason: "no-driver-conversion" };
    // No QQQ benchmark rows.
    expect(resolveDriverBeta(db, input({ identitySymbol: "ZZC" }), "QQQ")).toEqual(refusal);
    expect(driverMarketBeta(db, "QQQ")).toBeNull();
    // Even a measured SPY beta is not converted without a driver beta.
    addSecurity(2, "ZZB");
    cacheRow(2, "SPY", 1.5, "2026-11-09");
    expect(
      resolveDriverBeta(db, input({ identitySymbol: "ZZB", identitySecurityId: 2 }), "QQQ"),
    ).toEqual(refusal);
    // QQQ's beta to SPY measured at 0.1: below the usable floor.
    seedBench("QQQ", 0.1);
    expect(driverMarketBeta(db, "QQQ")).toBeNull();
    expect(resolveDriverBeta(db, input({ identitySymbol: "ZZC" }), "QQQ")).toEqual(refusal);
  });

  it("driverMarketBeta: SPY is exactly 1, others measured against SPY", () => {
    expect(driverMarketBeta(db, "SPY")).toBe(1);
    expect(driverMarketBeta(db, " spy ")).toBe(1);
    seedBench("SPY", 1);
    seedBench("VTI", 1.05);
    expect(driverMarketBeta(db, "VTI")).toBeCloseTo(1.05, 10);
    seedBench("ZZNEG", -0.5);
    expect(driverMarketBeta(db, "ZZNEG")).toBeCloseTo(-0.5, 10);
  });

  it("fixed values for cash, bonds and bond funds", () => {
    seedBench("SPY", 1);
    seedBench("QQQ", 1.25);
    addSecurity(1, "ZZA");
    seedPrices(1, 1.5 * 1.25, "tws");
    expect(resolveDriverBeta(db, input({ identitySymbol: "ZZCASH", fixedBeta: 0 }), "QQQ")).toEqual(
      { beta: 0, source: "fixed" },
    );
    expect(
      resolveDriverBeta(db, input({ identitySymbol: "ZZBOND", fixedBeta: 0.1 }), "QQQ"),
    ).toEqual({ beta: 0.1, source: "fixed" });
    // A fixed value wins over a measurable series.
    expect(
      resolveDriverBeta(db, input({ identitySymbol: "ZZA", identitySecurityId: 1, fixedBeta: 0 }), "QQQ"),
    ).toEqual({ beta: 0, source: "fixed" });
  });

  it("leveraged: tracked beta times the signed factor, never its own regression", () => {
    seedBench("SPY", 1);
    seedBench("QQQ", 1.25);
    addSecurity(5, "ZZL", "ETF");
    // Its own regression against QQQ would read 9 (both computed and cached).
    seedPrices(5, 9 * 1.25, "tws");
    cacheRow(5, "QQQ", 9, "2026-11-09");
    const lev = (factor: number | null, tracked: string | null): DriverBetaInput =>
      input({
        identitySymbol: "ZZL",
        identitySecurityId: 5,
        leveraged: { flagged: true, factor },
        trackedIndexSymbol: tracked,
        fixedBeta: 0.5, // never consulted for a flagged row
      });

    expect(resolveDriverBeta(db, lev(3, "QQQ"), "QQQ")).toEqual({ beta: 3, source: "leveraged" });
    expect(resolveDriverBeta(db, lev(-3, " qqq "), "QQQ")).toEqual({
      beta: -3,
      source: "leveraged",
    });

    seedBench("ZZIDX", 0.8 * 1.25); // 0.8x QQQ
    const viaIdx = resolveDriverBeta(db, lev(2, "ZZIDX"), "QQQ");
    expect(viaIdx.source).toBe("leveraged");
    expect(viaIdx.beta).toBeCloseTo(1.6, 10);

    expect(resolveDriverBeta(db, lev(null, "QQQ"), "QQQ")).toEqual({
      beta: null,
      source: "not-modelled",
      reason: "leveraged-no-factor",
    });
    expect(resolveDriverBeta(db, lev(3, null), "QQQ")).toEqual({
      beta: null,
      source: "not-modelled",
      reason: "leveraged-no-tracked-index",
    });
    expect(resolveDriverBeta(db, lev(3, "ZZNOSERIES"), "QQQ")).toEqual({
      beta: null,
      source: "not-modelled",
      reason: "tracked-index-not-measured",
    });
    // A flagged fund whose identity is the driver still goes by the leveraged rule.
    expect(
      resolveDriverBeta(
        db,
        input({ identitySymbol: "QQQ", leveraged: { flagged: true, factor: null } }),
        "QQQ",
      ),
    ).toEqual({ beta: null, source: "not-modelled", reason: "leveraged-no-factor" });
  });

  it("plaid-sourced rows never feed a measured beta", () => {
    seedBench("SPY", 1);
    seedBench("QQQ", 1.25);
    addSecurity(6, "ZZP", "Mutual Fund");
    seedPrices(6, 1.5 * 1.25, "plaid");
    // Fresh cache rows exist, but the security has plaid rows in the window,
    // so they are not read.
    cacheRow(6, "QQQ", 1.5, "2026-11-09");
    cacheRow(6, "SPY", 1.875, "2026-11-09");
    const r = resolveDriverBeta(db, input({ identitySymbol: "ZZP", identitySecurityId: 6 }), "QQQ");
    expect(r.source).toBe("estimated");
    expect(r.beta).toBeCloseTo(0.92, 10);
  });

  it("cache: used at 7 days old, recomputed at 8, ignored when the security has plaid rows", () => {
    seedBench("SPY", 1);
    seedBench("QQQ", 1.25);
    addSecurity(1, "ZZA");
    seedPrices(1, 1.5 * 1.25, "tws");
    const zza = input({ identitySymbol: "ZZA", identitySecurityId: 1 });

    cacheRow(1, "QQQ", 2.0, "2026-11-03");
    expect(resolveDriverBeta(db, zza, "QQQ")).toEqual({ beta: 2.0, source: "measured" });

    db.prepare("DELETE FROM security_regressions").run();
    cacheRow(1, "QQQ", 2.0, "2026-11-02");
    const stale = resolveDriverBeta(db, zza, "QQQ");
    expect(stale.source).toBe("measured");
    expect(stale.beta).toBeCloseTo(1.5, 10);

    db.prepare("DELETE FROM security_regressions").run();
    cacheRow(1, "QQQ", 2.0, "2026-11-03");
    // One plaid row inside the window (a Sunday, so no return pair uses it).
    db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (1, '2026-11-08', 100, 'plaid')",
    ).run();
    const withPlaid = resolveDriverBeta(db, zza, "QQQ");
    expect(withPlaid.source).toBe("measured");
    expect(withPlaid.beta).toBeCloseTo(1.5, 10);
  });

  it("cache: a row from before REGRESSION_ENGINE_SINCE is never read", () => {
    seedBench("SPY", 1);
    seedBench("QQQ", 1.25);
    addSecurity(1, "ZZA");
    seedPrices(1, 1.5 * 1.25, "tws");
    const zza = input({ identitySymbol: "ZZA", identitySecurityId: 1 });
    cacheRow(1, "QQQ", 2.0, "2026-10-20");
    const r = resolveDriverBeta(db, zza, "QQQ");
    expect(r.source).toBe("measured");
    expect(r.beta).toBeCloseTo(1.5, 10);
    // Even when that row would be young enough for the age rule.
    const young = resolveDriverBeta(db, zza, "QQQ", { today: "2026-10-22" });
    expect(young.beta).toBeCloseTo(1.5, 10);
  });

  it("cache: a row dated after today is never read", () => {
    seedBench("SPY", 1);
    seedBench("QQQ", 1.25);
    addSecurity(1, "ZZA");
    seedPrices(1, 1.5 * 1.25, "tws");
    cacheRow(1, "QQQ", 2.0, "2026-11-12"); // today + 2
    const r = resolveDriverBeta(db, input({ identitySymbol: "ZZA", identitySecurityId: 1 }), "QQQ");
    expect(r.source).toBe("measured");
    expect(r.beta).toBeCloseTo(1.5, 10);
  });

  it("a blank driver symbol is an error, never a driver match", () => {
    expect(() => resolveDriverBeta(db, input({}), "")).toThrow("driverSymbol is required");
    expect(() => resolveDriverBeta(db, input({}), "   ")).toThrow("driverSymbol is required");
  });

  it("a non-finite heuristic market beta is refused, never returned", () => {
    seedBench("SPY", 1);
    seedBench("QQQ", 1.25);
    const refusal = { beta: null, source: "not-modelled", reason: "no-heuristic-beta" };
    for (const h of [NaN, Infinity, -Infinity]) {
      expect(
        resolveDriverBeta(db, input({ identitySymbol: "ZZC", heuristicMarketBeta: h }), "QQQ"),
      ).toEqual(refusal);
      expect(
        resolveDriverBeta(db, input({ identitySymbol: "ZZC", heuristicMarketBeta: h }), "SPY"),
      ).toEqual(refusal);
    }
  });

  it("reads only: no table changes after on-demand computation", () => {
    seedBench("SPY", 1);
    seedBench("QQQ", 1.25);
    seedBench("ZZIDX", 1);
    addSecurity(1, "ZZA");
    seedPrices(1, 1.5 * 1.25, "tws");
    addSecurity(3, "ZZC");
    const count = () =>
      (db.prepare("SELECT COUNT(*) AS n FROM security_regressions").get() as { n: number }).n;
    const changes = () =>
      (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const beforeRows = count();
    const beforeChanges = changes();

    resolveDriverBeta(db, input({ identitySymbol: "ZZA", identitySecurityId: 1 }), "QQQ");
    resolveDriverBeta(db, input({ identitySymbol: "ZZC", identitySecurityId: 3 }), "QQQ");
    resolveDriverBeta(
      db,
      input({ identitySymbol: "ZZL", leveraged: { flagged: true, factor: 2 }, trackedIndexSymbol: "ZZIDX" }),
      "QQQ",
    );
    driverMarketBeta(db, "QQQ");

    expect(count()).toBe(beforeRows);
    expect(changes()).toBe(beforeChanges);
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
