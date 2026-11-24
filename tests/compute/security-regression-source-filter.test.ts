import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays } from "@/lib/calendar/date-utils";
import {
  computeBenchmarkRegression,
  computeSecurityRegression,
  regressionBetaVerdict,
} from "@/lib/compute/security-regression";

// Gains at risk, Task 2: the optional price-source filter on the security
// series and the benchmark-to-benchmark regression. Synthetic ZZ tickers and
// round numbers only.

const DAYS = 60;
const SEC_ID = 1;

/** The last DAYS weekdays ending 2026-11-09 (the fixed clock is 2026-11-10), oldest first. */
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

/** Cumulative SPY log return at each index: a deterministic, varied path. */
function spyCumLog(): number[] {
  const out = [0];
  for (let i = 1; i < DAYS; i++) {
    out.push(out[i - 1] + 0.01 * Math.sin(i * 1.3) + 0.002 * Math.cos(i * 0.7));
  }
  return out;
}

/** A close whose log returns are exactly `multipleOfSpy` times SPY's. */
function closeAt(i: number, multipleOfSpy: number, base = 100): number {
  return base * Math.exp(multipleOfSpy * spyCumLog()[i]);
}

describe("computeSecurityRegression: optional price-source filter", () => {
  let db: Database.Database;
  let dates: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T15:00:00Z"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("INSERT INTO securities (id, symbol, security_type) VALUES (?, 'ZZA', 'Stock')").run(
      SEC_ID,
    );
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

  /**
   * ZZA moves 1.5x QQQ (QQQ = 1.25x SPY) on TWS rows up to `twsThrough`; after
   * it, rows carry `lateSource` and hold the PREVIOUS session's close (dated
   * one session late, as a Plaid as-of row can be).
   */
  function seedZza(twsThrough: number, lateSource: string): void {
    const ins = db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, ?)",
    );
    const m = 1.5 * 1.25;
    for (let i = 0; i < DAYS; i++) {
      if (i <= twsThrough) ins.run(SEC_ID, dates[i], closeAt(i, m), "tws");
      else ins.run(SEC_ID, dates[i], closeAt(i - 1, m), lateSource);
    }
  }

  it("without opts the result is unchanged", () => {
    seedBench("SPY", 1);
    seedBench("QQQ", 1.25);
    seedZza(44, "plaid");
    const plain = computeSecurityRegression(db, SEC_ID, "QQQ");
    expect(plain).not.toBeNull();
    expect(computeSecurityRegression(db, SEC_ID, "QQQ", 252, undefined)).toStrictEqual(plain);
    expect(computeSecurityRegression(db, SEC_ID, "QQQ", 252, {})).toStrictEqual(plain);
    expect(
      computeSecurityRegression(db, SEC_ID, "QQQ", 252, { excludePriceSources: [] }),
    ).toStrictEqual(plain);
    // Without the filter a row's source is never read: relabelling the late
    // rows changes nothing.
    db.prepare("UPDATE prices SET source = 'tws' WHERE source = 'plaid'").run();
    expect(computeSecurityRegression(db, SEC_ID, "QQQ")).toStrictEqual(plain);
    // And those late rows really are in the unfiltered series (beta is off 1.5).
    expect(Math.abs(plain!.beta - 1.5)).toBeGreaterThan(0.05);
  });

  it("excluded sources are left out of the security series", () => {
    seedBench("QQQ", 1.25);
    seedZza(44, "plaid");
    const r = computeSecurityRegression(db, SEC_ID, "QQQ", 252, { excludePriceSources: ["plaid"] });
    expect(r).not.toBeNull();
    expect(r!.beta).toBeCloseTo(1.5, 10);
    expect(r!.rSquared).toBeCloseTo(1, 10);
    expect(r!.dataPoints).toBe(44);
    expect(regressionBetaVerdict(r!).ok).toBe(true);
  });

  it("too few pairs left returns a failing-gate result or null", () => {
    seedBench("QQQ", 1.25);
    seedZza(20, "plaid"); // 21 TWS rows: 20 pairs
    const r = computeSecurityRegression(db, SEC_ID, "QQQ", 252, { excludePriceSources: ["plaid"] });
    expect(r === null || !regressionBetaVerdict(r).ok).toBe(true);
    // Every row excluded: no regression at all.
    db.prepare("UPDATE prices SET source = 'plaid'").run();
    expect(
      computeSecurityRegression(db, SEC_ID, "QQQ", 252, { excludePriceSources: ["plaid"] }),
    ).toBeNull();
  });

  it("benchmark-to-benchmark regression reads benchmark_prices only", () => {
    seedBench("SPY", 1);
    seedBench("QQQ", 1.25);
    // A securities row named QQQ with a different series must not be read.
    db.prepare("INSERT INTO securities (id, symbol, security_type) VALUES (2, 'QQQ', 'ETF')").run();
    const ins = db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (2, ?, ?, 'tws')",
    );
    for (let i = 0; i < DAYS; i++) ins.run(dates[i], closeAt(i, 3));

    const r = computeBenchmarkRegression(db, "QQQ", "SPY");
    expect(r).not.toBeNull();
    expect(r!.beta).toBeCloseTo(1.25, 10);
    expect(r!.rSquared).toBeCloseTo(1, 10);
    expect(r!.dataPoints).toBe(DAYS - 1);
    expect(computeBenchmarkRegression(db, " qqq ", "spy")!.beta).toBeCloseTo(1.25, 10);
    // No series for either side: null.
    expect(computeBenchmarkRegression(db, "ZZIDX", "SPY")).toBeNull();
    expect(computeBenchmarkRegression(db, "QQQ", "ZZIDX")).toBeNull();
  });
});
