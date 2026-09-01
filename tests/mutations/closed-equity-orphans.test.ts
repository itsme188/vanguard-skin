import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { removeOrphanedReconTombstones } from "@/lib/mutations/closed-equity";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function acct(name: string): number {
  return (
    db.prepare(
      `INSERT INTO accounts (name) VALUES (?) ON CONFLICT(name) DO UPDATE SET name=name RETURNING id`,
    ).get(name) as { id: number }
  ).id;
}
function sec(symbol: string, type = "stock"): number {
  return (
    db.prepare(
      `INSERT INTO securities (symbol, security_type) VALUES (?, ?) RETURNING id`,
    ).get(symbol, type) as { id: number }
  ).id;
}
function hold(a: number, s: number, qty: number, date: string, sourceKey?: string): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(a, s, qty, date, sourceKey ?? `seed:${a}:${s}:${date}`);
}

describe("removeOrphanedReconTombstones", () => {
  it(":stmt tombstone requires surviving same-date STATEMENT row — same-date Plaid row is not evidence", () => {
    const a = acct("A1");
    const x = sec("XONE");
    hold(a, x, 0, "2026-08-01", "recon:closed-equity:t:stmt");
    hold(a, sec("OTHER"), 5, "2026-08-01", "plaid:1:9:2026-08-01"); // live row, same date
    expect(removeOrphanedReconTombstones(db)).toBe(1); // orphaned despite plaid row
  });
  it(":stmt tombstone survives while a same-date statement row exists", () => {
    const a = acct("A1");
    hold(a, sec("XONE"), 0, "2026-08-01", "recon:closed-equity:t:stmt");
    hold(a, sec("OTHER"), 5, "2026-08-01", "canonical:hold:1");
    expect(removeOrphanedReconTombstones(db)).toBe(0);
  });
  it("legacy unsuffixed tombstone is statement-grade", () => {
    const a = acct("A1");
    hold(a, sec("XONE"), 0, "2026-08-01", "recon:closed-equity:1:2:2026-08-01");
    hold(a, sec("OTHER"), 5, "2026-08-01", "plaid:1:9:2026-08-01");
    expect(removeOrphanedReconTombstones(db)).toBe(1);
  });
  it("legacy unsuffixed tombstone survives while a same-date STATEMENT row exists", () => {
    const a = acct("A1");
    hold(a, sec("XONE"), 0, "2026-08-01", "recon:closed-equity:1:2:2026-08-01");
    hold(a, sec("OTHER"), 5, "2026-08-01", "canonical:hold:1");
    expect(removeOrphanedReconTombstones(db)).toBe(0);
  });
  it(":live tombstone survives on ANY same-date non-recon row, orphans when none remains", () => {
    const a = acct("A1");
    hold(a, sec("XONE"), 0, "2026-08-01", "recon:closed-equity:t:live");
    hold(a, sec("OTHER"), 5, "2026-08-01", "plaid:1:9:2026-08-01");
    expect(removeOrphanedReconTombstones(db)).toBe(0);
    db.prepare(`DELETE FROM holdings WHERE source_key = 'plaid:1:9:2026-08-01'`).run();
    expect(removeOrphanedReconTombstones(db)).toBe(1);
  });
  it("scopes to accountIds when given and bumps generation only when it deletes", () => {
    const a1 = acct("A1");
    const a2 = acct("A2");
    hold(a1, sec("XONE"), 0, "2026-08-01", "recon:closed-equity:t1:stmt"); // orphan
    hold(a2, sec("YTWO"), 0, "2026-08-01", "recon:closed-equity:t2:stmt"); // orphan, other account
    const g0 = getTaxInputGeneration(db);
    expect(removeOrphanedReconTombstones(db, { accountIds: [a1] })).toBe(1);
    expect(getTaxInputGeneration(db)).toBe(g0 + 1);
    expect(db.prepare(`SELECT COUNT(*) c FROM holdings WHERE account_id=? AND quantity=0`).get(a2)).toEqual({ c: 1 });
    expect(removeOrphanedReconTombstones(db, { accountIds: [a1] })).toBe(0);
    expect(getTaxInputGeneration(db)).toBe(g0 + 1); // no bump on no-op
  });
});
