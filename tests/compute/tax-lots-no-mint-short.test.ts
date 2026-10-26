/**
 * T-NO-MINT (plan docs/superpowers/plans/2026-10-26-pending-lots-options-shorts-plan.md
 * Task 12; spec docs/superpowers/specs/2026-10-08-live-closed-options-shorts-pending-design.md
 * §7): the engine never mints a synthetic RECONCILE_CLOSE for an option or a
 * short, even when the pair's newest statement-grade row is zero and a price
 * exists on that date. Long stock is the positive control: the same evidence
 * DOES mint one, so the absence below is the rule, not a missing input.
 * Synthetic symbols and small round numbers only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getPendingStatementPairs } from "@/lib/queries/pending-statement";
import { insertPrice, insertSecurity, insertTxn } from "../setup/pending-options-shorts-seed";
import { createPendingTestDb, seedHold } from "../setup/pending-statement-fixtures";

let db: Database.Database;
beforeEach(() => {
  db = createPendingTestDb();
});

function reconcileCloses(sec: number): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'RECONCILE_CLOSE' AND security_id = ?").get(sec) as {
      n: number;
    }
  ).n;
}

function openQuantity(sec: number): number {
  return (
    db.prepare("SELECT COALESCE(SUM(quantity_remaining), 0) AS q FROM tax_lots WHERE security_id = ?").get(sec) as {
      q: number;
    }
  ).q;
}

/** Open on 06-01, statement zero on 06-30 with a price that day, no closing entry. */
function seedStatementFlat(symbol: string, type: "Stock" | "option", openType: string, qty: number, price: number): number {
  const sec = insertSecurity(db, symbol, { type });
  insertTxn(db, 3, sec, "2026-06-01", openType, qty, price);
  seedHold(db, 3, sec, "2026-06-30", "stmt-zero");
  insertPrice(db, sec, "2026-06-30", price + 1);
  return sec;
}

describe("T-NO-MINT", () => {
  it("a short stock pair with a statement zero gets no RECONCILE_CLOSE; its lot stays open and pending", () => {
    const sec = seedStatementFlat("ZZNM", "Stock", "SHORT_SELL", 10, 50);
    computeTaxLots(db);
    expect(reconcileCloses(sec)).toBe(0);
    expect(openQuantity(sec)).toBe(10);
    expect(getPendingStatementPairs(db, undefined, { today: "2026-10-26" }).map((p) => [p.side, p.reason])).toEqual([
      ["short", "closing_entry_missing"],
    ]);
  });

  it.each([
    ["long option", "BUY_TO_OPEN"],
    ["short option", "SELL_TO_OPEN"],
  ])("a %s with a statement zero gets no RECONCILE_CLOSE", (_name, openType) => {
    const sec = seedStatementFlat("ZZNO  270115C00010000", "option", openType, 2, 3);
    computeTaxLots(db);
    expect(reconcileCloses(sec)).toBe(0);
    expect(openQuantity(sec)).toBe(2);
  });

  it("positive control: a long stock pair with the same evidence DOES get one (the statement-only close)", () => {
    const sec = seedStatementFlat("ZZNL", "Stock", "BUY", 10, 50);
    computeTaxLots(db);
    expect(reconcileCloses(sec)).toBe(1);
    expect(openQuantity(sec)).toBe(0);
  });

  it("a second recompute still mints nothing for the short (idempotent)", () => {
    const sec = seedStatementFlat("ZZNM", "Stock", "SHORT_SELL", 10, 50);
    computeTaxLots(db);
    computeTaxLots(db);
    expect(reconcileCloses(sec)).toBe(0);
    expect(openQuantity(sec)).toBe(10);
  });
});
