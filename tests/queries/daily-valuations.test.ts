import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  getDailyValuationsForAccounts,
  getDailyValuationsByAccount,
  getDailyValuationsCombined,
} from "@/lib/queries/daily-valuations";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE daily_valuations (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      valuation_date TEXT NOT NULL,
      cash_balance REAL NOT NULL DEFAULT 0,
      holdings_value REAL NOT NULL DEFAULT 0,
      total_value REAL NOT NULL DEFAULT 0,
      UNIQUE(account_id, valuation_date)
    );
  `);
  db.exec("INSERT INTO accounts (id, name) VALUES (1, 'A'), (2, 'B'), (3, 'C')");
  return db;
}

function seed(db: Database.Database, acct: number, date: string, total: number) {
  db.prepare(
    "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (?, ?, 0, ?, ?)"
  ).run(acct, date, total, total);
}

describe("getDailyValuationsForAccounts", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // Two dates, three accounts.
    seed(db, 1, "2026-01-01", 100);
    seed(db, 2, "2026-01-01", 50);
    seed(db, 3, "2026-01-01", 25);
    seed(db, 1, "2026-01-02", 110);
    seed(db, 2, "2026-01-02", 60);
    seed(db, 3, "2026-01-02", 30);
  });

  it("sums total_value across the requested accounts, one row per date", () => {
    const rows = getDailyValuationsForAccounts(db, [1, 2]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ valuation_date: "2026-01-01", total_value: 150, account_id: 0 });
    expect(rows[1]).toMatchObject({ valuation_date: "2026-01-02", total_value: 170 });
  });

  it("a single-account subset matches getDailyValuationsByAccount totals", () => {
    const subset = getDailyValuationsForAccounts(db, [1]);
    const byAccount = getDailyValuationsByAccount(db, 1);
    expect(subset.map((r) => r.total_value)).toEqual(byAccount.map((r) => r.total_value));
    expect(subset.map((r) => r.valuation_date)).toEqual(byAccount.map((r) => r.valuation_date));
  });

  it("empty/undefined accountIds falls through to the all-accounts combined view", () => {
    expect(getDailyValuationsForAccounts(db, [])).toEqual(getDailyValuationsCombined(db));
  });

  it("respects startDate / endDate filtering", () => {
    const rows = getDailyValuationsForAccounts(db, [1, 2, 3], { startDate: "2026-01-02" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ valuation_date: "2026-01-02", total_value: 200 });
  });
});

// ── Coverage-jump guard ─────────────────────────────────────────────
//
// Account coverage windows differ (live DB: IBKR daily valuations start
// 3/27, Vanguard + Roth 4/06). A summed multi-account series "gains" an
// appearing account's entire value as a fake return on its first covered
// date (+89% phantom YTD alpha). `fullCoverageOnly` keeps only dates where
// the MAX number of simultaneously-covered accounts all have a row —
// max-coverage (not accountIds.length) so a scoped account with no data at
// all in the window doesn't blank the series.
describe("fullCoverageOnly (coverage-jump guard)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    // Account 1 covers 4 dates; account 2 appears on the 3rd.
    seed(db, 1, "2026-01-01", 100);
    seed(db, 1, "2026-01-02", 110);
    seed(db, 1, "2026-01-03", 120);
    seed(db, 1, "2026-01-04", 130);
    seed(db, 2, "2026-01-03", 1000);
    seed(db, 2, "2026-01-04", 1010);
  });

  it("drops dates below max simultaneous coverage for an account subset", () => {
    const rows = getDailyValuationsForAccounts(db, [1, 2], { fullCoverageOnly: true });
    expect(rows.map((r) => r.valuation_date)).toEqual(["2026-01-03", "2026-01-04"]);
    expect(rows[0].total_value).toBe(1120);
    expect(rows[1].total_value).toBe(1140);
  });

  it("keeps every date by default (existing consumers unchanged)", () => {
    const rows = getDailyValuationsForAccounts(db, [1, 2]);
    expect(rows).toHaveLength(4);
    expect(rows[0].total_value).toBe(100);
  });

  it("applies to the combined all-accounts variant too", () => {
    const rows = getDailyValuationsCombined(db, { fullCoverageOnly: true });
    expect(rows.map((r) => r.valuation_date)).toEqual(["2026-01-03", "2026-01-04"]);
  });

  it("self-calibrates when a scoped account has no rows at all", () => {
    // Account 3 exists but never has valuations — max coverage in the
    // window for [1, 3] is 1, so every account-1 date survives.
    const rows = getDailyValuationsForAccounts(db, [1, 3], { fullCoverageOnly: true });
    expect(rows).toHaveLength(4);
  });

  it("recomputes max coverage within a narrowed date range", () => {
    // In [01-01, 01-02] only account 1 has rows → max coverage 1 → both kept.
    const rows = getDailyValuationsForAccounts(db, [1, 2], {
      startDate: "2026-01-01",
      endDate: "2026-01-02",
      fullCoverageOnly: true,
    });
    expect(rows.map((r) => r.valuation_date)).toEqual(["2026-01-01", "2026-01-02"]);
  });
});
