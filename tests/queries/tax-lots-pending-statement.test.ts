/**
 * Tax Lots read surfaces vs the pending-statement read model (spec
 * docs/superpowers/specs/2026-10-02-statement-only-synthetic-closes-design.md
 * §2.2, §3 item 6): pending lots carry `pending_statement`, unrealized totals
 * exclude them, a separate disclosed line counts them, and realized totals
 * are unchanged. Synthetic fixtures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import {
  getOpenTaxLots,
  getTaxLotSummary,
  getTaxLotSummaryByAccount,
} from "@/lib/queries/tax-lots";
import { getOpenTaxLotsBySecurity } from "@/lib/queries/security-detail";
import {
  createPendingTestDb,
  seedSec,
  seedFill,
  seedHold,
  seedPx,
} from "../setup/pending-statement-fixtures";

let db: Database.Database;
let held: number;
let pending: number;
let pending2: number;

beforeEach(() => {
  db = createPendingTestDb();
  // HELD: still held per the statement; +200 paper gain.
  held = seedSec(db, "HELDX");
  seedFill(db, 3, held, "2026-05-01", "BUY", 10, 100);
  seedHold(db, 3, held, "2026-07-10", "stmt", 10);
  seedPx(db, held, "2026-07-10", 120);

  // PENDING: two lots, flat only in live data; +500 paper gain that must NOT
  // count as unrealized.
  pending = seedSec(db, "PENDX");
  seedFill(db, 3, pending, "2026-05-01", "BUY", 5, 100);
  seedFill(db, 3, pending, "2026-05-02", "BUY", 5, 100);
  seedHold(db, 3, pending, "2026-07-10", "live-zero");
  seedPx(db, pending, "2026-07-10", 150);

  // A second pending pair in another account (one lot).
  pending2 = seedSec(db, "PENDY");
  seedFill(db, 1, pending2, "2026-05-01", "BUY", 2, 50);
  seedHold(db, 1, pending2, "2026-07-11", "plaid", 0);
  seedPx(db, pending2, "2026-07-11", 40);

  // A real realized sale, to pin "realized unchanged".
  const sold = seedSec(db, "SOLDX");
  seedFill(db, 3, sold, "2026-05-01", "BUY", 4, 10);
  seedFill(db, 3, sold, "2026-06-01", "SELL", 4, 15);

  computeTaxLots(db);
});

describe("getOpenTaxLots", () => {
  it("flags every lot of a pending pair and no other lot", () => {
    const lots = getOpenTaxLots(db);
    const flagged = lots.filter((l) => l.pending_statement).map((l) => l.symbol).sort();
    expect(flagged).toEqual(["PENDX", "PENDX", "PENDY"]);
    expect(lots.find((l) => l.symbol === "HELDX")!.pending_statement).toBe(false);
  });

  it("a pending lot carries no market value or unrealized gain (the position is not held)", () => {
    const lot = getOpenTaxLots(db).find((l) => l.symbol === "PENDX")!;
    expect(lot.current_value).toBeNull();
    expect(lot.unrealized_gain).toBeNull();
    // Basis and quantity stay — the lots are still open in the ledger.
    expect(lot.quantity_remaining).toBe(5);
    expect(lot.adjusted_cost_basis).toBeCloseTo(500, 6);
  });

  it("the security-detail read (same helper) carries the flag", () => {
    const lots = getOpenTaxLotsBySecurity(db, pending);
    expect(lots).toHaveLength(2);
    expect(lots.every((l) => l.pending_statement)).toBe(true);
    expect(getOpenTaxLotsBySecurity(db, held).every((l) => !l.pending_statement)).toBe(true);
  });
});

describe("getTaxLotSummary (spec §3 item 6)", () => {
  it("unrealized excludes pending lots", () => {
    const s = getTaxLotSummary(db);
    expect(s.totalUnrealizedGain).toBeCloseTo(200, 6); // HELDX only
  });

  it("reports the pending line: positions, lots and their basis", () => {
    const s = getTaxLotSummary(db);
    expect(s.pendingStatementPositions).toBe(2);
    expect(s.pendingStatementLots).toBe(3);
    expect(s.pendingStatementBasis).toBeCloseTo(1100, 6);
  });

  it("open-lot count still matches the Open Lots table (pending lots stay listed, with their chip)", () => {
    expect(getTaxLotSummary(db).totalOpenLots).toBe(getOpenTaxLots(db).length);
  });

  it("realized totals are unchanged: only the real sale, no synthetic close", () => {
    const s = getTaxLotSummary(db, 2026);
    expect(s.totalClosedSales).toBe(1);
    expect(s.totalRealizedGain).toBeCloseTo(20, 6);
    expect(s.engineEstimatedSales).toBe(0);
    const byAcct = getTaxLotSummaryByAccount(db, 2026);
    expect(byAcct.map((a) => a.totalRealizedGain)).toEqual([20]);
  });

  it("with no pending pairs the line reads zero and unrealized covers every lot", () => {
    db.prepare("DELETE FROM holdings WHERE quantity = 0").run();
    const s = getTaxLotSummary(db);
    expect(s.pendingStatementPositions).toBe(0);
    expect(s.pendingStatementLots).toBe(0);
    expect(s.totalUnrealizedGain).toBeCloseTo(200 + 500 - 20, 6);
  });
});
