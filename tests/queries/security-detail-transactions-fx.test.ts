import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { getTransactionsBySecurity } from "@/lib/queries/security-detail";

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

describe("getTransactionsBySecurity FX conversion", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("converts a KRW transaction's price_per_share + amount to USD", () => {
    // Ledger repro: 402340 (KRW) — ₩1,632,000/share ×10 stored native;
    // pre-fix rendered as $1,632,000.00 / −$16,320,000.
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

    const [row] = getTransactionsBySecurity(db, krw);
    expect(row.price_per_share).toBeCloseTo(1_632_000 * 0.0006648, 2); // ~$1,085
    expect(row.amount).toBeCloseTo(-16_320_000 * 0.0006648, 2); // ~-$10,850
  });

  it("leaves a USD transaction byte-identical (rate 1 path)", () => {
    const aapl = seedSecurity(db, "AAPL", { currency: "USD" });
    seedTransaction(db, ACCOUNT_ID, aapl, { pricePerShare: 208, amount: -2080 });

    const [row] = getTransactionsBySecurity(db, aapl);
    expect(row.price_per_share).toBe(208);
    expect(row.amount).toBe(-2080);
  });

  it("never fabricates a rate — foreign currency with no fx_rates row passes through native", () => {
    const jpy = seedSecurity(db, "7203", { currency: "JPY" });
    seedTransaction(db, ACCOUNT_ID, jpy, { pricePerShare: 2500, amount: -25_000 });

    const [row] = getTransactionsBySecurity(db, jpy);
    expect(row.price_per_share).toBe(2500);
    expect(row.amount).toBe(-25_000);
  });

  it("preserves null money fields (no 0-coercion through the multiply)", () => {
    const krw = seedSecurity(db, "402340", { currency: "KRW" });
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, source_key)
       VALUES (?, ?, '2026-06-30', 'DIVIDEND', 'test:txn:null-fields')`
    ).run(ACCOUNT_ID, krw);
    upsertFxRate(db, {
      currency: "KRW",
      usdPerUnit: 0.0006648,
      asOf: "2026-06-30",
      source: "test",
    });

    const [row] = getTransactionsBySecurity(db, krw);
    expect(row.price_per_share).toBeNull();
    expect(row.amount).toBeNull();
  });
});
