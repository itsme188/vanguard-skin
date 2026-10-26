/**
 * The security page's "no current position" note carries the pending reason
 * per account (plan docs/superpowers/plans/
 * 2026-10-26-pending-lots-options-shorts-plan.md Task 10). Synthetic symbols
 * and round numbers only.
 */
import { describe, it, expect } from "vitest";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { computeLotsWithoutPosition, getSecurityDetail } from "@/lib/queries/security-detail";
import type { PendingReason } from "@/lib/queries/pending-statement-types";
import { createPendingTestDb, seedFill, seedHold, seedPx, seedSec } from "../setup/pending-statement-fixtures";

const lot = (over: {
  account_id?: number;
  is_short?: number;
  pending_statement?: boolean;
  pending_statement_reason?: PendingReason | null;
  quantity_remaining?: number;
}) => ({
  account_id: 3,
  account_name: "Acct Three",
  quantity_remaining: 10,
  is_short: 0,
  pending_statement: false,
  ...over,
});

describe("computeLotsWithoutPosition: pendingReason", () => {
  it("reason per account, \"mixed\" when two reasons differ", () => {
    const out = computeLotsWithoutPosition(
      [],
      [
        // Account 1: one reason on every lot.
        lot({ account_id: 1, pending_statement: true, pending_statement_reason: "closing_entry_missing", is_short: 1 }),
        lot({ account_id: 1, pending_statement: true, pending_statement_reason: "closing_entry_missing", is_short: 1 }),
        // Account 2: two different reasons.
        lot({ account_id: 2, pending_statement: true, pending_statement_reason: "awaiting_statement" }),
        lot({ account_id: 2, pending_statement: true, pending_statement_reason: "resymbol_repair_pending" }),
        // Account 3: one lot not pending, so no reason for the account.
        lot({ pending_statement: true, pending_statement_reason: "awaiting_statement" }),
        lot({ pending_statement: false }),
      ]
    );
    const by = new Map(out.map((o) => [o.accountId, o]));
    expect(by.get(1)).toMatchObject({ allPendingStatement: true, pendingReason: "closing_entry_missing", shortLotCount: 2 });
    expect(by.get(2)).toMatchObject({ allPendingStatement: true, pendingReason: "mixed" });
    expect(by.get(3)).toMatchObject({ allPendingStatement: false, pendingReason: null });
  });

  it("a reason on a non-pending lot is ignored", () => {
    const out = computeLotsWithoutPosition([], [lot({ pending_statement: false, pending_statement_reason: "closing_entry_missing" })]);
    expect(out[0]).toMatchObject({ allPendingStatement: false, pendingReason: null });
  });

  it("a caller that passes no reason still compiles and reads null", () => {
    const out = computeLotsWithoutPosition(
      [],
      [{ account_id: 3, account_name: "Acct Three", quantity_remaining: 5, is_short: 0, pending_statement: true }]
    );
    expect(out[0]).toMatchObject({ allPendingStatement: true, pendingReason: null });
  });
});

describe("getSecurityDetail: the reason reaches the page", () => {
  it("a short stock under a statement zero reads closing_entry_missing; a long under a live zero reads awaiting_statement", () => {
    const db = createPendingTestDb();
    const shortSec = seedSec(db, "ZZPRS");
    seedFill(db, 3, shortSec, "2026-06-01", "SHORT_SELL", 10, 50);
    seedHold(db, 3, shortSec, "2026-06-30", "stmt-zero");
    seedPx(db, shortSec, "2026-10-20", 40);

    const longSec = seedSec(db, "ZZPRL");
    seedFill(db, 3, longSec, "2026-05-01", "BUY", 5, 100);
    seedHold(db, 3, longSec, "2026-07-10", "live-zero");
    seedPx(db, longSec, "2026-07-10", 150);
    computeTaxLots(db);

    const s = getSecurityDetail(db, shortSec)!;
    expect(s.positions).toEqual([]);
    expect(s.openTaxLots).toHaveLength(1);
    expect(s.openTaxLots[0]).toMatchObject({ pending_statement: true, pending_statement_reason: "closing_entry_missing" });
    expect(s.lotsWithoutPosition).toEqual([
      expect.objectContaining({ accountId: 3, shortLotCount: 1, allPendingStatement: true, pendingReason: "closing_entry_missing" }),
    ]);

    const l = getSecurityDetail(db, longSec)!;
    expect(l.lotsWithoutPosition).toEqual([
      expect.objectContaining({ accountId: 3, allPendingStatement: true, pendingReason: "awaiting_statement" }),
    ]);
  });
});
