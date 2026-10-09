import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  addReconciliationCheckpoint,
  getReconciliationCheckpoints,
} from "@/lib/queries/reconciliation";

/**
 * Owner ruling: a checkpoint dated on a weekend or holiday has no daily
 * valuation on that exact date. "Computed" falls back to the nearest PRIOR
 * valuation of the SAME account (within 7 days) and names the date it used.
 * 2020-02-01 is a Saturday; 2020-01-31 a Friday. Synthetic amounts.
 */
describe("checkpoint Computed fallback to the nearest prior valuation", () => {
  let db: Database.Database;
  let a: number;
  let b: number;

  function val(account: number, date: string, total: number) {
    db.prepare(
      `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
       VALUES (?, ?, 0, ?, ?)`,
    ).run(account, date, total, total);
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    a = Number(db.prepare("INSERT INTO accounts (name) VALUES ('Test AAA')").run().lastInsertRowid);
    b = Number(db.prepare("INSERT INTO accounts (name) VALUES ('Test BBB')").run().lastInsertRowid);
  });

  it("Saturday checkpoint uses Friday's valuation and names the date", () => {
    val(a, "2020-01-31", 100000);
    addReconciliationCheckpoint(db, a, "2020-02-01", 100500);
    const [cp] = getReconciliationCheckpoints(db);
    expect(cp.computed_value).toBe(100000);
    expect(cp.difference).toBe(500);
    expect(cp.computed_from_date).toBe("2020-01-31");
    expect(cp.computed_missing_reason).toBeNull();
  });

  it("the row returned by the save carries the same fallback fields", () => {
    val(a, "2020-01-31", 100000);
    const r = addReconciliationCheckpoint(db, a, "2020-02-01", 100500);
    if (r.status !== "saved") throw new Error("expected saved");
    expect(r.checkpoint.computed_from_date).toBe("2020-01-31");
    expect(r.checkpoint.difference).toBe(500);
  });

  it("stores only an exact-date value at save time", () => {
    val(a, "2020-01-31", 100000);
    addReconciliationCheckpoint(db, a, "2020-02-01", 100500);
    const raw = db.prepare("SELECT computed_value, difference FROM reconciliation_checkpoints").get() as {
      computed_value: number | null;
      difference: number | null;
    };
    expect(raw.computed_value).toBeNull();
    expect(raw.difference).toBeNull();
  });

  it("a 10-day gap gives no value and a reason", () => {
    val(a, "2020-01-22", 100000);
    addReconciliationCheckpoint(db, a, "2020-02-01", 100500);
    const [cp] = getReconciliationCheckpoints(db);
    expect(cp.computed_value).toBeNull();
    expect(cp.difference).toBeNull();
    expect(cp.computed_from_date).toBeNull();
    expect(cp.computed_missing_reason).toBe("No valuation on or within 7 days before this date");
  });

  it("exactly 7 days earlier still counts", () => {
    val(a, "2020-01-25", 90000);
    addReconciliationCheckpoint(db, a, "2020-02-01", 91000);
    const [cp] = getReconciliationCheckpoints(db);
    expect(cp.computed_from_date).toBe("2020-01-25");
  });

  it("an exact-date row is unchanged and has no from-date", () => {
    val(a, "2020-01-31", 100000);
    addReconciliationCheckpoint(db, a, "2020-01-31", 100000);
    const [cp] = getReconciliationCheckpoints(db);
    expect(cp.computed_value).toBe(100000);
    expect(cp.difference).toBe(0);
    expect(cp.computed_from_date).toBeNull();
    expect(cp.computed_missing_reason).toBeNull();
  });

  it("never uses another account's valuation", () => {
    val(b, "2020-01-31", 777000);
    addReconciliationCheckpoint(db, a, "2020-02-01", 100500);
    const [cp] = getReconciliationCheckpoints(db, a);
    expect(cp.computed_value).toBeNull();
    expect(cp.computed_from_date).toBeNull();
  });

  it("never uses a later valuation", () => {
    val(a, "2020-02-03", 100000);
    addReconciliationCheckpoint(db, a, "2020-02-01", 100500);
    const [cp] = getReconciliationCheckpoints(db);
    expect(cp.computed_value).toBeNull();
  });
});
