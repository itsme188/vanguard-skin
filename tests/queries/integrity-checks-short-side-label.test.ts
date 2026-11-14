/**
 * An integrity note about a SHORT position names the side inside the
 * parenthesis, "AAA (IBKR, short): ..."; a long one keeps today's wording.
 * Synthetic fixtures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { runIntegrityChecks } from "@/lib/queries/integrity-checks";
import { createPendingTestDb, seedSec, seedFill, seedHold, seedLot } from "../setup/pending-statement-fixtures";

let db: Database.Database;

beforeEach(() => {
  db = createPendingTestDb();
  // A harmless pair so the lot scan has a stamped convention to run under.
  const base = seedSec(db, "BASE");
  seedFill(db, 3, base, "2026-06-01", "BUY", 10, 100);
  seedHold(db, 3, base, "2026-07-10", "tws", 10);
  computeTaxLots(db);
});

function reasonsFor(securityId: number): string[] {
  const { warnings, critical } = runIntegrityChecks(db);
  return [...warnings, ...critical].filter((h) => h.key.startsWith(`lot-drift:3:${securityId}`)).map((h) => h.reason);
}

describe("integrity notes name a short side", () => {
  it("a negative live row with no lots is labelled short", () => {
    const sec = seedSec(db, "AAA");
    seedHold(db, 3, sec, "2026-07-10", "tws", -10);
    const reasons = reasonsFor(sec);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("AAA (IBKR, short):");
  });

  it("the same shape with a positive quantity keeps the plain wording", () => {
    const sec = seedSec(db, "ZZZ");
    seedHold(db, 3, sec, "2026-07-10", "tws", 10);
    const reasons = reasonsFor(sec);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("ZZZ (IBKR):");
    expect(reasons[0]).not.toContain("short");
  });

  it("a pending-index short entry is labelled short; a long one is not", () => {
    const shortSec = seedSec(db, "SHP");
    seedLot(db, 3, shortSec, { isShort: 1 });
    seedHold(db, 3, shortSec, "2026-07-10", "live-zero");
    const longSec = seedSec(db, "LGP");
    seedLot(db, 3, longSec);
    seedHold(db, 3, longSec, "2026-07-10", "live-zero");
    expect(reasonsFor(shortSec)).toEqual(["SHP (IBKR, short): closed per live data — awaiting statement"]);
    expect(reasonsFor(longSec)).toEqual(["LGP (IBKR): closed per live data — awaiting statement"]);
  });
});
