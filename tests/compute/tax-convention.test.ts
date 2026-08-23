import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import {
  bumpTaxInputGeneration, getTaxInputGeneration, stampTaxLotsConvention,
  stampBrokerAcceptance, getTaxConventionState, isYearAccepted,
} from "@/lib/compute/tax-convention";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
});

describe("tax input generation", () => {
  it("starts at 0 and increments monotonically", () => {
    expect(getTaxInputGeneration(db)).toBe(0);
    expect(bumpTaxInputGeneration(db)).toBe(1);
    expect(bumpTaxInputGeneration(db)).toBe(2);
    expect(getTaxInputGeneration(db)).toBe(2);
  });
});

describe("convention state", () => {
  it("is not current until stamped, current after, stale after a bump", () => {
    expect(getTaxConventionState(db).recomputeCurrent).toBe(false);
    stampTaxLotsConvention(db);
    expect(getTaxConventionState(db).recomputeCurrent).toBe(true);
    bumpTaxInputGeneration(db);
    expect(getTaxConventionState(db).recomputeCurrent).toBe(false);
  });

  it("treats an unrecognized marker value as not v2 (rollback safety)", () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('tax_lots_convention', 'garbage')").run();
    expect(getTaxConventionState(db).recomputeCurrent).toBe(false);
  });

  it("acceptance is per account + tax year and generation-bound", () => {
    stampTaxLotsConvention(db);
    stampBrokerAcceptance(db, [
      { accountId: 1, taxYear: 2025 }, { accountId: 1, taxYear: 2026 },
      { accountId: 2, taxYear: 2026 },
    ]);
    const state = getTaxConventionState(db);
    expect(state.acceptance.current).toBe(true);
    expect(isYearAccepted(state, 2026, [1, 2])).toBe(true);
    expect(isYearAccepted(state, 2025, [1, 2])).toBe(false); // account 2 lacks 2025
    bumpTaxInputGeneration(db);
    const stale = getTaxConventionState(db);
    expect(stale.acceptance.current).toBe(false);
    expect(isYearAccepted(stale, 2026, [1])).toBe(false);
  });
});
