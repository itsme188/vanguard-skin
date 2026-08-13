import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { fetchAnchorSourceSeamDates } from "@/lib/compute/flow-adjusted";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE monthly_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      month_end_date TEXT NOT NULL,
      total_value REAL NOT NULL,
      source TEXT
    );
  `);
  return db;
}

function insertAnchor(
  db: Database.Database,
  accountId: number,
  date: string,
  source: string | null
): void {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, 100000, ?)`
  ).run(accountId, date, source);
}

describe("fetchAnchorSourceSeamDates", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("emits the newer anchor date when source changes between adjacent anchors", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    insertAnchor(db, 1, "2026-07-11", "plaid");
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-01-01", "2026-12-31")
    ).toEqual(["2026-07-11"]);
  });

  it("emits nothing for same-source runs", () => {
    insertAnchor(db, 1, "2026-07-11", "plaid");
    insertAnchor(db, 1, "2026-07-13", "plaid");
    insertAnchor(db, 1, "2026-07-14", "plaid");
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-01-01", "2026-12-31")
    ).toEqual([]);
  });

  it("never treats an account's first anchor as a seam", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-01-01", "2026-12-31")
    ).toEqual([]);
  });

  it("detects a transition whose predecessor anchor is before startDate", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    insertAnchor(db, 1, "2026-07-11", "plaid");
    // startDate sits between the two anchors — predecessor is out of window
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-07-05", "2026-12-31")
    ).toEqual(["2026-07-11"]);
  });

  it("bounds results to (startDate, endDate]", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    insertAnchor(db, 1, "2026-07-11", "plaid");
    insertAnchor(db, 1, "2026-07-31", "canonical");
    // seam ON startDate is excluded (already inside starting value)
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-07-11", "2026-07-31")
    ).toEqual(["2026-07-31"]);
    // seam after endDate is excluded
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-01-01", "2026-07-15")
    ).toEqual(["2026-07-11"]);
  });

  it("unions, dedupes, and sorts across accounts", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    insertAnchor(db, 1, "2026-07-31", "plaid");
    insertAnchor(db, 2, "2026-06-30", "canonical");
    insertAnchor(db, 2, "2026-07-11", "plaid");
    insertAnchor(db, 2, "2026-07-31", "plaid");
    // account 1 seams: 07-31; account 2 seams: 07-11
    expect(
      fetchAnchorSourceSeamDates(db, [1, 2], "2026-01-01", "2026-12-31")
    ).toEqual(["2026-07-11", "2026-07-31"]);
  });

  it("treats undefined/empty accountIds as all accounts", () => {
    insertAnchor(db, 1, "2026-06-30", "canonical");
    insertAnchor(db, 1, "2026-07-11", "plaid");
    expect(
      fetchAnchorSourceSeamDates(db, undefined, "2026-01-01", "2026-12-31")
    ).toEqual(["2026-07-11"]);
    expect(
      fetchAnchorSourceSeamDates(db, [], "2026-01-01", "2026-12-31")
    ).toEqual(["2026-07-11"]);
  });

  it("treats NULL source as a distinct value (transition to/from it bridges)", () => {
    insertAnchor(db, 1, "2026-05-31", "canonical");
    insertAnchor(db, 1, "2026-06-30", null);
    insertAnchor(db, 1, "2026-07-31", "canonical");
    expect(
      fetchAnchorSourceSeamDates(db, [1], "2026-01-01", "2026-12-31")
    ).toEqual(["2026-06-30", "2026-07-31"]);
  });

  it("returns [] when monthly_snapshots does not exist", () => {
    const bare = new Database(":memory:");
    expect(
      fetchAnchorSourceSeamDates(bare, [1], "2026-01-01", "2026-12-31")
    ).toEqual([]);
  });
});
