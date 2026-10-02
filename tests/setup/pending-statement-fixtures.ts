/**
 * Shared synthetic fixtures for the pending-statement read model (spec
 * docs/superpowers/specs/2026-10-02-statement-only-synthetic-closes-design.md
 * §2.2). Fake tickers and small round numbers only — the repo is public.
 *
 * Accounts come from runMigrations' seed: 1 = Vanguard Taxable,
 * 2 = Vanguard Roth IRA, 3 = IBKR.
 */
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

export function createPendingTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

export function seedSec(
  db: Database.Database,
  symbol: string,
  type = "Stock",
  currency = "USD"
): number {
  return Number(
    db
      .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, ?, ?)")
      .run(symbol, `${symbol} Corp`, type, currency).lastInsertRowid
  );
}

let txnSeq = 0;
export function seedFill(
  db: Database.Database,
  accountId: number,
  securityId: number,
  date: string,
  type: string,
  qty: number,
  price: number
): void {
  const sign = /^(buy|reinvestment|buy_to_open|buy_to_cover|buy_to_close)$/i.test(type) ? -1 : 1;
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(accountId, securityId, date, type, qty, price, sign * qty * price, `pst-${type}-${date}-${txnSeq++}`);
}

/**
 * Holdings row by ORIGIN:
 *  - "stmt-zero"  statement-pass tombstone (`recon:closed-equity:…:stmt`)
 *  - "legacy-zero" unsuffixed tombstone (statement-grade)
 *  - "live-zero"  live-pass tombstone (`recon:closed-equity:…:live`)
 *  - "tws" / "plaid" live-sync rows (any quantity)
 *  - "stmt"       statement-prefix row (`ibkr:pos:`; any quantity)
 */
export type HoldingOrigin = "stmt-zero" | "legacy-zero" | "live-zero" | "tws" | "plaid" | "stmt";

export function seedHold(
  db: Database.Database,
  accountId: number,
  securityId: number,
  date: string,
  origin: HoldingOrigin,
  quantity = 0
): void {
  const base = `${accountId}:${securityId}:${date}`;
  const sourceKey =
    origin === "stmt-zero"
      ? `recon:closed-equity:${base}:stmt`
      : origin === "legacy-zero"
        ? `recon:closed-equity:${base}`
        : origin === "live-zero"
          ? `recon:closed-equity:${base}:live`
          : origin === "tws"
            ? `tws-${base}`
            : origin === "plaid"
              ? `plaid:${base}`
              : `ibkr:pos:${base}`;
  const qty = origin.endsWith("zero") ? 0 : quantity;
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, 0, ?, ?)`
  ).run(accountId, securityId, qty, date, sourceKey);
}

export function seedPx(db: Database.Database, securityId: number, date: string, price: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')"
  ).run(securityId, date, price);
}

/** A raw open lot, bypassing the engine (for edges the engine never mints, e.g. short stock lots). */
export function seedLot(
  db: Database.Database,
  accountId: number,
  securityId: number,
  opts: { date?: string; qty?: number; price?: number; isShort?: 0 | 1; remaining?: number } = {}
): void {
  const qty = opts.qty ?? 10;
  const price = opts.price ?? 100;
  db.prepare(
    `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price,
                           quantity_acquired, quantity_remaining, cost_basis, is_short)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    accountId,
    securityId,
    opts.date ?? "2026-06-01",
    price,
    qty,
    opts.remaining ?? qty,
    qty * price,
    opts.isShort ?? 0
  );
}

export function seedImportSplit(db: Database.Database, securityId: number, date: string): void {
  db.prepare(
    `INSERT INTO corporate_actions
       (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source, source_key)
     VALUES (?, 'SPLIT', ?, 2, 1, 0, 'import', ?)`
  ).run(securityId, date, `pst:ca:split:${securityId}:${date}`);
}
