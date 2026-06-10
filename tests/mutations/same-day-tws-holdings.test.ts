import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { removeStaleSameDayTwsHoldings } from "@/lib/mutations/same-day-tws-holdings";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE securities (id INTEGER PRIMARY KEY, symbol TEXT NOT NULL UNIQUE);
    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      cost_basis REAL,
      as_of_date TEXT NOT NULL,
      source_key TEXT,
      UNIQUE(account_id, security_id, as_of_date)
    );
  `);
  db.exec("INSERT INTO accounts (id, name) VALUES (3, 'IBKR'), (1, 'Vanguard Taxable')");
  for (let i = 1; i <= 10; i++) {
    db.prepare("INSERT INTO securities (id, symbol) VALUES (?, ?)").run(i, `SYM${i}`);
  }
  return db;
}

function seedTwsRow(
  db: Database.Database,
  securityId: number,
  quantity: number,
  date = "2026-04-23",
  accountId = 3
) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, ?, ?)"
  ).run(accountId, securityId, quantity, date, `tws-${accountId}-${securityId}-${date}`);
}

describe("removeStaleSameDayTwsHoldings", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("deletes same-day tws rows for positions absent from the current sync", () => {
    // Morning sync wrote 5 positions incl. an intraday short that was closed
    // before the afternoon sync. Afternoon sync reports 4 positions.
    for (let i = 1; i <= 4; i++) seedTwsRow(db, i, 100);
    seedTwsRow(db, 5, -100); // intraday short, closed before this sync

    const result = removeStaleSameDayTwsHoldings(db, {
      accountId: 3,
      asOfDate: "2026-04-23",
      syncedSecurityIds: [1, 2, 3, 4],
    });

    expect(result.skipped).toBe(false);
    expect(result.deleted).toBe(1);
    const remaining = db
      .prepare("SELECT security_id FROM holdings WHERE account_id = 3 AND as_of_date = '2026-04-23' ORDER BY security_id")
      .all() as { security_id: number }[];
    expect(remaining.map(r => r.security_id)).toEqual([1, 2, 3, 4]);
  });

  it("never touches statement-sourced rows on the same date", () => {
    seedTwsRow(db, 1, 100);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (3, 2, 50, '2026-04-23', 'ibkr:pos:U13643679:SYM2:2026-04-23')"
    ).run();

    const result = removeStaleSameDayTwsHoldings(db, {
      accountId: 3,
      asOfDate: "2026-04-23",
      syncedSecurityIds: [1],
    });

    expect(result.deleted).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM holdings WHERE security_id = 2").get()
    ).toEqual({ c: 1 });
  });

  it("skips cleanup when the sync looks partial (shrink guard)", () => {
    // 6 existing tws rows but the sync only returned 2 positions — a partial
    // TWS capture must not wipe the day's book.
    for (let i = 1; i <= 6; i++) seedTwsRow(db, i, 100);

    const result = removeStaleSameDayTwsHoldings(db, {
      accountId: 3,
      asOfDate: "2026-04-23",
      syncedSecurityIds: [1, 2],
    });

    expect(result.skipped).toBe(true);
    expect(result.deleted).toBe(0);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM holdings WHERE as_of_date = '2026-04-23'").get()
    ).toEqual({ c: 6 });
  });

  it("leaves other dates and other accounts untouched", () => {
    seedTwsRow(db, 1, 100, "2026-04-22"); // prior day — out of scope
    seedTwsRow(db, 2, 100, "2026-04-23", 1); // other account — out of scope
    seedTwsRow(db, 3, 100, "2026-04-23");
    seedTwsRow(db, 4, 100, "2026-04-23"); // ghost for today

    const result = removeStaleSameDayTwsHoldings(db, {
      accountId: 3,
      asOfDate: "2026-04-23",
      syncedSecurityIds: [3],
    });

    expect(result.deleted).toBe(1);
    expect(
      db.prepare("SELECT COUNT(*) AS c FROM holdings").get()
    ).toEqual({ c: 3 }); // 4/22 row + account-1 row + kept SYM3
  });

  it("no-ops when there are no existing tws rows for the date", () => {
    const result = removeStaleSameDayTwsHoldings(db, {
      accountId: 3,
      asOfDate: "2026-04-23",
      syncedSecurityIds: [1, 2],
    });
    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(false);
  });

  it("skips when the sync returned zero positions", () => {
    seedTwsRow(db, 1, 100);
    const result = removeStaleSameDayTwsHoldings(db, {
      accountId: 3,
      asOfDate: "2026-04-23",
      syncedSecurityIds: [],
    });
    expect(result.skipped).toBe(true);
    expect(result.deleted).toBe(0);
  });
});
