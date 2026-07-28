import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { getTransactionsByAccount } from "@/lib/queries/transactions";

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts: { currency?: string } = {}
): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name, currency) VALUES (?, ?, ?)")
    .run(symbol, `${symbol} Corp`, opts.currency ?? "USD");
  return result.lastInsertRowid as number;
}

function seedTransaction(
  db: Database.Database,
  accountId: number,
  securityId: number,
  opts: { pricePerShare: number; amount: number; quantity?: number }
): void {
  db.prepare(
    `INSERT INTO transactions
       (account_id, security_id, trade_date, type, quantity, amount, price_per_share, source_key)
     VALUES (?, ?, '2026-06-29', 'BUY', ?, ?, ?, ?)`
  ).run(
    accountId,
    securityId,
    opts.quantity ?? 10,
    opts.amount,
    opts.pricePerShare,
    `test:txn:${accountId}:${securityId}:${opts.amount}`
  );
}

// Accounts-page sibling of tests/queries/security-detail-transactions-fx.test.ts:
// the a703773 fix covered only Security Detail; the Accounts Recent
// Transactions query rendered the same KRW rows as raw USD (deep-QA
// 2026-07-28: −$16,320,000 shown for a −$10,850 buy).
describe("getTransactionsByAccount FX conversion", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("converts a KRW transaction's price_per_share + amount to USD", () => {
    const krw = seedSecurity(db, "402340", { currency: "KRW" });
    seedTransaction(db, ACCOUNT_ID, krw, {
      pricePerShare: 1_632_000,
      amount: -16_320_000,
    });
    upsertFxRate(db, {
      currency: "KRW",
      usdPerUnit: 0.0006648,
      asOf: "2026-06-29",
      source: "test",
    });

    const [row] = getTransactionsByAccount(db, ACCOUNT_ID);
    expect(row.price_per_share).toBeCloseTo(1_632_000 * 0.0006648, 2); // ~$1,085
    expect(row.amount).toBeCloseTo(-16_320_000 * 0.0006648, 2); // ~-$10,850
  });

  it("leaves a USD transaction byte-identical (rate 1 path)", () => {
    const aapl = seedSecurity(db, "AAPL", { currency: "USD" });
    seedTransaction(db, ACCOUNT_ID, aapl, { pricePerShare: 208, amount: -2080 });

    const [row] = getTransactionsByAccount(db, ACCOUNT_ID);
    expect(row.price_per_share).toBe(208);
    expect(row.amount).toBe(-2080);
  });

  it("never fabricates a rate — foreign currency with no fx_rates row passes through native", () => {
    const jpy = seedSecurity(db, "7203", { currency: "JPY" });
    seedTransaction(db, ACCOUNT_ID, jpy, { pricePerShare: 2500, amount: -25_000 });

    const [row] = getTransactionsByAccount(db, ACCOUNT_ID);
    expect(row.price_per_share).toBe(2500);
    expect(row.amount).toBe(-25_000);
  });

  it("cash rows with no security (symbol CASH-less NULL security_id) survive the join", () => {
    db.prepare(
      `INSERT INTO transactions (account_id, trade_date, type, amount, source_key)
       VALUES (?, '2026-06-30', 'DEPOSIT', 5000, 'test:txn:cash-deposit')`
    ).run(ACCOUNT_ID);

    const [row] = getTransactionsByAccount(db, ACCOUNT_ID);
    expect(row.amount).toBe(5000);
    expect(row.symbol).toBeNull();
  });
});
