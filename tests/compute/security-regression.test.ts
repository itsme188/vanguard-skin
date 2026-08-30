import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  computeSecurityRegression,
  regressionBetaVerdict,
} from "@/lib/compute/security-regression";
import {
  MIN_BETA_PAIRS,
  MIN_BETA_R_SQUARED,
} from "@/lib/compute/beta-confidence";
import {
  getCachedRegression,
  upsertRegression,
} from "@/lib/queries/security-regressions";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE securities (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      name TEXT,
      security_type TEXT DEFAULT 'stock'
    );

    CREATE TABLE prices (
      id INTEGER PRIMARY KEY,
      security_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT DEFAULT 'test',
      UNIQUE(security_id, date),
      FOREIGN KEY (security_id) REFERENCES securities(id)
    );

    CREATE TABLE benchmark_prices (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      close_price REAL NOT NULL,
      source TEXT NOT NULL DEFAULT 'test',
      UNIQUE(symbol, date)
    );

    CREATE TABLE security_regressions (
      security_id INTEGER NOT NULL,
      benchmark_symbol TEXT NOT NULL,
      computed_at_day TEXT NOT NULL,
      beta REAL,
      vol REAL,
      correlation REAL,
      r_squared REAL,
      data_points INTEGER,
      PRIMARY KEY (security_id, benchmark_symbol, computed_at_day),
      FOREIGN KEY (security_id) REFERENCES securities(id)
    );
  `);

  return db;
}

function recentDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

/**
 * Seed N daily prices for a security and a benchmark such that the security's
 * log returns are exactly `ratio` × the benchmark's log returns. The benchmark's
 * per-day log return varies by day (deterministic sine wave) so the regression
 * has non-zero variance to work against. Because the security's log return on
 * day i is `ratio × benchmarkLogReturn[i]` exactly, the OLS beta resolves to
 * `ratio` and rSquared resolves to 1 (modulo floating-point noise).
 */
function seedSyntheticPair(
  db: Database.Database,
  securityId: number,
  benchmarkSymbol: string,
  days: number,
  ratio: number
): void {
  const insSec = db.prepare(
    `INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)`
  );
  const insBen = db.prepare(
    `INSERT INTO benchmark_prices (symbol, date, close_price) VALUES (?, ?, ?)`
  );

  let benchmarkPrice = 100;
  let securityPrice = 100;
  // Day 0 is the oldest seeded price.
  insBen.run(benchmarkSymbol, recentDate(days - 1), benchmarkPrice);
  insSec.run(securityId, recentDate(days - 1), securityPrice);

  for (let i = 1; i < days; i++) {
    // Deterministic per-day log return in [0.005, 0.015] so variance > 0.
    const benchmarkLogReturn = 0.01 + 0.005 * Math.sin(i * 0.7);
    const securityLogReturn = ratio * benchmarkLogReturn;
    benchmarkPrice = benchmarkPrice * Math.exp(benchmarkLogReturn);
    securityPrice = securityPrice * Math.exp(securityLogReturn);
    const date = recentDate(days - 1 - i);
    insBen.run(benchmarkSymbol, date, benchmarkPrice);
    insSec.run(securityId, date, securityPrice);
  }
}

describe("computeSecurityRegression", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare(`INSERT INTO securities (id, symbol) VALUES (1, 'AAPL')`).run();
  });

  it("returns beta close to seeded ratio (1.5×) for perfectly correlated data", () => {
    seedSyntheticPair(db, 1, "SPY", 30, 1.5);
    const result = computeSecurityRegression(db, 1, "SPY");
    expect(result).not.toBeNull();
    expect(result!.beta).toBeCloseTo(1.5, 1);
  });

  it("returns rSquared ~ 1 for perfectly correlated synthetic data", () => {
    seedSyntheticPair(db, 1, "SPY", 30, 1.5);
    const result = computeSecurityRegression(db, 1, "SPY");
    expect(result).not.toBeNull();
    expect(result!.rSquared).toBeGreaterThan(0.99);
  });

  it("returns null when too few overlapping points (5 prices)", () => {
    seedSyntheticPair(db, 1, "SPY", 5, 1.5);
    const result = computeSecurityRegression(db, 1, "SPY");
    expect(result).toBeNull();
  });

  it("returns null when the benchmark has no rows", () => {
    // Seed only security prices; nothing for SPY.
    const insSec = db.prepare(
      `INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)`
    );
    for (let i = 0; i < 30; i++) {
      insSec.run(1, recentDate(29 - i), 100 * Math.exp(i * 0.01));
    }
    const result = computeSecurityRegression(db, 1, "SPY");
    expect(result).toBeNull();
  });

  it("cache round-trip — upsertRegression then getCachedRegression returns the same values", () => {
    const seeded = {
      beta: 1.234,
      vol: 0.2456,
      correlation: 0.8765,
      rSquared: 0.7682,
      dataPoints: 42,
    };
    upsertRegression(db, {
      securityId: 1,
      benchmarkSymbol: "SPY",
      result: seeded,
    });
    const got = getCachedRegression(db, 1, "SPY");
    expect(got).not.toBeNull();
    expect(got!.beta).toBeCloseTo(seeded.beta, 6);
    expect(got!.vol).toBeCloseTo(seeded.vol, 6);
    expect(got!.correlation).toBeCloseTo(seeded.correlation, 6);
    expect(got!.rSquared).toBeCloseTo(seeded.rSquared, 6);
    expect(got!.dataPoints).toBe(seeded.dataPoints);
    expect(got!.computedAtDay).toBe(new Date().toISOString().slice(0, 10));
  });

  it("cache picks the most-recent row when multiple days exist", () => {
    // Older day — pinned via the test seam 4th arg of upsertRegression.
    upsertRegression(
      db,
      {
        securityId: 1,
        benchmarkSymbol: "SPY",
        result: {
          beta: 0.5,
          vol: 0.1,
          correlation: 0.5,
          rSquared: 0.25,
          dataPoints: 100,
        },
      },
      "2026-01-01"
    );
    // Newer day — also pinned.
    upsertRegression(
      db,
      {
        securityId: 1,
        benchmarkSymbol: "SPY",
        result: {
          beta: 1.7,
          vol: 0.3,
          correlation: 0.9,
          rSquared: 0.81,
          dataPoints: 200,
        },
      },
      "2026-05-01"
    );
    const got = getCachedRegression(db, 1, "SPY");
    expect(got).not.toBeNull();
    expect(got!.computedAtDay).toBe("2026-05-01");
    expect(got!.beta).toBeCloseTo(1.7, 6);
    expect(got!.dataPoints).toBe(200);
  });
});

/**
 * qa: security-detail-factor-profile--regression-card-publishes-betas-failing-confidence-gate
 *
 * `computeSecurityRegression` keeps its raw statistics (the backfill and the
 * cache want them), so the PUBLISH decision is a separate read-time verdict:
 * the same gate `scripts/refresh-vanguard-betas.ts` applies to `security_betas`,
 * mapped onto the regression's own field names (dataPoints = aligned pairs).
 */
describe("regressionBetaVerdict", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    db.prepare(`INSERT INTO securities (id, symbol) VALUES (1, 'AAPL')`).run();
  });

  it("withholds the beta when the market explains too little of the variance", () => {
    expect(
      regressionBetaVerdict({ rSquared: 0.05, dataPoints: 250 })
    ).toEqual({ ok: false, reason: "low_r2" });
  });

  it("withholds the beta when there are too few return pairs", () => {
    expect(regressionBetaVerdict({ rSquared: 0.9, dataPoints: 13 })).toEqual({
      ok: false,
      reason: "few_pairs",
    });
  });

  it("reports few_pairs first when BOTH gates fail (sample size is the deeper defect)", () => {
    expect(regressionBetaVerdict({ rSquared: 0.05, dataPoints: 13 })).toEqual({
      ok: false,
      reason: "few_pairs",
    });
  });

  it("publishes the beta when both gates clear", () => {
    expect(regressionBetaVerdict({ rSquared: 0.72, dataPoints: 220 })).toEqual({
      ok: true,
    });
  });

  it("treats both thresholds as inclusive boundaries", () => {
    expect(
      regressionBetaVerdict({
        rSquared: MIN_BETA_R_SQUARED,
        dataPoints: MIN_BETA_PAIRS,
      })
    ).toEqual({ ok: true });
    expect(
      regressionBetaVerdict({
        rSquared: MIN_BETA_R_SQUARED - 1e-9,
        dataPoints: 250,
      })
    ).toEqual({ ok: false, reason: "low_r2" });
    expect(
      regressionBetaVerdict({
        rSquared: 0.9,
        dataPoints: MIN_BETA_PAIRS - 1,
      })
    ).toEqual({ ok: false, reason: "few_pairs" });
  });

  it("agrees with the compute output it is meant to gate (perfectly correlated 30d series)", () => {
    // 30 seeded prices -> 29 aligned return pairs: r² clears, pairs do not.
    seedSyntheticPair(db, 1, "SPY", 30, 1.5);
    const result = computeSecurityRegression(db, 1, "SPY")!;
    expect(result.rSquared).toBeGreaterThan(MIN_BETA_R_SQUARED);
    expect(result.dataPoints).toBeLessThan(MIN_BETA_PAIRS);
    expect(regressionBetaVerdict(result)).toEqual({
      ok: false,
      reason: "few_pairs",
    });
  });
});
