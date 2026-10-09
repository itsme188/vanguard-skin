/**
 * removeOrphanedReconTombstones is a DELETE scoped by an account list. Scope
 * rule (adopted 2026-10-08): `undefined` (or no option at all) is every
 * account; a DEFINED EMPTY list is NO accounts and deletes NOTHING. It must
 * never widen the delete to the whole book.
 *
 * Both production callers (import undo, restore) only call it with a
 * non-empty list, so this pins the function's own contract.
 *
 * Synthetic tickers only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { removeOrphanedReconTombstones } from "@/lib/mutations/closed-equity";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";

// Migration 002 seeds accounts 1, 2 and 3.
const A1 = 1;
const A2 = 3;
const DATE = "2026-08-01";

let db: Database.Database;

function sec(symbol: string): number {
  return (
    db
      .prepare(`INSERT INTO securities (symbol, security_type) VALUES (?, 'stock') RETURNING id`)
      .get(symbol) as { id: number }
  ).id;
}

function tombstone(account: number, symbol: string, sourceKey: string): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, 0, ?, ?)`,
  ).run(account, sec(symbol), DATE, sourceKey);
}

/** Surviving tombstone source keys per account. */
function remaining(account: number): string[] {
  return (
    db
      .prepare(
        `SELECT source_key FROM holdings WHERE account_id = ? AND quantity = 0 ORDER BY source_key`,
      )
      .all(account) as { source_key: string }[]
  ).map((r) => r.source_key);
}

const A1_KEYS = [
  "recon:closed-equity:a1-legacy",
  "recon:closed-equity:a1-live:live",
  "recon:closed-equity:a1-stmt:stmt",
];
const A2_KEYS = [
  "recon:closed-equity:a2-legacy",
  "recon:closed-equity:a2-live:live",
  "recon:closed-equity:a2-stmt:stmt",
];

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  // Three orphaned tombstones per account, one of each origin: nothing else
  // is stored on the date, so none has the same-date evidence it needs.
  tombstone(A1, "ZZA", A1_KEYS[0]);
  tombstone(A1, "ZZB", A1_KEYS[1]);
  tombstone(A1, "ZZC", A1_KEYS[2]);
  tombstone(A2, "ZZD", A2_KEYS[0]);
  tombstone(A2, "ZZE", A2_KEYS[1]);
  tombstone(A2, "ZZF", A2_KEYS[2]);
});

describe("removeOrphanedReconTombstones: account scope", () => {
  it("an empty list deletes nothing and does not bump the tax generation", () => {
    const g0 = getTaxInputGeneration(db);
    expect(removeOrphanedReconTombstones(db, { accountIds: [] })).toBe(0);
    expect(remaining(A1)).toEqual(A1_KEYS);
    expect(remaining(A2)).toEqual(A2_KEYS);
    expect(getTaxInputGeneration(db)).toBe(g0);
  });

  it("a one-account list deletes that account's orphans only", () => {
    const g0 = getTaxInputGeneration(db);
    expect(removeOrphanedReconTombstones(db, { accountIds: [A1] })).toBe(3);
    expect(remaining(A1)).toEqual([]);
    expect(remaining(A2)).toEqual(A2_KEYS);
    // A statement-grade tombstone went: one bump.
    expect(getTaxInputGeneration(db)).toBe(g0 + 1);
  });

  it("undefined, and no option at all, delete every account's orphans", () => {
    expect(removeOrphanedReconTombstones(db, { accountIds: undefined })).toBe(6);
    expect(remaining(A1)).toEqual([]);
    expect(remaining(A2)).toEqual([]);
  });

  it("no option object is every account too", () => {
    expect(removeOrphanedReconTombstones(db)).toBe(6);
    expect(remaining(A1)).toEqual([]);
    expect(remaining(A2)).toEqual([]);
  });

  it("the three scopes in sequence: nothing, one account, then the rest", () => {
    expect(removeOrphanedReconTombstones(db, { accountIds: [] })).toBe(0);
    expect(removeOrphanedReconTombstones(db, { accountIds: [A1] })).toBe(3);
    expect(removeOrphanedReconTombstones(db, { accountIds: [] })).toBe(0);
    expect(remaining(A2)).toEqual(A2_KEYS);
    expect(removeOrphanedReconTombstones(db, { accountIds: undefined })).toBe(3);
    expect(remaining(A2)).toEqual([]);
  });
});
