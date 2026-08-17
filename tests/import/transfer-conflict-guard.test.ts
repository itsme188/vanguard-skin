import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { commitImport } from "@/lib/import/engine";
import { findTransferAmountConflicts } from "@/lib/import/donations-commit";
import { upsertSecurity } from "@/lib/mutations/securities";
import { parseCanonicalCsv } from "@/lib/import/parsers/canonical-csv";
import type { ParsedTransaction } from "@/lib/import/types";

const CSV_HEADER =
  "account,trade_date,settlement_date,type,symbol,security_name,security_type,quantity,price,amount,fees,notes";

// The seeded existing in-kind TRANSFER_OUT this whole file tests against:
// IBKR, AAPL, 2026-01-15, qty 50, amount 0 (a real in-kind transfer often
// carries amount=0 — the cash side, if any, is a separate leg).
const EXISTING_SOURCE_KEY = "canonical:txn:IBKR:AAPL:2026-01-15:TRANSFER_OUT:0";

describe("in-kind transfer-leg amount-conflict guard", () => {
  let db: Database.Database;
  let acctId: number;
  let secId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    secId = upsertSecurity(db, "AAPL", "Apple Inc", "Stock");
    acctId = (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;

    db.prepare(
      `INSERT INTO transactions
         (account_id, security_id, trade_date, type, quantity, amount, source_key, is_external_flow)
       VALUES (?, ?, '2026-01-15', 'TRANSFER_OUT', 50, 0, ?, 1)`,
    ).run(acctId, secId, EXISTING_SOURCE_KEY);
  });

  it("findTransferAmountConflicts flags only the incoming row whose amount disagrees with a matching existing row", () => {
    const txns: ParsedTransaction[] = [
      // conflict: same account/date/type/security/qty, different amount
      { accountName: "IBKR", tradeDate: "2026-01-15", type: "TRANSFER_OUT", symbol: "AAPL", quantity: 50, amount: 4550, sourceKey: "x1" },
      // no conflict: amount agrees with the existing row
      { accountName: "IBKR", tradeDate: "2026-01-15", type: "TRANSFER_OUT", symbol: "AAPL", quantity: 50, amount: 0, sourceKey: "x2" },
      // no conflict: quantity doesn't match any existing row
      { accountName: "IBKR", tradeDate: "2026-01-15", type: "TRANSFER_OUT", symbol: "AAPL", quantity: 75, amount: 6000, sourceKey: "x3" },
    ];

    const conflicts = findTransferAmountConflicts(
      db,
      txns,
      () => acctId,
      () => secId,
    );
    expect(conflicts).toEqual([0]);
  });

  it("a re-authored row (same tuple, different amount) is skipped at commit with a conflict warning; transactions count unchanged", () => {
    const csv = `${CSV_HEADER}\nIBKR,2026-01-15,,TRANSFER_OUT,AAPL,Apple Inc,Stock,50,,4550,0,`;
    const parsed = parseCanonicalCsv(csv, "reauthored.csv");
    const result = commitImport(db, parsed);

    expect(result.newTransactions).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM transactions").get() as { c: number }).c).toBe(1);
    expect(result.warnings.some((w) => w.toLowerCase().includes("conflict"))).toBe(true);

    const row = db
      .prepare("SELECT amount FROM transactions WHERE source_key = ?")
      .get(EXISTING_SOURCE_KEY) as { amount: number };
    expect(row.amount).toBe(0); // untouched
  });

  it("the SAME row re-imported with the SAME amount is a normal dedupe no-op (existing behavior unchanged)", () => {
    const csv = `${CSV_HEADER}\nIBKR,2026-01-15,,TRANSFER_OUT,AAPL,Apple Inc,Stock,50,,0,0,`;
    const parsed = parseCanonicalCsv(csv, "same.csv");
    const result = commitImport(db, parsed);

    expect(result.newTransactions).toBe(0);
    expect(result.skippedDuplicates).toBeGreaterThan(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM transactions").get() as { c: number }).c).toBe(1);
    expect(result.warnings.some((w) => w.toLowerCase().includes("conflict"))).toBe(false);
  });

  it("a different-quantity row inserts normally (not treated as a conflict)", () => {
    const csv = `${CSV_HEADER}\nIBKR,2026-01-15,,TRANSFER_OUT,AAPL,Apple Inc,Stock,75,,6000,0,`;
    const parsed = parseCanonicalCsv(csv, "diffqty.csv");
    const result = commitImport(db, parsed);

    expect(result.newTransactions).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS c FROM transactions").get() as { c: number }).c).toBe(2);
    expect(result.warnings.some((w) => w.toLowerCase().includes("conflict"))).toBe(false);
  });
});
