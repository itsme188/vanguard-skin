/**
 * QA finding: tax-lots--headline-tiles-stale-until-recompute-no-marker
 *
 * The Tax Lots page renders UNREALIZED / REALIZED / LONG-TERM / SHORT-TERM
 * from STORED tax_lots / tax_lot_sales rows. Those rows can lag the
 * transaction ledger (every material tax-input mutation bumps
 * `tax_input_generation`, but only a recompute re-stamps
 * `tax_lots_convention`), or predate the current engine convention entirely.
 * Nothing on the page said so.
 *
 * `getTaxConventionState` already knew whether a recompute was current; it
 * did not expose WHY it was not. These tests pin the two new read-only
 * fields (`stampedGeneration`, `stampedConvention`) and the pure
 * `describeTaxLotStaleness` helper the page's notice reads.
 *
 * Every figure here is synthetic — generation counters, no dollars.
 */

import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import {
  bumpTaxInputGeneration,
  stampTaxLotsConvention,
  stampBrokerAcceptance,
  getTaxConventionState,
  describeTaxLotStaleness,
} from "@/lib/compute/tax-convention";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
});

function setStamp(value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('tax_lots_convention', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(value);
}

describe("stamp introspection on TaxConventionState", () => {
  it("reports no stamp at all (lots never computed on this database)", () => {
    const state = getTaxConventionState(db);
    expect(state.stampedConvention).toBeNull();
    expect(state.stampedGeneration).toBeNull();
    expect(state.recomputeCurrent).toBe(false);
  });

  it("reports a legacy (pre-v3) stamp and the generation inside it", () => {
    bumpTaxInputGeneration(db); // 1
    bumpTaxInputGeneration(db); // 2
    bumpTaxInputGeneration(db); // 3
    setStamp("v2:1");
    const state = getTaxConventionState(db);
    expect(state.generation).toBe(3);
    expect(state.stampedConvention).toBe("legacy");
    expect(state.stampedGeneration).toBe(1);
    expect(state.recomputeCurrent).toBe(false);
  });

  it("treats an unparseable stamp as legacy with an unknown generation", () => {
    setStamp("garbage");
    const state = getTaxConventionState(db);
    expect(state.stampedConvention).toBe("legacy");
    expect(state.stampedGeneration).toBeNull();
    expect(state.recomputeCurrent).toBe(false);
  });

  it("reports a v3 stamp at the current generation, and again once it falls behind", () => {
    bumpTaxInputGeneration(db); // 1
    stampTaxLotsConvention(db);
    const fresh = getTaxConventionState(db);
    expect(fresh.stampedConvention).toBe("v3");
    expect(fresh.stampedGeneration).toBe(1);
    expect(fresh.recomputeCurrent).toBe(true);

    bumpTaxInputGeneration(db); // 2
    bumpTaxInputGeneration(db); // 3
    const behind = getTaxConventionState(db);
    expect(behind.generation).toBe(3);
    expect(behind.stampedConvention).toBe("v3");
    expect(behind.stampedGeneration).toBe(1); // the stamp itself never moves
    expect(behind.recomputeCurrent).toBe(false);
  });

  it("leaves the pre-existing fields untouched (non-breaking extension)", () => {
    stampTaxLotsConvention(db);
    stampBrokerAcceptance(db, [{ accountId: 1, taxYear: 2026 }]);
    const state = getTaxConventionState(db);
    expect(state.generation).toBe(0);
    expect(state.recomputeCurrent).toBe(true);
    expect(state.acceptance.current).toBe(true);
    expect(state.acceptance.coverage).toEqual([{ accountId: 1, taxYear: 2026 }]);
  });
});

describe("describeTaxLotStaleness", () => {
  it("is not stale when the stored lots were computed at the current generation", () => {
    bumpTaxInputGeneration(db);
    stampTaxLotsConvention(db);
    expect(describeTaxLotStaleness(getTaxConventionState(db))).toEqual({
      stale: false,
      inputChangesSince: null,
      reason: null,
    });
  });

  it("counts the ledger changes a v3 stamp is behind by", () => {
    stampTaxLotsConvention(db); // v3:0
    bumpTaxInputGeneration(db);
    bumpTaxInputGeneration(db);
    expect(describeTaxLotStaleness(getTaxConventionState(db))).toEqual({
      stale: true,
      inputChangesSince: 2,
      reason: "behind",
    });
  });

  it("calls out an earlier lot convention even when it is also behind", () => {
    bumpTaxInputGeneration(db);
    bumpTaxInputGeneration(db);
    setStamp("v2:0");
    // The superseded engine is the stronger warning: a v3 recompute changes
    // the figures whether or not the ledger also moved, so "legacy" wins.
    expect(describeTaxLotStaleness(getTaxConventionState(db))).toEqual({
      stale: true,
      inputChangesSince: 2,
      reason: "legacy",
    });
  });

  it("calls out an earlier lot convention that is otherwise up to date", () => {
    setStamp("v2:0");
    expect(describeTaxLotStaleness(getTaxConventionState(db))).toEqual({
      stale: true,
      inputChangesSince: null,
      reason: "legacy",
    });
  });

  it("reports a missing stamp as 'never', with no change count to quote", () => {
    bumpTaxInputGeneration(db);
    expect(describeTaxLotStaleness(getTaxConventionState(db))).toEqual({
      stale: true,
      inputChangesSince: null,
      reason: "never",
    });
  });

  it("never reports a negative change count (stamp ahead of the counter)", () => {
    // Unreachable in normal operation (the counter only rises and the stamp
    // records it), but a restored/edited settings row can produce it. Stale
    // with no quotable count, never a negative one.
    setStamp("v3:9");
    expect(describeTaxLotStaleness(getTaxConventionState(db))).toEqual({
      stale: true,
      inputChangesSince: null,
      reason: "behind",
    });
  });
});
