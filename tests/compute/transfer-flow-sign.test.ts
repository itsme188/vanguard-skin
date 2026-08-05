import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { fetchNetFlowsByDate } from "@/lib/compute/flow-adjusted";
import { computeTwr } from "@/lib/compute/twr";

// TRANSFER_OUT rows store the transfer-date market value as a positive
// magnitude (the type carries the direction, matching the ledger-rebuild
// parser and the quantity-always-positive convention). Every external-flow
// reader must sign them negative, or a paired internal journal (equal
// TRANSFER_IN + TRANSFER_OUT) reads as double inflow and scope-all TWR/MWR
// collapses while every per-account number stays positive
// (qa:analysis-performance--scope-all-twr-negative-transfer-flows-double-counted).

function seedTransfer(
  db: Database.Database,
  accountId: number,
  date: string,
  type: "TRANSFER_IN" | "TRANSFER_OUT",
  amount: number,
  key: string
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, 1, ?)`
  ).run(accountId, date, type, amount, key);
}

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEndDate: string,
  totalValue: number
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots
       (account_id, month_end_date, total_value, source)
     VALUES (?, ?, ?, 'manual')`
  ).run(accountId, monthEndDate, totalValue);
}

describe("external-flow sign for security transfers", () => {
  let db: Database.Database;
  const ACCT = 1;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("fetchNetFlowsByDate signs TRANSFER_OUT negative even when stored positive", () => {
    seedTransfer(db, ACCT, "2026-02-10", "TRANSFER_OUT", 50000, "t-out-solo");
    const flows = fetchNetFlowsByDate(db, [ACCT], "2026-01-31", "2026-02-28");
    expect(flows).toHaveLength(1);
    expect(flows[0].net).toBeCloseTo(-50000, 2);
  });

  it("fetchNetFlowsByDate nets a paired same-day TRANSFER_IN/TRANSFER_OUT to zero", () => {
    seedTransfer(db, ACCT, "2026-02-10", "TRANSFER_IN", 100000, "t-in-pair");
    seedTransfer(db, ACCT, "2026-02-10", "TRANSFER_OUT", 100000, "t-out-pair");
    const flows = fetchNetFlowsByDate(db, [ACCT], "2026-01-31", "2026-02-28");
    // HAVING SUM != 0 drops the fully-netted date
    expect(flows).toHaveLength(0);
  });

  it("portfolio TWR treats a paired internal transfer as a wash, not double inflow", () => {
    // Flat portfolio: 100k -> 100k with a paired 50k in/out journal mid-month.
    // Snapshot deposits_withdrawals is NULL so the portfolio path falls back to
    // the transactions flow query. Correct TWR is ~0%; the unsigned bug reads
    // +100k of flows and produces a deeply negative month.
    seedSnapshot(db, ACCT, "2026-01-31", 100000);
    seedSnapshot(db, ACCT, "2026-02-28", 100000);
    seedTransfer(db, ACCT, "2026-02-14", "TRANSFER_IN", 50000, "t-in-wash");
    seedTransfer(db, ACCT, "2026-02-14", "TRANSFER_OUT", 50000, "t-out-wash");

    const result = computeTwr(db);
    expect(result).not.toBeNull();
    expect(result!.totalReturn).toBeCloseTo(0, 3);
  });

  it("portfolio TWR treats a lone positive-amount TRANSFER_OUT as an outflow", () => {
    // 100k start, 50k transferred out (stored positive), 50k end => ~0% return.
    seedSnapshot(db, ACCT, "2026-01-31", 100000);
    seedSnapshot(db, ACCT, "2026-02-28", 50000);
    seedTransfer(db, ACCT, "2026-02-14", "TRANSFER_OUT", 50000, "t-out-real");

    const result = computeTwr(db);
    expect(result).not.toBeNull();
    expect(result!.totalReturn).toBeCloseTo(0, 2);
  });
});
