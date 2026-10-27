/**
 * Data confidence vs the pending-statement read model (spec
 * docs/superpowers/specs/2026-10-02-statement-only-synthetic-closes-design.md
 * §2.2 "Data confidence"): the "open tax lots with no matching position"
 * warning for a pair flat only in live data carries `kind: "statement-lag"`,
 * stays a WARNING, and never caps the score. Synthetic fixtures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { runIntegrityChecks, type IntegrityHit } from "@/lib/queries/integrity-checks";
import { getDataConfidence } from "@/lib/queries/data-confidence";
import {
  createPendingTestDb,
  seedSec,
  seedFill,
  seedHold,
  seedLot,
} from "../setup/pending-statement-fixtures";

let db: Database.Database;
let pend: number;
let orphan: number;

beforeEach(() => {
  db = createPendingTestDb();
  pend = seedSec(db, "LAGX");
  seedFill(db, 3, pend, "2026-06-01", "BUY", 10, 100);
  seedHold(db, 3, pend, "2026-07-10", "live-zero");
  computeTaxLots(db); // stamps the convention: the lot-drift scan runs

  // An ordinary lots-without-position warning (no holdings row at all) —
  // must keep its old shape, with no kind.
  orphan = seedSec(db, "ORPX");
  seedLot(db, 1, orphan); // raw insert: no generation bump, the stamp stays current
});

describe("statement-lag integrity hits", () => {
  it("the pending pair's lots-without-position warning carries kind 'statement-lag' and domain wording", () => {
    const { warnings, critical, lotDriftChecked } = runIntegrityChecks(db);
    expect(lotDriftChecked).toBe(true);
    const hit = warnings.find((w) => w.key === `lot-drift:3:${pend}`);
    expect(hit).toEqual({
      key: `lot-drift:3:${pend}`,
      severity: "warning",
      kind: "statement-lag",
      reason: "LAGX (IBKR): closed per live data — awaiting statement",
    } satisfies IntegrityHit);
    expect(critical).toEqual([]);
  });

  it("an ordinary lots-without-position warning keeps its shape (no kind key at all)", () => {
    const { warnings } = runIntegrityChecks(db);
    const hit = warnings.find((w) => w.key === `lot-drift:1:${orphan}`)!;
    expect(hit).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(hit, "kind")).toBe(false);
    expect(hit.reason).toBe("ORPX (Vanguard Taxable): open tax lots with no matching position");
  });

  it("a statement-lag hit never caps the confidence score", () => {
    const conf = getDataConfidence(db);
    expect(conf.integrity.warnings.some((w) => w.kind === "statement-lag")).toBe(true);
    expect(conf.integrity.critical).toEqual([]);
    expect(conf.capReason).toBeNull();
  });
});

describe("statement-lag under the side-aware pending model (2026-10-26, Task 8)", () => {
  it("an awaiting-statement pair is ONE warning and carries no pendingReasons (today's shape)", () => {
    const { warnings } = runIntegrityChecks(db);
    const forPair = warnings.filter((w) => w.key.startsWith(`lot-drift:3:${pend}`));
    expect(forPair).toHaveLength(1);
    expect(Object.prototype.hasOwnProperty.call(forPair[0], "pendingReasons")).toBe(false);
  });

  it("a long lot under a live SHORT row (PR #123) is one statement-lag warning, never critical", () => {
    const flip = seedSec(db, "FLPX");
    seedFill(db, 3, flip, "2026-06-01", "BUY", 10, 100);
    seedHold(db, 3, flip, "2026-06-30", "stmt", 10);
    seedHold(db, 3, flip, "2026-07-10", "tws", -5);
    computeTaxLots(db);
    const { warnings, critical } = runIntegrityChecks(db);
    expect(critical.filter((h) => h.key.startsWith(`lot-drift:3:${flip}`))).toEqual([]);
    expect(warnings.filter((w) => w.key.startsWith(`lot-drift:3:${flip}`))).toEqual([
      {
        key: `lot-drift:3:${flip}`,
        severity: "warning",
        kind: "statement-lag",
        reason: "FLPX (IBKR): closed per live data — awaiting statement",
      } satisfies IntegrityHit,
    ]);
  });
});
