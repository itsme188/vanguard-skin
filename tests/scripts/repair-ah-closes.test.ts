import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { findAhCloseMismatches, repairAhCloses } from "@/scripts/repair-ah-closes";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function seedSecurity(db: Database.Database, symbol: string): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')")
    .run(symbol, symbol).lastInsertRowid as number;
}

function seedPrice(
  db: Database.Database,
  securityId: number,
  date: string,
  closePrice: number,
  source = "tws",
): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, ?)",
  ).run(securityId, date, closePrice, source);
}

function seedBar(
  db: Database.Database,
  securityId: number,
  date: string,
  close: number,
  barSize = "1 day",
): void {
  db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(securityId, date, barSize, close, close, close, close);
}

function storedClose(db: Database.Database, securityId: number, date: string): number {
  return (
    db
      .prepare("SELECT close_price FROM prices WHERE security_id = ? AND date = ?")
      .get(securityId, date) as { close_price: number }
  ).close_price;
}

describe("findAhCloseMismatches", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("flags a tws price that diverges from its 1-day bar close beyond threshold (NET live example)", () => {
    const secId = seedSecurity(db, "NET");
    seedPrice(db, secId, "2026-08-06", 330.0);
    seedBar(db, secId, "2026-08-06", 284.43);

    const mismatches = findAhCloseMismatches(db, { thresholdPct: 1.0 });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({
      symbol: "NET",
      date: "2026-08-06",
      storedClose: 330.0,
      barClose: 284.43,
    });
    expect(mismatches[0].diffPct).toBeCloseTo(((330.0 - 284.43) / 284.43) * 100, 2);
  });

  it("does not flag a price within threshold of its bar close", () => {
    const secId = seedSecurity(db, "AAPL");
    seedPrice(db, secId, "2026-08-06", 100.2);
    seedBar(db, secId, "2026-08-06", 100.0);

    expect(findAhCloseMismatches(db, { thresholdPct: 1.0 })).toHaveLength(0);
  });

  it("ignores non-tws sources (statement/canonical data is not this bug's blast radius)", () => {
    const secId = seedSecurity(db, "AAPL");
    seedPrice(db, secId, "2026-08-06", 330.0, "manual");
    seedBar(db, secId, "2026-08-06", 284.43);

    expect(findAhCloseMismatches(db, { thresholdPct: 1.0 })).toHaveLength(0);
  });

  it("never flags a row with no matching 1-day bar (no ground truth, no guessing)", () => {
    const secId = seedSecurity(db, "NOBAR");
    seedPrice(db, secId, "2026-08-06", 330.0);
    // No ohlcv_bars row seeded for this security/date at all.

    expect(findAhCloseMismatches(db, { thresholdPct: 1.0 })).toHaveLength(0);
  });

  it("ignores intraday bar sizes — only '1 day' bars are authoritative", () => {
    const secId = seedSecurity(db, "INTRADAY");
    seedPrice(db, secId, "2026-08-06", 330.0);
    seedBar(db, secId, "2026-08-06", 284.43, "5 mins");

    expect(findAhCloseMismatches(db, { thresholdPct: 1.0 })).toHaveLength(0);
  });

  it("respects the --since bound", () => {
    const secId = seedSecurity(db, "NET");
    seedPrice(db, secId, "2026-07-20", 330.0);
    seedBar(db, secId, "2026-07-20", 284.43);
    seedPrice(db, secId, "2026-08-06", 330.0);
    seedBar(db, secId, "2026-08-06", 284.43);

    expect(findAhCloseMismatches(db, { thresholdPct: 1.0 })).toHaveLength(2);

    const bounded = findAhCloseMismatches(db, { thresholdPct: 1.0, since: "2026-08-01" });
    expect(bounded).toHaveLength(1);
    expect(bounded[0].date).toBe("2026-08-06");
  });

  it("respects a custom threshold (LQDT live example: 44.84 vs 42.01)", () => {
    const secId = seedSecurity(db, "LQDT");
    seedPrice(db, secId, "2026-08-06", 44.84);
    seedBar(db, secId, "2026-08-06", 42.01);

    // ~6.7% diff — flagged at 1% and at 5%, not at 10%.
    expect(findAhCloseMismatches(db, { thresholdPct: 1.0 })).toHaveLength(1);
    expect(findAhCloseMismatches(db, { thresholdPct: 5.0 })).toHaveLength(1);
    expect(findAhCloseMismatches(db, { thresholdPct: 10.0 })).toHaveLength(0);
  });

  it("computes a negative diffPct when the stored price undershoots the bar close", () => {
    const secId = seedSecurity(db, "UNDER");
    seedPrice(db, secId, "2026-08-06", 90.0);
    seedBar(db, secId, "2026-08-06", 100.0);

    const mismatches = findAhCloseMismatches(db, { thresholdPct: 1.0 });
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].diffPct).toBeCloseTo(-10.0, 5);
  });
});

describe("repairAhCloses", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createTestDb();
  });

  it("dry run (apply: false) reports the plan without writing", () => {
    const secId = seedSecurity(db, "NET");
    seedPrice(db, secId, "2026-08-06", 330.0);
    seedBar(db, secId, "2026-08-06", 284.43);

    const result = repairAhCloses(db, { thresholdPct: 1.0, apply: false });
    expect(result.mismatches).toHaveLength(1);
    expect(result.updated).toBe(0);
    expect(storedClose(db, secId, "2026-08-06")).toBe(330.0);
  });

  it("apply: true rewrites close_price to the bar's close", () => {
    const secId = seedSecurity(db, "NET");
    seedPrice(db, secId, "2026-08-06", 330.0);
    seedBar(db, secId, "2026-08-06", 284.43);

    const result = repairAhCloses(db, { thresholdPct: 1.0, apply: true });
    expect(result.updated).toBe(1);
    expect(storedClose(db, secId, "2026-08-06")).toBe(284.43);
  });

  it("apply: true repairs every matched row across multiple securities/dates", () => {
    const net = seedSecurity(db, "NET");
    seedPrice(db, net, "2026-08-06", 330.0);
    seedBar(db, net, "2026-08-06", 284.43);

    const lqdt = seedSecurity(db, "LQDT");
    seedPrice(db, lqdt, "2026-08-06", 44.84);
    seedBar(db, lqdt, "2026-08-06", 42.01);

    const clean = seedSecurity(db, "CLEAN");
    seedPrice(db, clean, "2026-08-06", 50.01);
    seedBar(db, clean, "2026-08-06", 50.0);

    const result = repairAhCloses(db, { thresholdPct: 1.0, apply: true });
    expect(result.updated).toBe(2);
    expect(storedClose(db, net, "2026-08-06")).toBe(284.43);
    expect(storedClose(db, lqdt, "2026-08-06")).toBe(42.01);
    expect(storedClose(db, clean, "2026-08-06")).toBe(50.01); // untouched — within threshold
  });

  it("is idempotent — a second apply run at the same threshold finds nothing left to fix", () => {
    const secId = seedSecurity(db, "NET");
    seedPrice(db, secId, "2026-08-06", 330.0);
    seedBar(db, secId, "2026-08-06", 284.43);

    repairAhCloses(db, { thresholdPct: 1.0, apply: true });
    const second = repairAhCloses(db, { thresholdPct: 1.0, apply: true });
    expect(second.mismatches).toHaveLength(0);
    expect(second.updated).toBe(0);
  });

  it("never touches a row with no matching 1-day bar, even on apply", () => {
    const secId = seedSecurity(db, "NOBAR");
    seedPrice(db, secId, "2026-08-06", 330.0);

    const result = repairAhCloses(db, { thresholdPct: 1.0, apply: true });
    expect(result.updated).toBe(0);
    expect(storedClose(db, secId, "2026-08-06")).toBe(330.0);
  });

  it("never touches a non-tws-sourced row, even on apply", () => {
    const secId = seedSecurity(db, "AAPL");
    seedPrice(db, secId, "2026-08-06", 330.0, "manual");
    seedBar(db, secId, "2026-08-06", 284.43);

    const result = repairAhCloses(db, { thresholdPct: 1.0, apply: true });
    expect(result.updated).toBe(0);
    expect(storedClose(db, secId, "2026-08-06")).toBe(330.0);
  });
});
