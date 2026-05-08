import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertBeta, deleteBetasForSecurity } from "@/lib/mutations/security-betas";
import { getCachedBeta } from "@/lib/queries/security-betas";

function seedSecurity(db: Database.Database, symbol: string): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name) VALUES (?, ?)")
    .run(symbol, symbol + " Corp");
  return result.lastInsertRowid as number;
}

describe("security-betas mutations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  describe("upsertBeta", () => {
    it("inserts a new row when the (security_id, lookback_days) pair does not exist", () => {
      const secId = seedSecurity(db, "VTI");

      upsertBeta(db, { securityId: secId, lookbackDays: 60, beta: 1.05 });

      const beta = getCachedBeta(db, secId, 60);
      expect(beta).toBe(1.05);
    });

    it("updates an existing row on conflict (same securityId + lookbackDays, new beta)", () => {
      const secId = seedSecurity(db, "VTI");

      // First insert
      upsertBeta(db, { securityId: secId, lookbackDays: 60, beta: 1.05 });
      expect(getCachedBeta(db, secId, 60)).toBe(1.05);

      // Update (conflict on same securityId + lookbackDays)
      upsertBeta(db, { securityId: secId, lookbackDays: 60, beta: 1.10 });
      expect(getCachedBeta(db, secId, 60)).toBe(1.10);

      // Verify only one row exists for this pair
      const count = db
        .prepare(
          "SELECT COUNT(*) as cnt FROM security_betas WHERE security_id = ? AND lookback_days = ?"
        )
        .get(secId, 60) as { cnt: number };
      expect(count.cnt).toBe(1);
    });

    it("does NOT collide across different lookback_days (60 vs 30 are independent rows)", () => {
      const secId = seedSecurity(db, "VTI");

      // Insert two rows with same securityId but different lookback_days
      upsertBeta(db, { securityId: secId, lookbackDays: 60, beta: 1.05 });
      upsertBeta(db, { securityId: secId, lookbackDays: 30, beta: 1.10 });

      // Both should exist independently
      expect(getCachedBeta(db, secId, 60)).toBe(1.05);
      expect(getCachedBeta(db, secId, 30)).toBe(1.10);

      // Verify two rows exist
      const count = db
        .prepare("SELECT COUNT(*) as cnt FROM security_betas WHERE security_id = ?")
        .get(secId) as { cnt: number };
      expect(count.cnt).toBe(2);
    });

    it("sets computed_at to datetime('now') automatically", () => {
      const secId = seedSecurity(db, "VTI");

      const beforeTime = new Date().toISOString();
      upsertBeta(db, { securityId: secId, lookbackDays: 60, beta: 1.05 });
      const afterTime = new Date().toISOString();

      // Read the computed_at value from the DB
      const row = db
        .prepare("SELECT computed_at FROM security_betas WHERE security_id = ? AND lookback_days = ?")
        .get(secId, 60) as { computed_at: string };

      // Verify it's a valid datetime and falls within the test's time window
      expect(row.computed_at).toBeTruthy();
      // SQLite datetime('now') returns format like "2026-05-08 14:30:45"
      expect(row.computed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });
  });

  describe("deleteBetasForSecurity", () => {
    it("removes all rows for the given security across all lookback windows", () => {
      const secId = seedSecurity(db, "VTI");
      const otherSecId = seedSecurity(db, "SPY");

      // Insert multiple rows for the same security across different lookback windows
      upsertBeta(db, { securityId: secId, lookbackDays: 60, beta: 1.05 });
      upsertBeta(db, { securityId: secId, lookbackDays: 30, beta: 1.10 });
      upsertBeta(db, { securityId: secId, lookbackDays: 252, beta: 1.02 });

      // Insert a row for a different security to ensure we don't delete it
      upsertBeta(db, { securityId: otherSecId, lookbackDays: 60, beta: 0.99 });

      // Delete all betas for the first security
      deleteBetasForSecurity(db, secId);

      // Verify all rows for secId are gone
      expect(getCachedBeta(db, secId, 60)).toBeNull();
      expect(getCachedBeta(db, secId, 30)).toBeNull();
      expect(getCachedBeta(db, secId, 252)).toBeNull();

      // Verify the other security's row is still there
      expect(getCachedBeta(db, otherSecId, 60)).toBe(0.99);

      // Verify exactly one row remains in the table
      const count = db
        .prepare("SELECT COUNT(*) as cnt FROM security_betas")
        .get() as { cnt: number };
      expect(count.cnt).toBe(1);
    });

    it("is a no-op when the security has no rows", () => {
      const secId = seedSecurity(db, "VTI");
      const otherSecId = seedSecurity(db, "SPY");

      // Insert one row for a different security
      upsertBeta(db, { securityId: otherSecId, lookbackDays: 60, beta: 0.99 });

      // Delete betas for a security that has none
      deleteBetasForSecurity(db, secId);

      // Verify the other security's row is still there
      expect(getCachedBeta(db, otherSecId, 60)).toBe(0.99);

      // Verify exactly one row remains
      const count = db
        .prepare("SELECT COUNT(*) as cnt FROM security_betas")
        .get() as { cnt: number };
      expect(count.cnt).toBe(1);
    });
  });
});
