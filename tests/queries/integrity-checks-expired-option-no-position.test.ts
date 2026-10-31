/**
 * An expired option's open lot reads "expired — awaiting its closing entry"
 * on Data Health even when the pair never had a holdings row. Before, only
 * the live-zero-row path said so; the no-position path said "open tax lots
 * with no matching position". Synthetic fixtures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { runIntegrityChecks } from "@/lib/queries/integrity-checks";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { createPendingTestDb, seedSec, seedFill } from "../setup/pending-statement-fixtures";

let db: Database.Database;
let expired: number;
let live: number;

beforeEach(() => {
  db = createPendingTestDb();
  expired = seedSec(db, "AAA   250117C00100000", "Option");
  db.prepare("UPDATE securities SET expiration_date = ? WHERE id = ?").run("2025-01-17", expired);
  seedFill(db, 1, expired, "2024-12-02", "BUY_TO_OPEN", 1, 5);
  live = seedSec(db, "BBB   991219C00100000", "Option");
  db.prepare("UPDATE securities SET expiration_date = ? WHERE id = ?").run("2099-12-19", live);
  seedFill(db, 1, live, "2024-12-02", "BUY_TO_OPEN", 1, 5);
  computeTaxLots(db);
});

describe("expired option with no holdings row", () => {
  it("reads expired, awaiting its closing entry, as a warning", () => {
    const { warnings, critical } = runIntegrityChecks(db);
    expect(critical.find((c) => c.key === `lot-drift:1:${expired}`)).toBeUndefined();
    const hit = warnings.find((w) => w.key === `lot-drift:1:${expired}`);
    expect(hit?.severity).toBe("warning");
    expect(hit?.reason).toBe("AAA   250117C00100000 (Vanguard Taxable): expired — awaiting its closing entry");
  });

  it("a live option with the same shape keeps the no-matching-position wording", () => {
    const { warnings } = runIntegrityChecks(db);
    const hit = warnings.find((w) => w.key === `lot-drift:1:${live}`);
    expect(hit?.reason).toBe("BBB   991219C00100000 (Vanguard Taxable): open tax lots with no matching position");
  });
});
