/**
 * Period attribution reads a COMPLETE book at the start (review 2026-11-15,
 * W4). The start weights are the latest row per (account, security) on or
 * before the start, at most 31 days old. A position sold with no tombstone
 * kept its last row inside that window, so a newer book of the same account
 * that no longer held it still left it weighted. The as-of mirror of the
 * closed-position reconciler's rules (lib/mutations/closed-equity.ts) now
 * applies:
 *   - a newer STATEMENT book retires any type (cash equivalents excepted);
 *   - a newer snapshot of ANY source retires stocks and ETFs only (a live
 *     source omits bonds and funds, so it never retires them);
 *   - neither applies when the newer book shrank below half of the one
 *     before it (a partial sync).
 * Also pinned: the accurate empty reasons for an option-only book and for
 * holdings with no end close. Synthetic symbols and round figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computePeriodAttribution } from "@/lib/compute/period-attribution";

const START = "2026-01-01";
const END = "2026-05-31";

let db: Database.Database;

const sec = (id: number, sym: string, type = "Stock", mult: number | null = null) =>
  db
    .prepare(`INSERT INTO securities (id, symbol, security_type, sector, currency, multiplier) VALUES (?, ?, ?, 'Technology', 'USD', ?)`)
    .run(id, sym, type, mult);
const px = (id: number, d: string, c: number) =>
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`).run(id, d, c);
const stmt = (a: number, id: number, d: string, q: number) =>
  db
    .prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (?, ?, ?, ?, ?)`)
    .run(a, id, d, q, `canonical:hold:${a}:${id}:${d}`);
const live = (a: number, id: number, d: string, q: number) =>
  db
    .prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (?, ?, ?, ?, ?)`)
    .run(a, id, d, q, `plaid:${a}:${id}:${d}`);
const snap = (a: number, d: string, v: number) =>
  db
    .prepare(`INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (?, ?, ?, 'canonical')`)
    .run(a, d, v);

const symbols = () => {
  const r = computePeriodAttribution(db, 1, START, END);
  return [...r.topContributors, ...r.topDetractors].map((c) => c.symbol).sort();
};

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  sec(10, "ZZA");
  sec(11, "ZZB");
  sec(12, "ZZF", "Mutual Fund");
  for (const id of [10, 11, 12]) {
    px(id, "2025-12-31", 100);
    px(id, "2026-05-29", id === 11 ? 90 : 120);
  }
  snap(1, "2025-12-31", 30000);
});

describe("period attribution: a newer book of the account retires a position it no longer holds", () => {
  it("a newer live book without a stock drops that stock (no tombstone on file)", () => {
    stmt(1, 10, "2025-12-15", 100);
    stmt(1, 11, "2025-12-15", 100);
    live(1, 10, "2025-12-27", 100);
    const r = computePeriodAttribution(db, 1, START, END);
    expect(symbols()).toEqual(["ZZA"]);
    // ZZA is the whole book: 100% x +20%.
    expect(r.topContributors[0].contribution).toBeCloseTo(0.2, 10);
  });

  it("a newer live book never retires a fund (live sources omit funds)", () => {
    stmt(1, 10, "2025-12-15", 100);
    stmt(1, 12, "2025-12-15", 100);
    live(1, 10, "2025-12-27", 100);
    expect(symbols()).toEqual(["ZZA", "ZZF"]);
  });

  it("a newer statement book retires a fund it no longer lists", () => {
    stmt(1, 10, "2025-12-15", 100);
    stmt(1, 11, "2025-12-15", 100);
    stmt(1, 12, "2025-12-15", 100);
    stmt(1, 10, "2025-12-31", 100);
    stmt(1, 11, "2025-12-31", 100);
    expect(symbols()).toEqual(["ZZA", "ZZB"]);
  });

  it("a newer book that shrank below half of the one before retires nothing (partial sync)", () => {
    sec(13, "ZZC");
    sec(14, "ZZD");
    for (const id of [13, 14]) {
      px(id, "2025-12-31", 100);
      px(id, "2026-05-29", 110);
    }
    for (const id of [10, 11, 13, 14]) stmt(1, id, "2025-12-15", 100);
    live(1, 10, "2025-12-27", 100); // 1 of 4: looks partial
    expect(symbols()).toEqual(["ZZA", "ZZB", "ZZC", "ZZD"]);
  });

  it("a book dated AFTER the start never retires anything (no look-ahead)", () => {
    stmt(1, 10, "2025-12-15", 100);
    stmt(1, 11, "2025-12-15", 100);
    live(1, 10, "2026-01-05", 100);
    expect(symbols()).toEqual(["ZZA", "ZZB"]);
  });
});

describe("period attribution: accurate empty reasons", () => {
  it("an option-only book says it holds no long stocks, ETFs or funds", () => {
    sec(20, "ZZA  260619C00100000", "Option", 100);
    px(20, "2025-12-31", 5);
    px(20, "2026-05-29", 8);
    stmt(1, 20, "2025-12-31", 2);
    const r = computePeriodAttribution(db, 1, START, END);
    expect(r.positionsBasis.emptyReason).toBe("no_eligible_positions_at_start");
    expect(r.positionsBasis.asOf).toBe("2025-12-31");
  });

  it("a book of shorts only says the same", () => {
    stmt(1, 10, "2025-12-31", -100);
    const r = computePeriodAttribution(db, 1, START, END);
    expect(r.positionsBasis.emptyReason).toBe("no_eligible_positions_at_start");
  });

  it("holdings at the start with no close within a week of the end say so", () => {
    db.prepare("DELETE FROM prices WHERE date = '2026-05-29'").run();
    px(10, "2026-05-01", 120); // older than a week before the end
    stmt(1, 10, "2025-12-31", 100);
    const r = computePeriodAttribution(db, 1, START, END);
    expect(r.positionsBasis.emptyReason).toBe("no_end_price");
  });

  it("holdings at the start with no close within a week of the start say so", () => {
    db.prepare("DELETE FROM prices WHERE date = '2025-12-31'").run();
    stmt(1, 10, "2025-12-31", 100);
    const r = computePeriodAttribution(db, 1, START, END);
    expect(r.positionsBasis.emptyReason).toBe("no_start_price");
  });

  it("a book of tombstones only (all cash) is still 'no positions'", () => {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 10, '2025-12-31', 0, 'recon:closed-equity:1:10:2025-12-31:stmt')`,
    ).run();
    const r = computePeriodAttribution(db, 1, START, END);
    expect(r.positionsBasis.emptyReason).toBe("no_positions_at_start");
  });
});
