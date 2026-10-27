/**
 * A live row that flipped a position SHORT (negative quantity) over open LONG
 * lots means the long lots were sold: the pair is pending statement, exactly
 * like a live zero. Short lots and statement-grade rows are unchanged.
 * Synthetic fixtures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getPendingStatementPairs } from "@/lib/queries/pending-statement";
import { createPendingTestDb, seedSec, seedHold, seedLot } from "../setup/pending-statement-fixtures";

let db: Database.Database;
beforeEach(() => {
  db = createPendingTestDb();
});

describe("getPendingStatementPairs with a negative newest row", () => {
  it("flags a long lot under a live-origin short row", () => {
    const sec = seedSec(db, "AAA");
    seedLot(db, 3, sec, { qty: 30 });
    seedHold(db, 3, sec, "2026-06-10", "tws", -30);
    const pairs = getPendingStatementPairs(db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].open_quantity).toBe(30);
    expect(pairs[0].flat_date).toBe("2026-06-10");
  });

  it("does not flag a pair whose ledger holds only short lots", () => {
    const sec = seedSec(db, "BBB");
    seedLot(db, 3, sec, { qty: 30, isShort: 1 });
    seedHold(db, 3, sec, "2026-06-10", "tws", -30);
    expect(getPendingStatementPairs(db)).toEqual([]);
  });

  it("still flags a live zero row", () => {
    const sec = seedSec(db, "CCC");
    seedLot(db, 3, sec, { qty: 30 });
    seedHold(db, 3, sec, "2026-06-10", "live-zero");
    expect(getPendingStatementPairs(db)).toHaveLength(1);
  });

  it("does not flag a statement-grade negative row", () => {
    const sec = seedSec(db, "DDD");
    seedLot(db, 3, sec, { qty: 30 });
    seedHold(db, 3, sec, "2026-06-10", "stmt", -30);
    expect(getPendingStatementPairs(db)).toEqual([]);
  });
});
