import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  REGRESSION_ENGINE_SINCE,
  getCachedRegression,
  upsertRegression,
} from "@/lib/queries/security-regressions";

function result(vol: number) {
  return { beta: 1, vol, correlation: 0.5, rSquared: 0.25, dataPoints: 100 };
}

function dayBefore(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

describe("getCachedRegression engine floor", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE security_regressions (
        security_id INTEGER NOT NULL,
        benchmark_symbol TEXT NOT NULL,
        computed_at_day TEXT NOT NULL,
        beta REAL, vol REAL, correlation REAL, r_squared REAL, data_points INTEGER,
        PRIMARY KEY (security_id, benchmark_symbol, computed_at_day)
      );
    `);
  });

  const args = (vol: number) => ({
    securityId: 9001,
    benchmarkSymbol: "SPY",
    result: result(vol),
  });

  it("is a miss for a row computed before REGRESSION_ENGINE_SINCE", () => {
    upsertRegression(db, args(2.5), dayBefore(REGRESSION_ENGINE_SINCE));
    expect(getCachedRegression(db, 9001, "SPY")).toBeNull();
  });

  it("returns a row computed on REGRESSION_ENGINE_SINCE", () => {
    upsertRegression(db, args(0.3), REGRESSION_ENGINE_SINCE);
    expect(getCachedRegression(db, 9001, "SPY")?.vol).toBe(0.3);
  });

  it("returns only the newer-engine row when both exist", () => {
    upsertRegression(db, args(2.5), dayBefore(REGRESSION_ENGINE_SINCE));
    upsertRegression(db, args(0.3), REGRESSION_ENGINE_SINCE);
    const got = getCachedRegression(db, 9001, "SPY");
    expect(got?.vol).toBe(0.3);
    expect(got?.computedAtDay).toBe(REGRESSION_ENGINE_SINCE);
  });
});
