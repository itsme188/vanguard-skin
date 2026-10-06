/**
 * commitImport's DEFAULT (script) path must fail loudly on an unknown account
 * name: throw before any write — no import_batches row, no securities, no
 * transactions — naming every unknown account. Only the import route opts in
 * to excluding those rows (`excludeUnknownAccounts: true`), because its
 * preview already told the user they would be left out. CLI scripts
 * (import-canonical-files, import-real-data, repair-ibkr-option-trades,
 * rebuild-ibkr-ledger) must never partially commit on a typo'd account.
 * Synthetic fixture only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { commitImport } from "@/lib/import/engine";
import type { ParsedImportResult } from "@/lib/import/types";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db); // seeds accounts: IBKR, Vanguard Roth IRA, Vanguard Taxable
});

function mixedParsed(): ParsedImportResult {
  return {
    sourceType: "canonical-csv",
    sourceName: "synthetic.csv",
    transactions: [
      {
        accountName: "Vanguard Taxable",
        tradeDate: "2025-06-15",
        type: "BUY",
        symbol: "AAPL",
        quantity: 10,
        pricePerShare: 100,
        amount: -1000,
        sourceKey: "test:aapl:1",
      },
      {
        accountName: "Typo Account A",
        tradeDate: "2025-06-16",
        type: "BUY",
        symbol: "MSFT",
        quantity: 5,
        pricePerShare: 200,
        amount: -1000,
        sourceKey: "test:msft:1",
      },
    ],
    securities: [
      { symbol: "AAPL", name: "Apple Inc", securityType: "Stock" },
      { symbol: "MSFT", name: "Microsoft Corp", securityType: "Stock" },
    ],
    holdings: [
      {
        accountName: "Typo Account B",
        symbol: "MSFT",
        quantity: 5,
        asOfDate: "2025-06-30",
        sourceKey: "test:hold:msft",
      },
    ],
    prices: [],
    snapshots: [],
    corporateActions: [],
    errors: [],
    warnings: [],
  };
}

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

describe("commitImport — unknown account names", () => {
  it("default: throws naming EVERY unknown account and writes nothing", () => {
    const before = {
      batches: count("import_batches"),
      securities: count("securities"),
      transactions: count("transactions"),
      holdings: count("holdings"),
    };

    let message = "";
    try {
      commitImport(db, mixedParsed());
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("Typo Account A");
    expect(message).toContain("Typo Account B");
    expect(message).not.toContain("Unknown account(s): Vanguard Taxable");

    expect(count("import_batches")).toBe(before.batches);
    expect(count("securities")).toBe(before.securities);
    expect(count("transactions")).toBe(before.transactions);
    expect(count("holdings")).toBe(before.holdings);
  });

  it("default: a file whose accounts all resolve commits normally", () => {
    const parsed = mixedParsed();
    parsed.transactions = parsed.transactions.slice(0, 1);
    parsed.securities = parsed.securities.slice(0, 1);
    parsed.holdings = [];
    const r = commitImport(db, parsed);
    expect(r.newTransactions).toBe(1);
    expect(r.skippedRows).toEqual([]);
  });

  it("opt-in: excludes unknown-account rows, commits the rest, and does not upsert their securities", () => {
    const r = commitImport(db, mixedParsed(), { excludeUnknownAccounts: true });
    expect(r.newTransactions).toBe(1);
    expect(r.skippedRows.map((s) => s.category).sort()).toEqual(["holding", "transaction"]);
    expect(count("import_batches")).toBe(1);
    const syms = (db.prepare("SELECT symbol FROM securities ORDER BY symbol").all() as { symbol: string }[])
      .map((s) => s.symbol);
    expect(syms).toContain("AAPL");
    expect(syms).not.toContain("MSFT");
  });

  /**
   * QA 2026-10-02: a route import whose EVERY row named an unknown account
   * still created an empty import_batches row (an Undo-able ghost in Import
   * History) and let the route run the full post-commit pipeline. The opt-in
   * path now returns a no-op result (batchId null) when exclusion left
   * nothing to write.
   */
  it("opt-in: a file whose every row names an unknown account writes NOTHING (no batch, no raw_imports) and reports the skipped rows", () => {
    const parsed = mixedParsed();
    parsed.transactions = parsed.transactions.slice(1); // only "Typo Account A"
    parsed.securities = parsed.securities.slice(1); // only MSFT
    const before = {
      batches: count("import_batches"),
      maxBatchId: (db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM import_batches").get() as { m: number }).m,
      raw: count("raw_imports"),
      securities: count("securities"),
      transactions: count("transactions"),
      holdings: count("holdings"),
    };

    const r = commitImport(db, parsed, { excludeUnknownAccounts: true });

    expect(r.batchId).toBeNull();
    expect(r.recordCount).toBe(0);
    expect(r.newTransactions).toBe(0);
    expect(r.newHoldings).toBe(0);
    expect(r.newSecurities).toBe(0);
    expect(r.skippedRows.map((s) => s.category).sort()).toEqual(["holding", "transaction"]);
    expect(count("import_batches")).toBe(before.batches);
    expect(
      (db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM import_batches").get() as { m: number }).m,
    ).toBe(before.maxBatchId);
    expect(count("raw_imports")).toBe(before.raw);
    expect(count("securities")).toBe(before.securities);
    expect(count("transactions")).toBe(before.transactions);
    expect(count("holdings")).toBe(before.holdings);
  });

  it("default: a file whose every row names an unknown account still throws before writing", () => {
    const parsed = mixedParsed();
    parsed.transactions = parsed.transactions.slice(1);
    parsed.securities = parsed.securities.slice(1);
    const batches = count("import_batches");
    expect(() => commitImport(db, parsed)).toThrow(/Typo Account A/);
    expect(count("import_batches")).toBe(batches);
  });

  it("an empty file with NO excluded rows keeps today's behavior on both paths (a batch is created)", () => {
    const empty = (): ParsedImportResult => ({
      ...mixedParsed(),
      transactions: [],
      securities: [],
      holdings: [],
    });
    const scripted = commitImport(db, empty());
    expect(typeof scripted.batchId).toBe("number");
    const routed = commitImport(db, empty(), { excludeUnknownAccounts: true });
    expect(typeof routed.batchId).toBe("number");
    expect(count("import_batches")).toBe(2);
  });
});
