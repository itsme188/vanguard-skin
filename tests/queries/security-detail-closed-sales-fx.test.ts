/**
 * lib/queries/security-detail.ts — getClosedSalesBySecurity FX conversion.
 *
 * QA finding: security-detail-recent-sales--krw-native-proceeds-and-realized-rendered-as-usd
 * (HIGH). Recent Sales rendered a non-USD sale's proceeds/realized gain at
 * native magnitude with a "$" prefix. This mirrors the sibling FX suite for
 * getTransactionsBySecurity (tests/queries/security-detail-transactions-fx.test.ts):
 * a non-USD security with an fx_rates row converts every money column, a USD
 * security is untouched, and a non-USD security with no fx_rates row falls
 * back to native (x1.0) rather than fabricating a rate.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { getClosedSalesBySecurity } from "@/lib/queries/security-detail";

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts: { currency?: string } = {}
): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'Stock', ?)"
    )
    .run(symbol, `${symbol} Corp`, opts.currency ?? "USD");
  return result.lastInsertRowid as number;
}

function seedBuy(
  db: Database.Database,
  accountId: number,
  securityId: number,
  date: string,
  qty: number,
  price: number
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
     VALUES (?, ?, ?, 'BUY', ?, ?, ?, ?)`
  ).run(accountId, securityId, date, qty, price, -(qty * price), `buy-${securityId}-${date}`);
}

function seedSell(
  db: Database.Database,
  accountId: number,
  securityId: number,
  date: string,
  qty: number,
  price: number
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
     VALUES (?, ?, ?, 'SELL', ?, ?, ?, ?)`
  ).run(accountId, securityId, date, qty, price, qty * price, `sell-${securityId}-${date}`);
}

describe("getClosedSalesBySecurity FX conversion", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("converts every money column for a non-USD sale with an fx_rates row", () => {
    const sec = seedSecurity(db, "402340", { currency: "KRW" });
    seedBuy(db, ACCOUNT_ID, sec, "2025-01-15", 10, 1000);
    seedSell(db, ACCOUNT_ID, sec, "2025-02-15", 10, 1300);
    computeTaxLots(db);
    upsertFxRate(db, {
      currency: "KRW",
      usdPerUnit: 0.001,
      asOf: "2025-02-15",
      source: "test",
    });

    const [sale] = getClosedSalesBySecurity(db, sec);
    expect(sale.acquisition_price).toBeCloseTo(1000 * 0.001, 6); // 1.0
    expect(sale.sale_price).toBeCloseTo(1300 * 0.001, 6); // 1.3
    expect(sale.proceeds).toBeCloseTo(13_000 * 0.001, 6); // 13
    expect(sale.cost_basis_allocated).toBeCloseTo(10_000 * 0.001, 6); // 10
    expect(sale.realized_gain_loss).toBeCloseTo(3_000 * 0.001, 6); // 3
  });

  it("leaves a USD sale byte-identical (rate 1 path)", () => {
    const sec = seedSecurity(db, "AAPL", { currency: "USD" });
    seedBuy(db, ACCOUNT_ID, sec, "2025-01-15", 10, 100);
    seedSell(db, ACCOUNT_ID, sec, "2025-02-15", 10, 130);
    computeTaxLots(db);

    const [sale] = getClosedSalesBySecurity(db, sec);
    expect(sale.acquisition_price).toBe(100);
    expect(sale.sale_price).toBe(130);
    expect(sale.proceeds).toBe(1300);
    expect(sale.cost_basis_allocated).toBe(1000);
    expect(sale.realized_gain_loss).toBe(300);
  });

  it("never fabricates a rate — non-USD security with no fx_rates row passes through native", () => {
    const sec = seedSecurity(db, "7203", { currency: "JPY" });
    seedBuy(db, ACCOUNT_ID, sec, "2025-01-15", 10, 2500);
    seedSell(db, ACCOUNT_ID, sec, "2025-02-15", 10, 3000);
    computeTaxLots(db);

    const [sale] = getClosedSalesBySecurity(db, sec);
    expect(sale.acquisition_price).toBe(2500);
    expect(sale.sale_price).toBe(3000);
    expect(sale.proceeds).toBe(30_000);
    expect(sale.cost_basis_allocated).toBe(25_000);
    expect(sale.realized_gain_loss).toBe(5_000);
  });
});
