import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getCachedBeta,
  getCachedBetasForSymbols,
} from "@/lib/queries/security-betas";

function seedSecurity(db: Database.Database, symbol: string): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name) VALUES (?, ?)")
    .run(symbol, symbol + " Corp");
  return result.lastInsertRowid as number;
}

function seedBeta(
  db: Database.Database,
  securityId: number,
  lookbackDays: number,
  beta: number,
  computedAt: string
): void {
  db.prepare(
    `INSERT INTO security_betas (security_id, lookback_days, beta, computed_at)
     VALUES (?, ?, ?, ?)`
  ).run(securityId, lookbackDays, beta, computedAt);
}

describe("security-betas queries", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  describe("getCachedBeta", () => {
    it("returns the beta value when row exists for the given securityId and lookbackDays", () => {
      const secId = seedSecurity(db, "VTI");
      seedBeta(db, secId, 60, 1.05, "2026-05-08T10:00:00Z");

      const beta = getCachedBeta(db, secId, 60);
      expect(beta).toBe(1.05);
    });

    it("returns null when no row exists for the given securityId", () => {
      const secId = seedSecurity(db, "VTI");
      // Don't seed a beta row

      const beta = getCachedBeta(db, secId, 60);
      expect(beta).toBeNull();
    });

    it("returns null when row exists for the security but a different lookback_days value", () => {
      const secId = seedSecurity(db, "VTI");
      seedBeta(db, secId, 60, 1.05, "2026-05-08T10:00:00Z");

      // Query with different lookback_days
      const beta = getCachedBeta(db, secId, 252);
      expect(beta).toBeNull();
    });

    it("defaults lookbackDays to 60 when not specified", () => {
      const secId = seedSecurity(db, "VTI");
      seedBeta(db, secId, 60, 1.05, "2026-05-08T10:00:00Z");

      const beta = getCachedBeta(db, secId); // omit lookbackDays
      expect(beta).toBe(1.05);
    });
  });

  describe("getCachedBetasForSymbols", () => {
    it("returns empty array when given empty input", () => {
      const betas = getCachedBetasForSymbols(db, []);
      expect(betas).toEqual([]);
    });

    it("joins to securities and returns the requested shape", () => {
      const vti = seedSecurity(db, "VTI");
      const spy = seedSecurity(db, "SPY");
      seedBeta(db, vti, 60, 1.05, "2026-05-08T10:00:00Z");
      seedBeta(db, spy, 60, 0.99, "2026-05-08T10:00:00Z");

      const betas = getCachedBetasForSymbols(db, ["VTI", "SPY"], 60);
      expect(betas).toHaveLength(2);

      const vtiRow = betas.find((b) => b.symbol === "VTI");
      expect(vtiRow).toBeTruthy();
      expect(vtiRow!.beta).toBe(1.05);
      expect(vtiRow!.lookbackDays).toBe(60);
      expect(vtiRow!.computedAt).toBe("2026-05-08T10:00:00Z");
      expect(vtiRow!.securityId).toBe(vti);

      const spyRow = betas.find((b) => b.symbol === "SPY");
      expect(spyRow).toBeTruthy();
      expect(spyRow!.beta).toBe(0.99);
    });

    it("filters by lookback_days parameter", () => {
      const vti = seedSecurity(db, "VTI");
      seedBeta(db, vti, 60, 1.05, "2026-05-08T10:00:00Z");
      seedBeta(db, vti, 252, 1.10, "2026-05-08T10:00:00Z");

      const betas60 = getCachedBetasForSymbols(db, ["VTI"], 60);
      expect(betas60).toHaveLength(1);
      expect(betas60[0].beta).toBe(1.05);

      const betas252 = getCachedBetasForSymbols(db, ["VTI"], 252);
      expect(betas252).toHaveLength(1);
      expect(betas252[0].beta).toBe(1.10);
    });

    it("returns only symbols that exist with betas for the given lookback_days", () => {
      const vti = seedSecurity(db, "VTI");
      const spy = seedSecurity(db, "SPY");
      const qqq = seedSecurity(db, "QQQ");
      seedBeta(db, vti, 60, 1.05, "2026-05-08T10:00:00Z");
      seedBeta(db, spy, 60, 0.99, "2026-05-08T10:00:00Z");
      // QQQ has no beta for 60-day lookback

      const betas = getCachedBetasForSymbols(db, ["VTI", "SPY", "QQQ"], 60);
      expect(betas).toHaveLength(2);
      const symbols = betas.map((b) => b.symbol);
      expect(symbols).toContain("VTI");
      expect(symbols).toContain("SPY");
      expect(symbols).not.toContain("QQQ");
    });

    it("defaults lookbackDays to 60 when not specified", () => {
      const vti = seedSecurity(db, "VTI");
      seedBeta(db, vti, 60, 1.05, "2026-05-08T10:00:00Z");

      const betas = getCachedBetasForSymbols(db, ["VTI"]); // omit lookbackDays
      expect(betas).toHaveLength(1);
      expect(betas[0].beta).toBe(1.05);
    });
  });
});
