import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getTransactionsByAccount } from "@/lib/queries/transactions";

/**
 * QA regression (accounts-transactions--reconcile-close-synthetic-listed-
 * as-user-activity-regression-1): the Accounts page "Recent Transactions"
 * list rendered engine-owned RECONCILE_CLOSE rows (lib/compute/tax-lots.ts)
 * with the same chip treatment and dollar amounts as real BUY/SELL/DIVIDEND
 * activity, actively misleading the user into thinking they traded shares
 * they never traded. CLAUDE.md invariant: "RECONCILE_CLOSE is engine-owned:
 * never parse, emit, or treat it as user activity."
 */

function seedSecurity(db: Database.Database, symbol: string): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name) VALUES (?, ?)")
    .run(symbol, `${symbol} Corp`);
  return result.lastInsertRowid as number;
}

function seedTransaction(
  db: Database.Database,
  accountId: number,
  securityId: number,
  opts: { type: string; quantity: number; amount: number; tradeDate?: string }
): void {
  db.prepare(
    `INSERT INTO transactions
       (account_id, security_id, trade_date, type, quantity, amount, price_per_share, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    accountId,
    securityId,
    opts.tradeDate ?? "2026-06-29",
    opts.type,
    opts.quantity,
    opts.amount,
    Math.abs(opts.amount) / opts.quantity,
    `test:txn:${accountId}:${securityId}:${opts.type}:${opts.tradeDate ?? "2026-06-29"}`
  );
}

describe("getTransactionsByAccount excludes engine-owned RECONCILE_CLOSE rows", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 3;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns BUY/SELL/DIVIDEND rows but never a RECONCILE_CLOSE row", () => {
    const mdb = seedSecurity(db, "MDB");
    seedTransaction(db, ACCOUNT_ID, mdb, {
      type: "BUY",
      quantity: 100,
      amount: -20_000,
      tradeDate: "2026-01-05",
    });
    seedTransaction(db, ACCOUNT_ID, mdb, {
      type: "SELL",
      quantity: 40,
      amount: 9_000,
      tradeDate: "2026-03-10",
    });
    seedTransaction(db, ACCOUNT_ID, mdb, {
      type: "DIVIDEND",
      quantity: 0,
      amount: 50,
      tradeDate: "2026-04-01",
    });
    // Engine-synthesized row — never user activity.
    seedTransaction(db, ACCOUNT_ID, mdb, {
      type: "RECONCILE_CLOSE",
      quantity: 60,
      amount: 0,
      tradeDate: "2026-06-15",
    });

    const rows = getTransactionsByAccount(db, ACCOUNT_ID);

    expect(rows.some((r) => r.type === "RECONCILE_CLOSE")).toBe(false);
    const types = rows.map((r) => r.type).sort();
    expect(types).toEqual(["BUY", "DIVIDEND", "SELL"]);
  });
});
