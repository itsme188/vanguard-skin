/**
 * The position-vs-lots check when the LEDGER is newer than the statement.
 *
 * A trade imported after the newest statement moves the tax lots past the
 * statement, so the two cannot be compared as they stand. The check rolls the
 * lots BACK to the statement date (today's open-lot quantity minus what the
 * later ledger rows moved, a later split undone by its ratio) and compares
 * that with the statement. A later trade therefore never hides a disagreement
 * that already existed on the statement date.
 *
 * Every lot here is minted by the real `computeTaxLots` from seeded ledger
 * rows. Synthetic tickers and round quantities only. Accounts are the
 * migration seed: 1 = Vanguard Taxable, 3 = IBKR.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { runIntegrityChecks, type IntegrityHit } from "@/lib/queries/integrity-checks";
import { getDataConfidence } from "@/lib/queries/data-confidence";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { stampTaxLotsConvention } from "@/lib/compute/tax-convention";
import {
  createPendingTestDb,
  seedSec,
  seedFill,
  seedHold,
  seedImportSplit,
} from "../setup/pending-statement-fixtures";

const BEFORE = "2026-06-01";
const STMT = "2026-08-31";
const EARLY_LIVE = "2026-09-02";
const TRADE = "2026-09-05";
const TRADE2 = "2026-09-08";
const LIVE = "2026-09-15";

let db: Database.Database;

/** Rebuild the lots from the ledger with the real engine, then arm the check. */
function buildLots(): void {
  computeTaxLots(db);
  stampTaxLotsConvention(db);
}

function signedLots(accountId: number, securityId: number): number {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN is_short = 1 THEN -quantity_remaining ELSE quantity_remaining END), 0) AS q
           FROM tax_lots WHERE account_id = ? AND security_id = ? AND quantity_remaining > 0`
      )
      .get(accountId, securityId) as { q: number }
  ).q;
}

function driftHits(): { critical: IntegrityHit[]; warnings: IntegrityHit[] } {
  const r = runIntegrityChecks(db);
  expect(r.lotDriftChecked).toBe(true);
  return {
    critical: r.critical.filter((h) => h.key.startsWith("lot-drift:")),
    warnings: r.warnings.filter((h) => h.key.startsWith("lot-drift:")),
  };
}

beforeEach(() => {
  db = createPendingTestDb();
});

describe("a later trade does not hide a disagreement that was there on the statement date", () => {
  it("a buy imported five times before the statement stays critical after a later round trip, with a live row", () => {
    const sec = seedSec(db, "ZZA");
    for (let i = 0; i < 5; i++) seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedFill(db, 3, sec, TRADE, "BUY", 5, 10);
    seedFill(db, 3, sec, TRADE2, "SELL", 5, 10);
    seedHold(db, 3, sec, LIVE, "tws", 100);
    buildLots();
    expect(signedLots(3, sec)).toBe(500);

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([
      { key: `lot-drift:3:${sec}`, severity: "critical", reason: "ZZA (IBKR): position/lot drift 80.0%" },
    ]);
    expect(warnings).toEqual([]);
  });

  it("the same duplicate is critical with no live row at all", () => {
    const sec = seedSec(db, "ZZA");
    for (let i = 0; i < 5; i++) seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedFill(db, 3, sec, TRADE, "BUY", 5, 10);
    seedFill(db, 3, sec, TRADE2, "SELL", 5, 10);
    buildLots();

    const { critical } = driftHits();
    expect(critical.map((h) => h.reason)).toEqual(["ZZA (IBKR): position/lot drift 80.0%"]);
  });

  it("lots 100 against a statement of 60 stays critical after a 5-share buy, with a newer live row", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 60);
    seedFill(db, 3, sec, TRADE, "BUY", 5, 10);
    seedHold(db, 3, sec, LIVE, "tws", 60);
    buildLots();
    expect(signedLots(3, sec)).toBe(105);

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([
      { key: `lot-drift:3:${sec}`, severity: "critical", reason: "ZZA (IBKR): position/lot drift 40.0%" },
    ]);
    expect(warnings).toEqual([]);
  });

  it("the same, when the only live row is older than the later buy", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 60);
    seedHold(db, 3, sec, EARLY_LIVE, "tws", 60);
    seedFill(db, 3, sec, TRADE, "BUY", 5, 10);
    buildLots();

    const { critical } = driftHits();
    expect(critical.map((h) => h.reason)).toEqual(["ZZA (IBKR): position/lot drift 40.0%"]);
  });

  it("the same, with no live row at all", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 60);
    seedFill(db, 3, sec, TRADE, "BUY", 5, 10);
    buildLots();

    const { critical } = driftHits();
    expect(critical.map((h) => h.reason)).toEqual(["ZZA (IBKR): position/lot drift 40.0%"]);
  });

  it("the rolled-back disagreement caps the confidence score", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 60);
    seedFill(db, 3, sec, TRADE, "BUY", 5, 10);
    seedHold(db, 3, sec, LIVE, "tws", 60);
    buildLots();

    const conf = getDataConfidence(db);
    expect(conf.integrity.critical.map((h) => h.key)).toEqual([`lot-drift:3:${sec}`]);
    expect(conf.capReason).not.toBeNull();
  });

  it("a statement position whose lots were all bought after the statement: fills counted up to the statement only", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, 3, sec, STMT, "stmt", 100); // no ledger row explains these 100
    seedFill(db, 3, sec, TRADE, "BUY", 50, 10);
    buildLots();
    expect(signedLots(3, sec)).toBe(50);

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([
      {
        key: `lot-drift:3:${sec}`,
        severity: "warning",
        reason: "ZZA (IBKR): statement position has no tax lots and no transactions up to the statement date",
      },
    ]);
  });

  it("lots the statement never carried are reported even after a later trade", () => {
    const held = seedSec(db, "ZZB");
    seedFill(db, 3, held, BEFORE, "BUY", 10, 10);
    seedHold(db, 3, held, STMT, "stmt", 10); // the account HAS a statement book
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "BUY", 30, 10); // open on the statement date, not on the statement
    seedFill(db, 3, sec, TRADE, "BUY", 5, 10);
    buildLots();

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([
      {
        key: `lot-drift:3:${sec}`,
        severity: "warning",
        reason: "ZZA (IBKR): open tax lots with no matching position",
      },
    ]);
  });
});

describe("a difference the later ledger rows fully explain", () => {
  it("no hit: the later buy accounts for the whole difference and there is no newer snapshot", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedFill(db, 3, sec, TRADE, "BUY", 50, 10);
    buildLots();

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("pending statement: the roll-back reconciles and only a newer live row differs", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedFill(db, 3, sec, TRADE, "BUY", 50, 10);
    seedHold(db, 3, sec, LIVE, "tws", 120); // sold 30 since, not imported yet
    buildLots();

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([
      {
        key: `lot-drift:3:${sec}`,
        severity: "warning",
        kind: "statement-lag",
        reason: "ZZA (IBKR): live position differs from tax lots — pending statement",
      },
    ]);
  });

  it("a sale after the statement is added back", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedFill(db, 3, sec, TRADE, "SELL", 40, 12);
    buildLots();
    expect(signedLots(3, sec)).toBe(60);

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("known limit: rows dated AFTER the statement are taken at their word, so only a newer live row can question them", () => {
    // A buy of 400 dated after the statement (for example a file imported
    // twice) rolls back cleanly to the statement's 100. Nothing on the
    // statement contradicts it; the live row does, and that is all the scan
    // can say until the next statement arrives.
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 100);
    for (let i = 0; i < 4; i++) seedFill(db, 3, sec, TRADE, "BUY", 100, 10);
    seedHold(db, 3, sec, LIVE, "tws", 100);
    buildLots();
    expect(signedLots(3, sec)).toBe(500);

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings.map((w) => w.kind)).toEqual(["statement-lag"]);
  });
});

describe("short positions roll back with their sign", () => {
  it("no hit: a short of 100 on the statement, 40 covered afterwards", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "SHORT_SELL", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", -100);
    seedFill(db, 3, sec, TRADE, "BUY_TO_COVER", 40, 9);
    buildLots();
    expect(signedLots(3, sec)).toBe(-60);

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("critical: the statement showed a short of 50, the lots a short of 100, and a later cover does not hide it", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "SHORT_SELL", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", -50);
    seedFill(db, 3, sec, TRADE, "BUY_TO_COVER", 40, 9);
    buildLots();

    const { critical } = driftHits();
    expect(critical.map((h) => h.reason)).toEqual(["ZZA (IBKR): position/lot drift 50.0%"]);
  });
});

describe("a split after the statement is undone by its ratio", () => {
  it("no hit: 100 on the statement, a 2-for-1 split afterwards, 200 in the lots", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedImportSplit(db, sec, TRADE);
    buildLots();
    expect(signedLots(3, sec)).toBe(200);

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("no hit: a buy after the split is removed in post-split shares before the split is undone", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedImportSplit(db, sec, TRADE);
    seedFill(db, 3, sec, TRADE2, "BUY", 10, 5);
    buildLots();
    expect(signedLots(3, sec)).toBe(210);

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("no hit: a sale on the split date itself was made in pre-split shares", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedFill(db, 3, sec, TRADE, "SELL", 20, 12);
    seedImportSplit(db, sec, TRADE);
    buildLots();
    expect(signedLots(3, sec)).toBe(160);

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("critical: the split does not hide a statement disagreement", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 60);
    seedImportSplit(db, sec, TRADE);
    buildLots();

    const { critical } = driftHits();
    expect(critical.map((h) => h.reason)).toEqual(["ZZA (IBKR): position/lot drift 40.0%"]);
  });
});

describe("a pair that cannot be rolled back says so", () => {
  it("a spin-off row after the statement: pending-statement warning naming the reason, never silence", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 60);
    seedFill(db, 3, sec, TRADE, "SPINOFF", 5, 0);
    buildLots();

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([
      {
        key: `lot-drift:3:${sec}`,
        severity: "warning",
        kind: "statement-lag",
        reason:
          "ZZA (IBKR): tax lots cannot be checked against the statement (a corporate action dated after the statement) — pending statement",
      },
    ]);
  });

  it("a hand-entered split after the statement is not undone by guesswork", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 100);
    db.prepare(
      `INSERT INTO corporate_actions
         (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source)
       VALUES (?, 'SPLIT', ?, 2, 1, 1, 'manual')`
    ).run(sec, TRADE);
    buildLots();

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings.map((w) => w.reason)).toEqual([
      "ZZA (IBKR): tax lots cannot be checked against the statement (a hand-entered split dated after the statement) — pending statement",
    ]);
  });

  it("no hit when a snapshot newer than the corporate action agrees with the lots", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, BEFORE, "BUY", 100, 10);
    seedHold(db, 3, sec, STMT, "stmt", 60);
    seedFill(db, 3, sec, TRADE, "SPINOFF", 5, 0);
    seedHold(db, 3, sec, LIVE, "tws", 100);
    buildLots();

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
