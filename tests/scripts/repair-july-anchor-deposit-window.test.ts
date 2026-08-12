// Pins the July-2026 anchor-window deposit repair: rows carrying the exact
// stale plug cash ($[REDACTED]) inside 2026-07-02..07-10 get +$40k on BOTH
// cash_balance and total_value; anything else — other accounts, dates
// outside the window, rows whose cash already moved off the plug — is
// untouched, and a second apply run is a no-op (idempotence via the plug
// precondition, not a marker table).
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  findRepairRows,
  runRepair,
} from "../../scripts/repair-july-2026-anchor-deposit-window";

const PLUG = [REDACTED];

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE daily_valuations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      valuation_date TEXT NOT NULL,
      total_value REAL NOT NULL,
      cash_balance REAL NOT NULL
    );
  `);
  const ins = db.prepare(
    `INSERT INTO daily_valuations (account_id, valuation_date, total_value, cash_balance) VALUES (?, ?, ?, ?)`
  );
  // In-window stale-plug rows (the real shape: no 07-02 row exists).
  ins.run(1, "2026-07-03", [REDACTED], PLUG);
  ins.run(1, "2026-07-06", [REDACTED], PLUG);
  ins.run(1, "2026-07-10", [REDACTED], PLUG);
  // Pre-window row with the same plug — must NOT be touched (deposit not yet arrived).
  ins.run(1, "2026-07-01", 1484284.34, PLUG);
  // Post-window Plaid-anchored row — must NOT be touched.
  ins.run(1, "2026-07-11", [REDACTED], [REDACTED]);
  // Other account inside the window — must NOT be touched.
  ins.run(2, "2026-07-06", 500000, PLUG);
  return db;
}

describe("repair-july-2026-anchor-deposit-window", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it("finds only account-1 stale-plug rows inside the window", () => {
    const rows = findRepairRows(db);
    expect(rows.map((r) => r.valuation_date)).toEqual([
      "2026-07-03",
      "2026-07-06",
      "2026-07-10",
    ]);
  });

  it("dry-run writes nothing", () => {
    runRepair(db, false);
    const row = db
      .prepare(
        `SELECT cash_balance FROM daily_valuations WHERE account_id=1 AND valuation_date='2026-07-03'`
      )
      .get() as { cash_balance: number };
    expect(row.cash_balance).toBeCloseTo(PLUG, 2);
  });

  it("apply adds $40k to cash AND total on window rows only, and is idempotent", () => {
    const first = runRepair(db, true);
    expect(first.candidates).toHaveLength(3);

    const after = db
      .prepare(
        `SELECT valuation_date, total_value, cash_balance FROM daily_valuations WHERE account_id=1 ORDER BY valuation_date`
      )
      .all() as { valuation_date: string; total_value: number; cash_balance: number }[];
    const byDate = Object.fromEntries(after.map((r) => [r.valuation_date, r]));

    expect(byDate["2026-07-03"].cash_balance).toBeCloseTo(PLUG + 40000, 2);
    expect(byDate["2026-07-03"].total_value).toBeCloseTo([REDACTED] + 40000, 2);
    expect(byDate["2026-07-10"].cash_balance).toBeCloseTo(PLUG + 40000, 2);
    // Untouched: pre-window, post-window, other account.
    expect(byDate["2026-07-01"].cash_balance).toBeCloseTo(PLUG, 2);
    expect(byDate["2026-07-11"].cash_balance).toBeCloseTo([REDACTED], 2);
    const other = db
      .prepare(`SELECT cash_balance FROM daily_valuations WHERE account_id=2`)
      .get() as { cash_balance: number };
    expect(other.cash_balance).toBeCloseTo(PLUG, 2);

    // Second run: the plug precondition no longer matches — no-op.
    const second = runRepair(db, true);
    expect(second.candidates).toHaveLength(0);
  });
});
