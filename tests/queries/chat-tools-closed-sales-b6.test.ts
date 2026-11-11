/**
 * B6 (and QA-4 for lots): closed sales in query_tax_lots are built on the
 * one closed-sales reader (getClosedTaxLotSales), keep NATIVE figures as
 * primary with the currency named, label a current-rate conversion (P14),
 * flag an engine-made close, and honour symbol case and sort_by.
 *
 * Worked example (JPY sale, rate 0.007 USD per yen):
 *   proceeds 150000 JPY, basis 100000 JPY, gain 50000 JPY
 *   proceeds_usd_at_current_fx = 150000 x 0.007 = 1050
 *   realized_gain_usd_at_current_fx = 50000 x 0.007 = 350
 * With no fx_rates row for JPY the USD fields are null (never parity, which
 * would have printed 50000 "dollars").
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getTaxLotsForChat } from "@/lib/queries/chat-tools";

const IBKR = 3;
let db: Database.Database;
let n = 0;

function security(symbol: string, currency = "USD"): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'Stock', ?)")
    .run(symbol, symbol, currency).lastInsertRowid as number;
}

function closedSale(opts: {
  account?: number;
  sec: number;
  buyDate: string;
  saleDate: string;
  qty: number;
  basis: number;
  proceeds: number;
  saleType?: string;
  longTerm?: boolean;
}) {
  n += 1;
  const account = opts.account ?? IBKR;
  const buy = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, source_key)
       VALUES (?, ?, ?, 'BUY', ?, ?, ?)`
    )
    .run(account, opts.sec, opts.buyDate, opts.qty, -opts.basis, `b6-buy-${n}`).lastInsertRowid;
  const lot = db
    .prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_transaction_id, acquisition_date, acquisition_price,
         quantity_acquired, quantity_remaining, cost_basis, is_short)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0)`
    )
    .run(account, opts.sec, buy, opts.buyDate, opts.basis / opts.qty, opts.qty, opts.basis).lastInsertRowid;
  const sale = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(account, opts.sec, opts.saleDate, opts.saleType ?? "SELL", -opts.qty, opts.proceeds, `b6-sell-${n}`)
    .lastInsertRowid;
  db.prepare(
    `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, quantity_sold, sale_price, proceeds,
       cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days, sale_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 30, ?)`
  ).run(
    lot,
    sale,
    opts.qty,
    opts.proceeds / opts.qty,
    opts.proceeds,
    opts.basis,
    opts.proceeds - opts.basis,
    opts.longTerm ? 1 : 0,
    opts.saleDate
  );
}

beforeEach(() => {
  n = 0;
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("query_tax_lots closed sales (B6)", () => {
  it("a JPY sale keeps native figures and labels the current-rate conversion", () => {
    db.prepare("INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('JPY', 0.007, '2026-10-30', 'ibkr_ledger')").run();
    closedSale({ sec: security("JJJ", "JPY"), buyDate: "2026-01-05", saleDate: "2026-06-01", qty: 100, basis: 100000, proceeds: 150000 });
    const [row] = getTaxLotsForChat(db, { status: "closed" });
    expect(row.currency).toBe("JPY");
    expect(row.proceeds_native).toBe(150000);
    expect(row.cost_basis_native).toBe(100000);
    expect(row.realized_gain_native).toBe(50000);
    expect(row.proceeds_usd_at_current_fx).toBeCloseTo(1050, 6);
    expect(row.cost_basis_usd_at_current_fx).toBeCloseTo(700, 6);
    expect(row.realized_gain_usd_at_current_fx).toBeCloseTo(350, 6);
    expect(row.fx_note).toMatch(/current/i);
  });

  it("a JPY sale with no rate on file gets null USD fields, never parity", () => {
    closedSale({ sec: security("JJJ", "JPY"), buyDate: "2026-01-05", saleDate: "2026-06-01", qty: 100, basis: 100000, proceeds: 150000 });
    const [row] = getTaxLotsForChat(db, { status: "closed" });
    expect(row.realized_gain_native).toBe(50000);
    expect(row.proceeds_usd_at_current_fx).toBeNull();
    expect(row.cost_basis_usd_at_current_fx).toBeNull();
    expect(row.realized_gain_usd_at_current_fx).toBeNull();
    expect(row.fx_note).toBe("no FX rate on file; native figures only");
  });

  it("a USD sale's USD fields equal its native figures", () => {
    closedSale({ sec: security("UUU"), buyDate: "2026-01-05", saleDate: "2026-06-01", qty: 10, basis: 500, proceeds: 620 });
    const [row] = getTaxLotsForChat(db, { status: "closed" });
    expect(row.currency).toBe("USD");
    expect(row.realized_gain_usd_at_current_fx).toBe(120);
    expect(row.realized_gain_loss).toBe(120);
    expect(row.account_tax_treatment).toBe("taxable");
    expect(row.is_synthetic_close).toBe(false);
  });

  it("an engine-made close is flagged and explained", () => {
    closedSale({ sec: security("RRR"), buyDate: "2026-01-05", saleDate: "2026-06-01", qty: 10, basis: 500, proceeds: 550, saleType: "RECONCILE_CLOSE" });
    const [row] = getTaxLotsForChat(db, { status: "closed" });
    expect(row.is_synthetic_close).toBe(true);
    expect(row.status_note).toContain(
      "Estimated by the lot engine from a missing broker trade; not a recorded sale."
    );
  });

  it("closed sales honour a lower-case symbol, the account, the year and sort_by", () => {
    const aaa = security("AAA");
    closedSale({ sec: aaa, buyDate: "2025-01-05", saleDate: "2026-02-01", qty: 10, basis: 100, proceeds: 90 }); // -10
    closedSale({ sec: aaa, buyDate: "2024-01-05", saleDate: "2026-03-01", qty: 10, basis: 100, proceeds: 160 }); // +60
    closedSale({ sec: aaa, buyDate: "2025-06-05", saleDate: "2025-12-01", qty: 10, basis: 100, proceeds: 130 }); // 2025
    closedSale({ account: 1, sec: aaa, buyDate: "2025-06-05", saleDate: "2026-04-01", qty: 10, basis: 100, proceeds: 140 });
    closedSale({ sec: security("BBB"), buyDate: "2025-01-05", saleDate: "2026-02-01", qty: 10, basis: 100, proceeds: 100 });

    const byGain = getTaxLotsForChat(db, { status: "closed", symbol: "aaa", account_name: "IBKR", year: 2026 });
    expect(byGain.map((r) => r.realized_gain_loss)).toEqual([-10, 60]); // losses first (default)

    const byAcq = getTaxLotsForChat(db, {
      status: "closed", symbol: "aaa", account_name: "IBKR", year: 2026, sort_by: "acquisition_date",
    });
    expect(byAcq.map((r) => r.acquisition_date)).toEqual(["2024-01-05", "2025-01-05"]);

    const limited = getTaxLotsForChat(db, { status: "closed", symbol: "AAA", limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0].realized_gain_loss).toBe(-10);
  });

  it("a non-USD sale with no rate sorts after every comparable figure (nit)", () => {
    // EUR gain -100 native with no rate: its native figure is not dollars,
    // so it must not sort among USD losses; it goes last.
    closedSale({ sec: security("EEE", "EUR"), buyDate: "2026-01-05", saleDate: "2026-06-02", qty: 10, basis: 200, proceeds: 100 });
    closedSale({ sec: security("UUU"), buyDate: "2026-01-05", saleDate: "2026-06-03", qty: 10, basis: 100, proceeds: 150 });
    closedSale({ sec: security("VVV"), buyDate: "2026-01-05", saleDate: "2026-06-04", qty: 10, basis: 90, proceeds: 80 });
    expect(getTaxLotsForChat(db, { status: "closed" }).map((r) => r.symbol)).toEqual(["VVV", "UUU", "EEE"]);
    expect(getTaxLotsForChat(db, { status: "closed", sort_by: "cost_basis" }).map((r) => r.symbol)).toEqual([
      "UUU",
      "VVV",
      "EEE",
    ]);
  });

  it("open lots carry currency and the account's tax treatment", () => {
    const sec = security("OOO", "JPY");
    db.prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, '2026-01-05', 500, 10, 10, 5000)`
    ).run(IBKR, sec);
    const [row] = getTaxLotsForChat(db, { status: "open" });
    expect(row.currency).toBe("JPY");
    expect(row.account_tax_treatment).toBe("taxable");
  });
});
