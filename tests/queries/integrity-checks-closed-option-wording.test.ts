/**
 * A pair whose newest live row is a quantity-0 reconciler tombstone while its
 * lots stay open is "closed per live data — awaiting statement" whatever the
 * security type. Options sit outside the stock/ETF pending-statement read
 * model, so they used to fall through to "live position differs from tax
 * lots", which tells the user a closed contract is still held. The statement
 * agrees with the lots in both cases; only the wording differed.
 * Synthetic fixtures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { runIntegrityChecks } from "@/lib/queries/integrity-checks";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { createPendingTestDb, seedSec, seedHold, seedFill } from "../setup/pending-statement-fixtures";

let db: Database.Database;
let opt: number;
let stk: number;
let drifted: number;

beforeEach(() => {
  db = createPendingTestDb();
  // Option: statement shows 1 contract, lots hold 1, live tombstone says 0.
  opt = seedSec(db, "AAA   261120C00405000", "Option");
  seedHold(db, 1, opt, "2026-09-30", "stmt", 1);
  seedHold(db, 1, opt, "2026-10-14", "live-zero");
  seedFill(db, 1, opt, "2026-06-01", "BUY_TO_OPEN", 1, 5);
  // Stock with the same shape, the control already worded as closed.
  stk = seedSec(db, "BBB", "Stock");
  seedHold(db, 1, stk, "2026-09-30", "stmt", 10);
  seedHold(db, 1, stk, "2026-10-14", "live-zero");
  seedFill(db, 1, stk, "2026-06-01", "BUY", 10, 100);
  // A live row that is non-zero but differs keeps the "differs" wording.
  drifted = seedSec(db, "CCC", "Stock");
  seedHold(db, 1, drifted, "2026-09-30", "stmt", 10);
  seedHold(db, 1, drifted, "2026-10-14", "tws", 7);
  seedFill(db, 1, drifted, "2026-06-01", "BUY", 10, 100);
  computeTaxLots(db); // mints the lots and stamps the convention so the drift scan runs
});

describe("closed-per-live wording for every security type", () => {
  it("an option tombstoned in live data reads closed per live data, like the stock", () => {
    const { warnings, critical } = runIntegrityChecks(db);
    expect(critical).toEqual([]);
    const optHit = warnings.find((w) => w.key === `lot-drift:1:${opt}`);
    const stkHit = warnings.find((w) => w.key === `lot-drift:1:${stk}`);
    expect(stkHit?.reason).toBe("BBB (Vanguard Taxable): closed per live data — awaiting statement");
    expect(optHit).toEqual({
      key: `lot-drift:1:${opt}`,
      severity: "warning",
      kind: "statement-lag",
      reason: "AAA   261120C00405000 (Vanguard Taxable): closed per live data — awaiting statement",
    });
  });

  it("a live row that still holds a different quantity keeps the differs wording", () => {
    const { warnings } = runIntegrityChecks(db);
    const hit = warnings.find((w) => w.key === `lot-drift:1:${drifted}`);
    expect(hit?.reason).toBe("CCC (Vanguard Taxable): live position differs from tax lots — pending statement");
  });
});
