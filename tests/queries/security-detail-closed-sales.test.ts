/**
 * lib/queries/security-detail.ts — getClosedSalesBySecurity.
 *
 * finding 1 (number-trust durable fixes): mirrors the same
 * is_synthetic_close coverage as tests/queries/tax-lots.test.ts's
 * getClosedTaxLotSales suite — the Security Detail page's "Recent Sales"
 * table reads through this function, so it needs the same RECONCILE_CLOSE
 * flag to render the "estimated" label.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getClosedSalesBySecurity } from "@/lib/queries/security-detail";

function seedSecurity(db: Database.Database, symbol: string): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')")
    .run(symbol, `${symbol} Corp`);
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

describe("getClosedSalesBySecurity", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("exposes is_synthetic_close: true for a RECONCILE_CLOSE-sourced sale, false for a real sale", () => {
    const sec = seedSecurity(db, "VTI");
    seedBuy(db, ACCOUNT_ID, sec, "2025-01-15", 100, 200);
    seedSell(db, ACCOUNT_ID, sec, "2025-02-15", 30, 220); // real sale
    seedSell(db, ACCOUNT_ID, sec, "2025-03-01", 30, 230); // will become RECONCILE_CLOSE
    computeTaxLots(db);

    db.prepare(
      `UPDATE transactions SET type = 'RECONCILE_CLOSE'
       WHERE id = (
         SELECT sale_transaction_id FROM tax_lot_sales WHERE sale_date = '2025-03-01'
       )`
    ).run();

    const sales = getClosedSalesBySecurity(db, sec);
    expect(sales).toHaveLength(2);
    const real = sales.find((s) => s.sale_date === "2025-02-15")!;
    const synthetic = sales.find((s) => s.sale_date === "2025-03-01")!;
    expect(real.is_synthetic_close).toBe(false);
    expect(synthetic.is_synthetic_close).toBe(true);
  });
});
