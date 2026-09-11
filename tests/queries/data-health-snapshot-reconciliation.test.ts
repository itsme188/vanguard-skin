import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getSnapshotReconciliation } from "@/lib/queries/data-health";

// QA finding: data-health-snapshot-reconciliation--30-of-311-no-disclosure-mostly-live-self-comparisons
//
// getSnapshotReconciliation joined ALL monthly_snapshots rows regardless of
// source, so a live (plaid/tws) snapshot was compared against the daily
// valuation computed FROM that same snapshot — a byte-identical
// self-comparison. Only statement-authority rows (source NOT IN
// excludeLiveSnapshotsSql's live list) can genuinely disagree with the
// computed total, so the query must exclude live sources entirely.

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (
    db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as {
      id: number;
    }
  ).id;
}

function seedSnapshot(
  accountId: number,
  monthEndDate: string,
  totalValue: number,
  source: string,
) {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, ?, ?)`,
  ).run(accountId, monthEndDate, totalValue, source);
}

function seedValuation(
  accountId: number,
  date: string,
  holdingsValue: number,
  cashBalance: number,
) {
  db.prepare(
    `INSERT OR REPLACE INTO daily_valuations
       (account_id, valuation_date, holdings_value, cash_balance, total_value)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(accountId, date, holdingsValue, cashBalance, holdingsValue + cashBalance);
}

describe("getSnapshotReconciliation — live-source exclusion", () => {
  it("returns only the statement-authority row, excluding the live-source row entirely", () => {
    // Two synthetic accounts, same month-end date: one statement-authority
    // snapshot ('canonical' — the real token lib/import/parsers/canonical-csv.ts
    // writes), one live snapshot ('plaid' — one of LIVE_SNAPSHOT_SOURCES in
    // lib/db/live-sources.ts). monthly_snapshots has UNIQUE(account_id,
    // month_end_date), so the two sources can't collide on one account —
    // this mirrors the real shape: many (account, date) pairs across the
    // table, most of them live self-comparisons.
    const statementAcct = seedAccount("Test Taxable");
    const liveAcct = seedAccount("Test IBKR Live");

    seedSnapshot(statementAcct, "2025-06-30", 100000, "canonical");
    seedValuation(statementAcct, "2025-06-30", 92000, 6000); // computed 98000

    seedSnapshot(liveAcct, "2025-06-30", 50000, "plaid");
    seedValuation(liveAcct, "2025-06-30", 45000, 5000); // computed 50000 — self-comparison

    const result = getSnapshotReconciliation(db);

    expect(result).toHaveLength(1);
    const row = result[0];
    expect(row.accountName).toBe("Test Taxable");
    expect(row.snapshotDate).toBe("2025-06-30");
    expect(row.snapshotTotal).toBe(100000);
    expect(row.computedTotal).toBe(98000);
    expect(row.difference).toBe(-2000);
    expect(row.diffPct).toBeCloseTo(-2.0, 1);

    // The live-sourced (account, date) pair never appears, under any name.
    expect(result.find((r) => r.accountName === "Test IBKR Live")).toBeUndefined();
  });

  // Landing review 2026-09-11: `monthly_snapshots.source` carries a
  // `DEFAULT 'manual'`, but SQLite bypasses a column default on an explicit
  // `INSERT NULL` (the same caveat that forces COALESCE(s.multiplier, 1)
  // everywhere). `NULL NOT IN ('tws','plaid')` evaluates to NULL — never
  // true — so the raw predicate silently dropped those rows from the panel:
  // a hand-entered snapshot is exactly the kind of row that CAN disagree
  // with the computed total, and it was the one class made invisible.
  it("includes a snapshot row whose source was written as an explicit NULL", () => {
    const acct = seedAccount("Test Explicit Null Source");
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
       VALUES (?, ?, ?, NULL)`,
    ).run(acct, "2025-08-31", 40000);
    seedValuation(acct, "2025-08-31", 35000, 2000); // computed 37000

    // Pin the premise: the explicit NULL really did bypass DEFAULT 'manual'.
    const stored = db
      .prepare("SELECT source FROM monthly_snapshots WHERE account_id = ?")
      .get(acct) as { source: string | null };
    expect(stored.source).toBeNull();

    const result = getSnapshotReconciliation(db);

    expect(result).toHaveLength(1);
    expect(result[0].accountName).toBe("Test Explicit Null Source");
    expect(result[0].snapshotTotal).toBe(40000);
    expect(result[0].computedTotal).toBe(37000);
    expect(result[0].difference).toBe(-3000);
  });

  it("still excludes live sources when a NULL-source row is present", () => {
    const nullAcct = seedAccount("Test Null Source");
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
       VALUES (?, ?, ?, NULL)`,
    ).run(nullAcct, "2025-08-31", 40000);
    seedValuation(nullAcct, "2025-08-31", 35000, 2000);

    const liveAcct = seedAccount("Test Plaid Live");
    seedSnapshot(liveAcct, "2025-08-31", 50000, "plaid");
    seedValuation(liveAcct, "2025-08-31", 45000, 5000);

    const names = getSnapshotReconciliation(db).map((r) => r.accountName);
    expect(names).toEqual(["Test Null Source"]);
  });

  it("returns an empty array when every monthly_snapshots row is live-sourced", () => {
    const acct = seedAccount("Test TWS Only");
    seedSnapshot(acct, "2025-07-31", 75000, "tws");
    seedValuation(acct, "2025-07-31", 70000, 5000);

    const result = getSnapshotReconciliation(db);

    expect(result).toEqual([]);
  });
});
