/**
 * getPendingStatementPairs — the single pending-statement read model
 * (spec docs/superpowers/specs/2026-10-02-statement-only-synthetic-closes-design.md
 * §2.2 (a)-(d), §3 items 1 and 10).
 *
 * A pair is "pending statement" when the newest holdings row of ANY source
 * is a LIVE-origin zero, the statement evidence does not already show it
 * flat (that is the engine's job), and it holds long stock/ETF lots the
 * engine's own split guard would not skip. Synthetic fixtures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getPendingStatementPairs, pendingStatementKey } from "@/lib/queries/pending-statement";
import {
  createPendingTestDb,
  seedSec,
  seedFill,
  seedHold,
  seedPx,
  seedLot,
  seedImportSplit,
} from "../setup/pending-statement-fixtures";

let db: Database.Database;
beforeEach(() => {
  db = createPendingTestDb();
});

function syntheticCloses(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'RECONCILE_CLOSE'").get() as { n: number }
  ).n;
}

describe("getPendingStatementPairs — pending cases", () => {
  it("a :live tombstone as the newest row keeps the lots open and reports the pair (spec §3 item 1)", () => {
    const sec = seedSec(db, "PNDA");
    seedFill(db, 3, sec, "2026-06-01", "BUY", 10, 100);
    seedHold(db, 3, sec, "2026-06-30", "stmt", 10);
    seedHold(db, 3, sec, "2026-07-10", "live-zero");
    seedPx(db, sec, "2026-07-10", 120);
    computeTaxLots(db);

    expect(syntheticCloses()).toBe(0);
    const pairs = getPendingStatementPairs(db);
    expect(pairs).toEqual([
      {
        account_id: 3,
        security_id: sec,
        symbol: "PNDA",
        live_flat_date: "2026-07-10",
        open_quantity: 10,
        open_basis: 1000,
      },
    ]);
  });

  it("a live-sync zero row (tws- or plaid:) as the newest row is pending too", () => {
    const a = seedSec(db, "PNDB");
    const b = seedSec(db, "PNDC", "ETF");
    seedFill(db, 3, a, "2026-06-01", "BUY", 5, 10);
    seedFill(db, 1, b, "2026-06-01", "BUY", 4, 10);
    seedHold(db, 3, a, "2026-07-10", "tws", 0);
    seedHold(db, 1, b, "2026-07-11", "plaid", 0);
    computeTaxLots(db);

    const syms = getPendingStatementPairs(db).map((p) => p.symbol).sort();
    expect(syms).toEqual(["PNDB", "PNDC"]);
  });

  it("sums only the still-open share of each lot (quantity_remaining, dollar-proportional basis)", () => {
    const sec = seedSec(db, "PNDD");
    seedFill(db, 3, sec, "2026-05-01", "BUY", 10, 100);
    seedFill(db, 3, sec, "2026-05-02", "BUY", 10, 200);
    seedFill(db, 3, sec, "2026-05-10", "SELL", 15, 150);
    seedHold(db, 3, sec, "2026-07-10", "live-zero");
    computeTaxLots(db);

    const [pair] = getPendingStatementPairs(db);
    expect(pair.open_quantity).toBe(5);
    expect(pair.open_basis).toBeCloseTo(1000, 6); // 5 of the 200-dollar lot
  });
});

describe("getPendingStatementPairs — never pending (spec §3 item 10)", () => {
  it("statement-grade zero as the newest statement-grade row: never pending, even under a newer live zero", () => {
    // Statement shows flat on 06-30; an imported re-buy on 07-05 keeps the
    // engine from closing (later-fill guard), then a live zero on 07-10.
    // The newest statement evidence is a zero, so this is the engine's pair.
    const sec = seedSec(db, "STMA");
    seedFill(db, 3, sec, "2026-06-01", "BUY", 10, 100);
    seedHold(db, 3, sec, "2026-06-30", "stmt-zero");
    seedFill(db, 3, sec, "2026-07-05", "BUY", 3, 100);
    seedHold(db, 3, sec, "2026-07-10", "live-zero");
    computeTaxLots(db);

    const open = db
      .prepare("SELECT COUNT(*) AS n FROM tax_lots WHERE security_id = ? AND quantity_remaining > 0")
      .get(sec) as { n: number };
    expect(open.n).toBeGreaterThan(0); // the predicate, not lot absence, is what excludes it
    expect(getPendingStatementPairs(db)).toEqual([]);
  });

  it("a legacy unsuffixed tombstone on a statement date counts as statement-grade too", () => {
    const sec = seedSec(db, "STMB");
    seedLot(db, 3, sec);
    seedHold(db, 3, sec, "2026-06-30", "legacy-zero");
    // The statement book on that date justifies the legacy tombstone (I2).
    seedHold(db, 3, seedSec(db, "STMBBOOK"), "2026-06-30", "stmt", 5);
    seedHold(db, 3, sec, "2026-07-10", "tws", 0);
    expect(getPendingStatementPairs(db)).toEqual([]);
  });

  it("a legacy unsuffixed tombstone on a live-only date is live-origin: the pair is pending (I2)", () => {
    const sec = seedSec(db, "STMBL");
    seedLot(db, 3, sec);
    seedHold(db, 3, sec, "2026-07-10", "legacy-zero");
    seedHold(db, 3, seedSec(db, "STMBLIVE"), "2026-07-10", "tws", 5);
    expect(getPendingStatementPairs(db).map((p) => p.symbol)).toEqual(["STMBL"]);
  });

  it("a statement-flat pair the engine closes is not pending (the close owns it)", () => {
    const sec = seedSec(db, "STMC");
    seedFill(db, 3, sec, "2026-06-01", "BUY", 10, 100);
    seedHold(db, 3, sec, "2026-06-30", "stmt-zero");
    seedPx(db, sec, "2026-06-30", 110);
    computeTaxLots(db);
    expect(syntheticCloses()).toBe(1);
    expect(getPendingStatementPairs(db)).toEqual([]);
  });

  it("newest row non-zero (live re-buy after a live zero) is not pending", () => {
    const sec = seedSec(db, "STMD");
    seedLot(db, 3, sec);
    seedHold(db, 3, sec, "2026-07-10", "live-zero");
    seedHold(db, 3, sec, "2026-07-12", "tws", 10);
    expect(getPendingStatementPairs(db)).toEqual([]);
  });

  it("newest zero row that is NOT live-origin (unknown prefix) is not pending", () => {
    const sec = seedSec(db, "STME");
    seedLot(db, 3, sec);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (3, ?, 0, '2026-07-10', 'test:holding:x')`
    ).run(sec);
    expect(getPendingStatementPairs(db)).toEqual([]);
  });

  it("short lots are never pending", () => {
    const sec = seedSec(db, "SHRT");
    seedLot(db, 3, sec, { isShort: 1 });
    seedHold(db, 3, sec, "2026-07-10", "live-zero");
    expect(getPendingStatementPairs(db)).toEqual([]);
  });

  it.each([["Option"], ["Bond"], ["Mutual Fund"], ["Money Market"]])(
    "a %s is never pending",
    (type) => {
      const sec = seedSec(db, `T${type.replace(/\s/g, "").slice(0, 4).toUpperCase()}`, type);
      seedLot(db, 3, sec);
      seedHold(db, 3, sec, "2026-07-10", "live-zero");
      expect(getPendingStatementPairs(db)).toEqual([]);
    }
  );

  it("lots with nothing remaining are not pending", () => {
    const sec = seedSec(db, "SOLD");
    seedLot(db, 3, sec, { remaining: 0 });
    seedHold(db, 3, sec, "2026-07-10", "live-zero");
    expect(getPendingStatementPairs(db)).toEqual([]);
  });

  it("a split-guard-skipped pair (import split after the zero date) is not pending", () => {
    const sec = seedSec(db, "SPLT");
    seedLot(db, 3, sec);
    seedHold(db, 3, sec, "2026-07-10", "live-zero");
    seedImportSplit(db, sec, "2026-07-20");
    expect(getPendingStatementPairs(db)).toEqual([]);
  });

  it("an import split ON or BEFORE the zero date does not skip the pair (same comparison as the engine)", () => {
    const sec = seedSec(db, "SPLB");
    seedLot(db, 3, sec);
    seedHold(db, 3, sec, "2026-07-10", "live-zero");
    seedImportSplit(db, sec, "2026-07-10");
    expect(getPendingStatementPairs(db).map((p) => p.symbol)).toEqual(["SPLB"]);
  });

  it("an imported position-changing fill after the live zero means the snapshot is stale: not pending", () => {
    const sec = seedSec(db, "LATE");
    seedLot(db, 3, sec);
    seedHold(db, 3, sec, "2026-07-10", "live-zero");
    seedFill(db, 3, sec, "2026-07-15", "BUY", 1, 100);
    expect(getPendingStatementPairs(db)).toEqual([]);
  });
});

describe("getPendingStatementPairs — scoping", () => {
  beforeEach(() => {
    const a = seedSec(db, "SCPA");
    const b = seedSec(db, "SCPB");
    seedLot(db, 1, a);
    seedHold(db, 1, a, "2026-07-10", "plaid", 0);
    seedLot(db, 3, b);
    seedHold(db, 3, b, "2026-07-10", "live-zero");
  });

  it("respects accountIds (multi-account scope keeps every listed account)", () => {
    expect(getPendingStatementPairs(db).map((p) => p.symbol)).toEqual(["SCPA", "SCPB"]);
    expect(getPendingStatementPairs(db, [3]).map((p) => p.symbol)).toEqual(["SCPB"]);
    expect(getPendingStatementPairs(db, [1, 3]).map((p) => p.symbol)).toEqual(["SCPA", "SCPB"]);
    expect(getPendingStatementPairs(db, [2])).toEqual([]);
  });

  it("an empty scope selects nothing", () => {
    expect(getPendingStatementPairs(db, [])).toEqual([]);
  });

  it("pendingStatementKey is the account:security key surfaces join on", () => {
    const [pair] = getPendingStatementPairs(db, [3]);
    expect(pendingStatementKey(pair)).toBe(`3:${pair.security_id}`);
  });
});
