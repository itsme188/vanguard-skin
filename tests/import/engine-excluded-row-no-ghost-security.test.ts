/**
 * QA finding import-undo--ghost-securities-survive-searchable-regression-1:
 * a row the preview excludes (here an invalid trade date) must never mint a
 * securities row at commit. Before the fix the securities step upserted the
 * whole parsed set, so the excluded row's symbol was created, referenced by
 * nothing, and survived undo as a searchable ghost. Synthetic symbols only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { commitImport, undoImport } from "@/lib/import/engine";
import type { ParsedImportResult } from "@/lib/import/types";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db); // seeds accounts: IBKR, Vanguard Roth IRA, Vanguard Taxable
});

function symbolCount(symbol: string): number {
  return (
    db.prepare("SELECT COUNT(*) AS c FROM securities WHERE symbol = ?").get(symbol) as {
      c: number;
    }
  ).c;
}

function parsedWithInvalidRow(): ParsedImportResult {
  return {
    sourceType: "canonical-csv",
    sourceName: "synthetic-transactions.csv",
    transactions: [
      {
        accountName: "Vanguard Taxable",
        tradeDate: "2025-06-15",
        type: "BUY",
        symbol: "ZZQA",
        quantity: 10,
        pricePerShare: 100,
        amount: -1000,
        sourceKey: "test:zzqa:1",
      },
      {
        accountName: "Vanguard Taxable",
        tradeDate: "not-a-date",
        type: "BUY",
        symbol: "ZZQB",
        quantity: 10,
        pricePerShare: 100,
        amount: -1000,
        sourceKey: "test:zzqb:1",
      },
    ],
    securities: [
      { symbol: "ZZQA", name: "Synthetic A", securityType: "Stock" },
      { symbol: "ZZQB", name: "Synthetic B", securityType: "Stock" },
    ],
    holdings: [],
    prices: [],
    snapshots: [],
    corporateActions: [],
    errors: [],
    warnings: [],
  };
}

describe("commitImport — an excluded row never mints a security", () => {
  const commits: Array<[string, () => { newTransactions: number; newSecurities: number; skippedRows: { category: string }[] }]> = [
    ["route path", () => commitImport(db, parsedWithInvalidRow(), { excludeUnknownAccounts: true })],
    ["script path", () => commitImport(db, parsedWithInvalidRow())],
  ];
  for (const [label, run] of commits) {
    it(`${label}: invalid-date row's symbol is not created`, () => {
      const r = run();
      expect(r.newTransactions).toBe(1);
      expect(r.skippedRows.map((s) => s.category)).toEqual(["transaction"]);
      expect(symbolCount("ZZQA")).toBe(1);
      expect(symbolCount("ZZQB")).toBe(0);
      expect(r.newSecurities).toBe(1);
    });
  }

  it("undo then removes every security the batch created", () => {
    const r = commitImport(db, parsedWithInvalidRow(), { excludeUnknownAccounts: true });
    expect(r.batchId).not.toBeNull();
    undoImport(db, r.batchId as number);
    expect(symbolCount("ZZQA")).toBe(0);
    expect(symbolCount("ZZQB")).toBe(0);
  });

  it("a security referenced only by a holdings row is still minted", () => {
    const parsed = parsedWithInvalidRow();
    parsed.holdings = [
      {
        accountName: "Vanguard Taxable",
        symbol: "ZZQC",
        quantity: 10,
        asOfDate: "2025-06-30",
        sourceKey: "test:hold:zzqc",
      },
    ];
    parsed.securities.push({ symbol: "ZZQC", name: "Synthetic C", securityType: "ETF" });
    const r = commitImport(db, parsed, { excludeUnknownAccounts: true });
    expect(r.newHoldings).toBe(1);
    expect(symbolCount("ZZQC")).toBe(1);
    expect(symbolCount("ZZQB")).toBe(0);
    const row = db
      .prepare("SELECT name FROM securities WHERE symbol = 'ZZQC'")
      .get() as { name: string };
    expect(row.name).toBe("Synthetic C");
    expect(r.newSecurities).toBe(2);
  });
});
