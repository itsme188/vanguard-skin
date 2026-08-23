import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { fetchInKindFlowsByDate } from "@/lib/compute/flow-adjusted";
import {
  isAnnualSummaryRow,
  fetchMonthSnapshot,
  fetchPriorMonthTotal,
} from "@/lib/compute/monthly-snapshot-utils";

// Shared Dietz primitives (Task 11) — extracted from twr.ts so the
// independent Modified Dietz module (Task 12) can consume them without
// re-deriving the same annual-summary detection / month-lookup logic.

// ─── Seed helpers ───────────────────────────────────────────────────

function seedSecurity(db: Database.Database, id: number, symbol: string): void {
  db.prepare(`INSERT INTO securities (id, symbol) VALUES (?, ?)`).run(id, symbol);
}

/** In-kind transfer leg: security_id set, FMV stored positive (type carries
 *  direction — SIGNED_EXTERNAL_FLOW_SQL signs TRANSFER_OUT negative). */
function seedInKindTransfer(
  db: Database.Database,
  accountId: number,
  securityId: number,
  date: string,
  type: "TRANSFER_IN" | "TRANSFER_OUT",
  fmv: number,
  key: string
): void {
  db.prepare(
    `INSERT INTO transactions
       (account_id, security_id, trade_date, type, amount, is_external_flow, source_key)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(accountId, securityId, date, type, fmv, key);
}

/** Cash TRANSFER_IN/OUT leg: no security_id — NOT in-kind. */
function seedCashTransfer(
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

function seedCashFlow(
  db: Database.Database,
  accountId: number,
  date: string,
  type: string,
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
  totalValue: number,
  opts: {
    startingValue?: number;
    twr?: number;
    depositsWithdrawals?: number;
    source?: string;
  } = {}
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots
       (account_id, month_end_date, total_value, starting_value, twr, deposits_withdrawals, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    accountId,
    monthEndDate,
    totalValue,
    opts.startingValue ?? null,
    opts.twr ?? null,
    opts.depositsWithdrawals ?? null,
    opts.source ?? "manual"
  );
}

describe("monthly-snapshot-utils / flow-adjusted Dietz primitives", () => {
  let db: Database.Database;
  const ACCT = 1; // Vanguard Taxable (seeded by migration 002)

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedSecurity(db, 1, "AAPL");
  });

  // ─── fetchInKindFlowsByDate (flow-adjusted.ts) ───────────────────

  describe("fetchInKindFlowsByDate", () => {
    it("returns only TRANSFER legs with security_id set, signed via SIGNED_EXTERNAL_FLOW_SQL", () => {
      seedInKindTransfer(db, ACCT, 1, "2026-02-10", "TRANSFER_IN", 20000, "in-1");
      seedInKindTransfer(db, ACCT, 1, "2026-02-14", "TRANSFER_OUT", 5000, "out-1");
      // Not in-kind: a cash transfer (no security_id) — excluded.
      seedCashTransfer(db, ACCT, "2026-02-16", "TRANSFER_IN", 9000, "cash-1");
      // Not in-kind: an ordinary external flow — excluded.
      seedCashFlow(db, ACCT, "2026-02-18", "DEPOSIT", 3000, "dep-1");

      const flows = fetchInKindFlowsByDate(db, [ACCT], "2026-01-31", "2026-02-28");

      expect(flows).toEqual([
        { date: "2026-02-10", net: 20000 },
        { date: "2026-02-14", net: -5000 }, // TRANSFER_OUT signed negative
      ]);
    });

    it("bounds results to the half-open (startDate, endDate] window", () => {
      seedInKindTransfer(db, ACCT, 1, "2026-01-31", "TRANSFER_IN", 1000, "on-start");
      seedInKindTransfer(db, ACCT, 1, "2026-02-01", "TRANSFER_IN", 2000, "day-after-start");
      seedInKindTransfer(db, ACCT, 1, "2026-02-28", "TRANSFER_IN", 3000, "on-end");
      seedInKindTransfer(db, ACCT, 1, "2026-03-01", "TRANSFER_IN", 4000, "after-end");

      const flows = fetchInKindFlowsByDate(db, [ACCT], "2026-01-31", "2026-02-28");

      expect(flows).toEqual([
        { date: "2026-02-01", net: 2000 },
        { date: "2026-02-28", net: 3000 },
      ]);
    });

    it("nets a paired same-day TRANSFER_IN/TRANSFER_OUT to zero and drops the date", () => {
      seedInKindTransfer(db, ACCT, 1, "2026-02-14", "TRANSFER_IN", 5000, "wash-in");
      seedInKindTransfer(db, ACCT, 1, "2026-02-14", "TRANSFER_OUT", 5000, "wash-out");

      const flows = fetchInKindFlowsByDate(db, [ACCT], "2026-01-31", "2026-02-28");

      expect(flows).toEqual([]);
    });

    it("filters to the given accountIds", () => {
      seedInKindTransfer(db, 1, 1, "2026-02-10", "TRANSFER_IN", 1000, "a1");
      seedInKindTransfer(db, 2, 1, "2026-02-10", "TRANSFER_IN", 2000, "a2");

      const flows = fetchInKindFlowsByDate(db, [1], "2026-01-31", "2026-02-28");

      expect(flows).toEqual([{ date: "2026-02-10", net: 1000 }]);
    });

    it("returns [] when the transactions table doesn't exist", () => {
      const bare = new Database(":memory:");
      expect(fetchInKindFlowsByDate(bare, null, "2026-01-01", "2026-12-31")).toEqual([]);
    });
  });

  // ─── isAnnualSummaryRow (monthly-snapshot-utils.ts) ──────────────

  describe("isAnnualSummaryRow", () => {
    it("returns true for a December row whose starting_value diverges >10% from the prior month total", () => {
      // Mirrors twr.ts:296-301 exactly: Nov total 350000, Dec starting_value
      // 300000 (year-start) — divergence is 50000 / 350000 ≈ 14.3% > 10%.
      const result = isAnnualSummaryRow(
        { month_end_date: "2025-12-31", starting_value: 300000 },
        350000
      );
      expect(result).toBe(true);
    });

    it("returns false for a December row within the 10% threshold", () => {
      const result = isAnnualSummaryRow(
        { month_end_date: "2025-12-31", starting_value: 340000 },
        350000
      );
      // 10000 / 350000 ≈ 2.9% <= 10%
      expect(result).toBe(false);
    });

    it("returns false at exactly the 10% boundary (strict > threshold)", () => {
      const result = isAnnualSummaryRow(
        { month_end_date: "2025-12-31", starting_value: 315000 },
        350000
      );
      // 35000 / 350000 = exactly 10% — twr.ts uses a strict > comparison
      expect(result).toBe(false);
    });

    it("returns false for any non-December month regardless of divergence", () => {
      const result = isAnnualSummaryRow(
        { month_end_date: "2025-11-30", starting_value: 100000 },
        350000
      );
      expect(result).toBe(false);
    });

    it("returns false when priorMonthTotal is null", () => {
      const result = isAnnualSummaryRow(
        { month_end_date: "2025-12-31", starting_value: 300000 },
        null
      );
      expect(result).toBe(false);
    });

    it("returns false when starting_value is null", () => {
      const result = isAnnualSummaryRow(
        { month_end_date: "2025-12-31", starting_value: null },
        350000
      );
      expect(result).toBe(false);
    });
  });

  // ─── fetchMonthSnapshot / fetchPriorMonthTotal (monthly-snapshot-utils.ts) ──

  describe("fetchMonthSnapshot", () => {
    it("returns the snapshot row for the given account + month", () => {
      seedSnapshot(db, ACCT, "2026-02-28", 355000, {
        startingValue: 350000,
        twr: 0.0143,
        depositsWithdrawals: 1000,
      });

      const row = fetchMonthSnapshot(db, ACCT, "2026-02-28");

      expect(row).toEqual({
        month_end_date: "2026-02-28",
        total_value: 355000,
        starting_value: 350000,
        twr: 0.0143,
        deposits_withdrawals: 1000,
        source: "manual",
      });
    });

    it("returns null when no snapshot exists for that month", () => {
      expect(fetchMonthSnapshot(db, ACCT, "2026-02-28")).toBeNull();
    });

    it("excludes a seeded source='tws' row", () => {
      seedSnapshot(db, ACCT, "2026-02-28", 355000, { source: "tws" });
      expect(fetchMonthSnapshot(db, ACCT, "2026-02-28")).toBeNull();
    });

    it("excludes a seeded source='plaid' row", () => {
      seedSnapshot(db, ACCT, "2026-02-28", 355000, { source: "plaid" });
      expect(fetchMonthSnapshot(db, ACCT, "2026-02-28")).toBeNull();
    });
  });

  describe("fetchPriorMonthTotal", () => {
    it("returns the exact adjacent prior calendar month-end's total_value", () => {
      seedSnapshot(db, ACCT, "2026-01-31", 340000);
      seedSnapshot(db, ACCT, "2026-02-28", 355000);

      expect(fetchPriorMonthTotal(db, ACCT, "2026-02-28")).toBe(340000);
    });

    it("returns null when the intervening month is missing (never bridges a gap)", () => {
      // December seeded, but January is missing — February's "prior month"
      // must NOT silently fall back to December.
      seedSnapshot(db, ACCT, "2025-12-31", 300000);
      seedSnapshot(db, ACCT, "2026-02-28", 355000);

      expect(fetchPriorMonthTotal(db, ACCT, "2026-02-28")).toBeNull();
    });

    it("returns null when there is no prior snapshot at all", () => {
      seedSnapshot(db, ACCT, "2026-02-28", 355000);
      expect(fetchPriorMonthTotal(db, ACCT, "2026-02-28")).toBeNull();
    });

    it("excludes a seeded source='tws' prior-month row", () => {
      seedSnapshot(db, ACCT, "2026-01-31", 340000, { source: "tws" });
      seedSnapshot(db, ACCT, "2026-02-28", 355000);

      expect(fetchPriorMonthTotal(db, ACCT, "2026-02-28")).toBeNull();
    });

    it("handles the January → prior-December year boundary", () => {
      seedSnapshot(db, ACCT, "2025-12-31", 300000);
      seedSnapshot(db, ACCT, "2026-01-31", 310000);

      expect(fetchPriorMonthTotal(db, ACCT, "2026-01-31")).toBe(300000);
    });
  });
});
