/**
 * Fail-closed engine revision in the tax-lots convention stamp (spec
 * 2026-10-02 statement-only synthetic closes §2.5).
 *
 * The stored ledger written by the old synthetic-close gate can carry
 * live-only synthetic closes while `tax_input_generation` still matches its
 * stamp. The stamp therefore carries an engine revision; a stamp from an
 * earlier revision of the v3 convention reads stale until a recompute. Broker
 * acceptance is NOT wiped by a revision change inside the v3 family (only a
 * pre-v3 stamp resets it), so an accepted year comes back as soon as the
 * recompute lands at the same generation.
 *
 * Synthetic generation counters only.
 */

import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import {
  TAX_LOTS_CONVENTION_STAMP_PREFIX,
  bumpTaxInputGeneration,
  stampTaxLotsConvention,
  stampBrokerAcceptance,
  getTaxConventionState,
  describeTaxLotStaleness,
  isYearAccepted,
} from "@/lib/compute/tax-convention";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
});

function setStamp(value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('tax_lots_convention', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(value);
}
function readStamp(): string | undefined {
  return (
    db.prepare("SELECT value FROM settings WHERE key = 'tax_lots_convention'").get() as
      | { value: string }
      | undefined
  )?.value;
}

describe("engine revision in the convention stamp", () => {
  it("stamps the current engine revision, not the bare v3 shape", () => {
    expect(TAX_LOTS_CONVENTION_STAMP_PREFIX).toBe("v3r2");
    bumpTaxInputGeneration(db);
    stampTaxLotsConvention(db);
    expect(readStamp()).toBe("v3r2:1");
    expect(getTaxConventionState(db).recomputeCurrent).toBe(true);
    expect(getTaxConventionState(db).stampedConvention).toBe("v3");
  });

  it("an earlier-revision v3 stamp at the CURRENT generation reads stale", () => {
    bumpTaxInputGeneration(db);
    bumpTaxInputGeneration(db);
    setStamp("v3:2");
    const state = getTaxConventionState(db);
    expect(state.recomputeCurrent).toBe(false);
    expect(state.stampedGeneration).toBe(2);
    expect(state.stampedConvention).toBe("v3-revision");
    // Its own reason (not "legacy"): the Tax Lots notice names the
    // statement-only change rather than "an earlier lot convention".
    expect(describeTaxLotStaleness(state)).toEqual({
      stale: true,
      inputChangesSince: null,
      reason: "revision",
    });
  });

  it("broker acceptance survives the revision change: unavailable while stale, back after the recompute", () => {
    bumpTaxInputGeneration(db);
    setStamp("v3:1"); // written by the previous engine revision
    stampBrokerAcceptance(db, [{ accountId: 1, taxYear: 2026 }]);

    const stale = getTaxConventionState(db);
    expect(stale.acceptance.current).toBe(false); // fail closed while stale
    expect(stale.acceptance.coverage).toEqual([{ accountId: 1, taxYear: 2026 }]); // record kept
    expect(isYearAccepted(stale, 2026, [1])).toBe(false);

    stampTaxLotsConvention(db); // the post-deploy recompute

    const fresh = getTaxConventionState(db);
    expect(fresh.recomputeCurrent).toBe(true);
    expect(fresh.acceptance.current).toBe(true);
    expect(isYearAccepted(fresh, 2026, [1])).toBe(true);
  });

  it("a pre-v3 stamp still resets acceptance on recompute (unchanged rule)", () => {
    setStamp("v2:0");
    stampBrokerAcceptance(db, [{ accountId: 1, taxYear: 2026 }]);
    stampTaxLotsConvention(db);
    const state = getTaxConventionState(db);
    expect(state.recomputeCurrent).toBe(true);
    expect(state.acceptance.current).toBe(false);
    expect(state.acceptance.coverage).toEqual([]);
  });

  it("an unrecognized stamp resets acceptance on recompute (fail closed)", () => {
    setStamp("v3x:0");
    stampBrokerAcceptance(db, [{ accountId: 1, taxYear: 2026 }]);
    stampTaxLotsConvention(db);
    expect(getTaxConventionState(db).acceptance.current).toBe(false);
  });

  it("a current-revision stamp behind the generation reads 'behind', as before", () => {
    stampTaxLotsConvention(db);
    bumpTaxInputGeneration(db);
    expect(describeTaxLotStaleness(getTaxConventionState(db))).toEqual({
      stale: true,
      inputChangesSince: 1,
      reason: "behind",
    });
  });
});
