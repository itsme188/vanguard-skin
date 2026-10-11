import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getTransactionsBySecurity,
  getRelatedOptionTransactions,
  countTransactionsBySecurity,
  countRelatedOptionTransactions,
} from "@/lib/queries/security-detail";

let seq = 0;
function seedSecurity(db: Database.Database, symbol: string, type: string, underlying: string | null = null): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, underlying_symbol) VALUES (?, ?, ?, ?)")
    .run(symbol, `${symbol} Corp`, type, underlying).lastInsertRowid as number;
}
function seedTxn(db: Database.Database, securityId: number, type = "BUY"): void {
  seq += 1;
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, price_per_share, source_key)
     VALUES (1, ?, '2026-06-29', ?, 10, 100, 10, ?)`
  ).run(securityId, type, `test:count:${seq}`);
}

describe("security-detail transaction count readers", () => {
  let db: Database.Database;
  let aaa: number;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    aaa = seedSecurity(db, "AAA", "Stock");
    const zzz = seedSecurity(db, "ZZZ", "Stock");
    const o1 = seedSecurity(db, "AAA  261218C00100000", "Option", "AAA");
    const o2 = seedSecurity(db, "AAA  261218P00100000", "Option", "AAA");
    const o3 = seedSecurity(db, "AAA  270115C00100000", "Option", null); // prefix rule only
    const oz = seedSecurity(db, "ZZZ  261218C00100000", "Option", "ZZZ");
    for (let i = 0; i < 7; i++) seedTxn(db, aaa);
    for (let i = 0; i < 2; i++) seedTxn(db, zzz);
    seedTxn(db, o1);
    seedTxn(db, o1);
    seedTxn(db, o2);
    seedTxn(db, o3);
    seedTxn(db, oz);
  });

  it("counts the stock and related-option rows with the list predicates", () => {
    expect(countTransactionsBySecurity(db, aaa)).toBe(7);
    expect(countRelatedOptionTransactions(db, "AAA")).toBe(4);
  });

  it("keeps the list capped while the count stays true", () => {
    expect(getTransactionsBySecurity(db, aaa, 5)).toHaveLength(5);
    expect(getRelatedOptionTransactions(db, "AAA", 2)).toHaveLength(2);
    expect(countTransactionsBySecurity(db, aaa)).toBe(7);
    expect(countRelatedOptionTransactions(db, "AAA")).toBe(4);
  });
});

describe("TransactionsSection reads the true totals", () => {
  const src = readFileSync("app/dashboard/components/TransactionsSection.tsx", "utf8");
  it("takes total props and does not count the capped arrays for the header or chips", () => {
    expect(src).toContain("stockTotal");
    expect(src).toContain("optionTotal");
    expect(src).not.toMatch(/of \{all\.length\}/);
  });
});
