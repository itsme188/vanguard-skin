/**
 * The position-vs-lots check compares tax lots with STATEMENT holdings.
 *
 * Tax lots are built from the imported ledger, and the ledger moves only when
 * a statement (or activity file) is imported. A live sync (TWS / Plaid) is
 * fresher than the ledger, so a difference seen only in live data means "the
 * statement has not arrived yet" — it is labelled pending statement, stays a
 * warning and never caps the score. A difference between the STATEMENT and
 * the lots is a real defect and still hits.
 *
 * Also pinned here: a currency-conversion (forex) lot has no holdings row by
 * design, so it is never reported as lots without a position.
 *
 * Synthetic tickers and round quantities only. Accounts are the migration
 * seed: 1 = Vanguard Taxable, 3 = IBKR.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { runIntegrityChecks, type IntegrityHit } from "@/lib/queries/integrity-checks";
import { getDataConfidence } from "@/lib/queries/data-confidence";
import { stampTaxLotsConvention } from "@/lib/compute/tax-convention";
import {
  createPendingTestDb,
  seedSec,
  seedFill,
  seedHold,
  seedLot,
} from "../setup/pending-statement-fixtures";

const STMT = "2026-08-31";
const LIVE = "2026-09-15";

let db: Database.Database;

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
  stampTaxLotsConvention(db); // marker current: the check is armed
});

describe("currency-conversion lots", () => {
  it("a forex lot with no holdings row is not reported", () => {
    const fx = seedSec(db, "ZZA.ZZB", "Forex");
    seedLot(db, 3, fx);

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("the forex skip is case- and whitespace-insensitive, and does not hide an ordinary orphan lot", () => {
    const fx = seedSec(db, "ZZA.ZZB", " FOREX ");
    seedLot(db, 3, fx);
    const stock = seedSec(db, "ZZC");
    seedLot(db, 3, stock);

    const { warnings } = driftHits();
    expect(warnings.map((w) => w.key)).toEqual([`lot-drift:3:${stock}`]);
    expect(warnings[0].reason).toBe("ZZC (IBKR): open tax lots with no matching position");
  });
});

describe("a difference seen only in live data is pending statement", () => {
  it("statement agrees with the lots, the live sync shows fewer shares: warning, never critical", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedLot(db, 3, sec, { qty: 100 });
    seedHold(db, 3, sec, LIVE, "tws", 60); // sold 40 since the statement

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

  it("a position opened since the last statement (live row only, no lots yet) is pending statement", () => {
    const old = seedSec(db, "ZZB");
    seedHold(db, 3, old, STMT, "stmt", 10); // the account HAS a statement book
    seedLot(db, 3, old, { qty: 10 });
    const fresh = seedSec(db, "ZZA");
    seedHold(db, 3, fresh, LIVE, "tws", 25);

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([
      {
        key: `lot-drift:3:${fresh}`,
        severity: "warning",
        kind: "statement-lag",
        reason: "ZZA (IBKR): live position differs from tax lots — pending statement",
      },
    ]);
  });

  it("a Plaid row counts as live too", () => {
    const sec = seedSec(db, "ZZA", "Mutual Fund");
    seedHold(db, 1, sec, STMT, "stmt", 100);
    seedLot(db, 1, sec, { qty: 100 });
    seedHold(db, 1, sec, LIVE, "plaid", 120);

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings.map((w) => w.kind)).toEqual(["statement-lag"]);
  });

  it("a small live difference (5% or less) stays silent, as a small statement difference does", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedLot(db, 3, sec, { qty: 100 });
    seedHold(db, 3, sec, LIVE, "tws", 97);

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("a live-only difference never caps the confidence score", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedLot(db, 3, sec, { qty: 100 });
    seedHold(db, 3, sec, LIVE, "tws", 60);

    const conf = getDataConfidence(db);
    expect(conf.integrity.critical).toEqual([]);
    expect(conf.integrity.warnings.some((w) => w.kind === "statement-lag")).toBe(true);
    expect(conf.capReason).toBeNull();
  });
});

describe("a statement that disagrees with the lots is still a hit", () => {
  it("critical when the statement and the lots differ, even though a newer live row agrees with the statement", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedLot(db, 3, sec, { qty: 60 });
    seedHold(db, 3, sec, LIVE, "tws", 100);

    const { critical } = driftHits();
    expect(critical).toEqual([
      { key: `lot-drift:3:${sec}`, severity: "critical", reason: "ZZA (IBKR): position/lot drift 40.0%" },
    ]);
  });

  it("critical when the statement and the lots differ, even though a newer live row happens to agree with the lots", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedLot(db, 3, sec, { qty: 60 });
    seedHold(db, 3, sec, LIVE, "tws", 60);

    const { critical, warnings } = driftHits();
    expect(critical.map((h) => h.key)).toEqual([`lot-drift:3:${sec}`]);
    expect(critical[0].kind).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("critical: a statement position with fills but no lots, even when live data shows it closed", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, "2026-06-01", "BUY", 50, 10);
    seedHold(db, 3, sec, STMT, "stmt", 50);
    seedHold(db, 3, sec, LIVE, "live-zero");

    const { critical } = driftHits();
    expect(critical).toEqual([
      {
        key: `lot-drift:3:${sec}`,
        severity: "critical",
        reason: "ZZA (IBKR): position has 1 fill but zero tax lots",
      },
    ]);
  });

  it("the cap fires on a statement disagreement", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedLot(db, 3, sec, { qty: 60 });
    seedHold(db, 3, sec, LIVE, "tws", 100);

    const conf = getDataConfidence(db);
    expect(conf.integrity.critical.map((h) => h.key)).toEqual([`lot-drift:3:${sec}`]);
    expect(conf.capReason).not.toBeNull();
  });

  it("lots the statement book does not carry are still reported (the statement book is complete)", () => {
    const held = seedSec(db, "ZZB");
    seedHold(db, 3, held, STMT, "stmt", 10);
    seedLot(db, 3, held, { qty: 10 });
    const orphan = seedSec(db, "ZZA");
    seedLot(db, 3, orphan, { qty: 30 }); // no holdings row of any source

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([
      {
        key: `lot-drift:3:${orphan}`,
        severity: "warning",
        reason: "ZZA (IBKR): open tax lots with no matching position",
      },
    ]);
  });
});

describe("the ledger is newer than the statement", () => {
  it("no hit when a trade imported after the statement explains the difference and live agrees with the lots", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedFill(db, 3, sec, "2026-09-10", "BUY", 50, 10);
    seedLot(db, 3, sec, { qty: 150 });
    seedHold(db, 3, sec, LIVE, "tws", 150);

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("no hit when a trade imported after the statement moved the lots and there is no live row at all", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedFill(db, 3, sec, "2026-09-10", "BUY", 50, 10);
    seedLot(db, 3, sec, { qty: 150 });

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("an in-kind transfer after the statement also counts as a newer ledger", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, 1, sec, STMT, "stmt", 100);
    seedFill(db, 1, sec, "2026-09-10", "TRANSFER_OUT", 40, 10);
    seedLot(db, 1, sec, { qty: 60 });
    seedHold(db, 1, sec, LIVE, "plaid", 60);

    const { critical, warnings } = driftHits();
    expect(critical).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("a trade on the statement date itself does not excuse a disagreement", () => {
    const sec = seedSec(db, "ZZA");
    seedFill(db, 3, sec, STMT, "BUY", 60, 10);
    seedHold(db, 3, sec, STMT, "stmt", 100);
    seedLot(db, 3, sec, { qty: 60 });

    const { critical } = driftHits();
    expect(critical.map((h) => h.key)).toEqual([`lot-drift:3:${sec}`]);
  });
});

describe("an account with no statement holdings at all keeps the old comparison", () => {
  it("live position against lots is critical when no statement exists to wait for", () => {
    const sec = seedSec(db, "ZZA");
    seedHold(db, 3, sec, LIVE, "tws", 100);
    seedLot(db, 3, sec, { qty: 60 });

    const { critical } = driftHits();
    expect(critical).toEqual([
      { key: `lot-drift:3:${sec}`, severity: "critical", reason: "ZZA (IBKR): position/lot drift 40.0%" },
    ]);
  });

  it("another account's statement does not turn this account's live difference into pending", () => {
    const other = seedSec(db, "ZZB");
    seedHold(db, 1, other, STMT, "stmt", 10);
    seedLot(db, 1, other, { qty: 10 });
    const sec = seedSec(db, "ZZA");
    seedHold(db, 3, sec, LIVE, "tws", 100);
    seedLot(db, 3, sec, { qty: 60 });

    const { critical } = driftHits();
    expect(critical.map((h) => h.key)).toEqual([`lot-drift:3:${sec}`]);
  });
});
