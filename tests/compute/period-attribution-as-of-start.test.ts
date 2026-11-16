/**
 * Per-position contributions read the positions and prices IN FORCE at the
 * period start: the latest holdings row per (account, security) on or before
 * the start and the latest close on or before it, never a row after it (no
 * look-ahead). Before the fix both had to sit on EXACTLY the start date, and
 * the start dates the Performance view passes (January 1, a month-end that
 * falls on a weekend) never carry one, so the section never rendered.
 *
 * Synthetic symbols and round figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computePeriodAttribution } from "@/lib/compute/period-attribution";

const START = "2026-01-01"; // a holiday: no close, no statement
const END = "2026-05-31"; // a Sunday: no close on the day

describe("computePeriodAttribution reads the book as of the start", () => {
  let db: Database.Database;

  const security = (id: number, sym: string, sector = "Technology", type = "Stock", currency = "USD") =>
    db
      .prepare(`INSERT INTO securities (id, symbol, security_type, sector, currency) VALUES (?, ?, ?, ?, ?)`)
      .run(id, sym, type, sector, currency);
  const price = (id: number, date: string, close: number) =>
    db
      .prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`)
      .run(id, date, close);
  const holding = (account: number, id: number, date: string, qty: number) =>
    db
      .prepare(
        `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(account, id, date, qty, `h-${account}-${id}-${date}`);
  const snapshot = (account: number, date: string, value: number) =>
    db
      .prepare(
        `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (?, ?, ?, 'statement')`,
      )
      .run(account, date, value);

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    // accounts 1/2/3 are pre-seeded by migrations.
    security(10, "ZZA");
    security(11, "ZZB", "Energy");
    // Statement book on the prior month-end.
    holding(1, 10, "2025-12-31", 100);
    holding(1, 11, "2025-12-31", 100);
    snapshot(1, "2025-12-31", 20000);
    price(10, "2025-12-31", 100);
    price(11, "2025-12-31", 100);
    // Friday before the Sunday end.
    price(10, "2026-05-29", 120); // +20%
    price(11, "2026-05-29", 90); // -10%
  });

  it("weights from the latest holdings and close on or before the start, ending on the latest close on or before the end", () => {
    const r = computePeriodAttribution(db, 1, START, END);
    expect(r.topContributors.map((c) => c.symbol)).toEqual(["ZZA"]);
    expect(r.topDetractors.map((c) => c.symbol)).toEqual(["ZZB"]);
    // Equal weights: 0.5 × 20% and 0.5 × −10%.
    expect(r.topContributors[0].contribution).toBeCloseTo(0.1, 10);
    expect(r.topDetractors[0].contribution).toBeCloseTo(-0.05, 10);
    expect(r.positionsBasis).toEqual({ asOf: "2025-12-31", emptyReason: null, missingAccounts: [] });
  });

  it("never reads a holdings row or a close dated after the start", () => {
    // A later book with a different quantity and a later close must not move
    // the start weights or the start price.
    holding(1, 10, "2026-01-31", 900);
    price(10, "2026-01-02", 50);
    const r = computePeriodAttribution(db, 1, START, END);
    expect(r.topContributors[0].symbol).toBe("ZZA");
    expect(r.topContributors[0].contribution).toBeCloseTo(0.1, 10);
  });

  it("a quantity-zero tombstone on or before the start closes the position", () => {
    holding(1, 11, "2026-01-01", 0);
    const r = computePeriodAttribution(db, 1, START, END);
    expect(r.topDetractors).toEqual([]);
    // ZZA is now the whole weight: 100% × 20%.
    expect(r.topContributors[0].contribution).toBeCloseTo(0.2, 10);
  });

  it("a book older than one statement cycle is not the start book: empty, with the reason", () => {
    db.prepare(`DELETE FROM holdings`).run();
    holding(1, 10, "2025-10-31", 100);
    holding(1, 11, "2025-10-31", 100);
    const r = computePeriodAttribution(db, 1, START, END);
    expect(r.topContributors).toEqual([]);
    expect(r.topDetractors).toEqual([]);
    expect(r.sectorContribution).toEqual([]);
    expect(r.positionsBasis.emptyReason).toBe("accounts_missing_at_start");
  });

  it("a stale start close is not used", () => {
    db.prepare(`DELETE FROM prices WHERE security_id = 11 AND date = '2025-12-31'`).run();
    price(11, "2025-11-28", 100);
    const r = computePeriodAttribution(db, 1, START, END);
    expect(r.topDetractors).toEqual([]);
    expect(r.topContributors.map((c) => c.symbol)).toEqual(["ZZA"]);
  });

  it("a scope with an account that held value at the start but has no start book shows nothing, naming the account", () => {
    snapshot(2, "2025-12-31", 50000); // account 2 had money, no holdings on file
    const r = computePeriodAttribution(db, [1, 2], START, END);
    expect(r.topContributors).toEqual([]);
    expect(r.sectorContribution).toEqual([]);
    expect(r.positionsBasis.emptyReason).toBe("accounts_missing_at_start");
    const name = (db.prepare(`SELECT name FROM accounts WHERE id = 2`).get() as { name: string }).name;
    expect(r.positionsBasis.missingAccounts).toEqual([name]);
  });

  it("an account with no value at the start (opened later) does not block the scope", () => {
    snapshot(2, "2026-03-31", 50000);
    holding(2, 10, "2026-03-31", 10);
    const r = computePeriodAttribution(db, [1, 2], START, END);
    expect(r.topContributors.map((c) => c.symbol)).toEqual(["ZZA"]);
    expect(r.positionsBasis.emptyReason).toBeNull();
  });

  it("no position snapshot at all before the start: empty with its own reason", () => {
    const r = computePeriodAttribution(db, 1, "2000-01-01", END);
    expect(r.topContributors).toEqual([]);
    expect(r.positionsBasis.emptyReason).toBe("no_positions_at_start");
  });
});
