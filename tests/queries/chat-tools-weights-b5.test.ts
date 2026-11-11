/**
 * B5 / QA-3: an account-filtered query_holdings call measures each weight
 * against THAT account's book, not the whole portfolio. QA-4: rows say
 * which currency their native price is in.
 *
 * Worked example: account 1 holds AAA 10 x 10 = 100; account 3 holds
 * BBB 9 x 100 = 900. Whole book = 1000.
 *   account 1 call: AAA weight = 100 / 100 = 100% (old code: 100 / 1000 = 10%)
 *   all-accounts call: AAA 10%, BBB 90%
 * Bound: an account-filtered call's weights sum to 100 within 0.1.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getHoldingsForChat } from "@/lib/queries/chat-tools";

let db: Database.Database;

function security(symbol: string, currency = "USD", sector = "Technology"): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency, sector) VALUES (?, ?, 'Stock', ?, ?)")
    .run(symbol, symbol, currency, sector).lastInsertRowid as number;
}

function hold(account: number, sec: number, qty: number, price: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, ?, '2026-10-30', ?)"
  ).run(account, sec, qty, qty * price * 0.8, `w-${account}-${sec}`);
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-10-30', ?, 't')").run(sec, price);
}

const sumWeights = (rows: { position_weight_pct: number | null }[]) =>
  rows.reduce((s, r) => s + (r.position_weight_pct ?? 0), 0);

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hold(1, security("AAA"), 10, 10);
  hold(3, security("BBB", "USD", "Energy"), 9, 100);
});

describe("getHoldingsForChat weights (B5)", () => {
  it("an account-filtered call's weights sum to 100", () => {
    const rows = getHoldingsForChat(db, { account_name: "Vanguard Taxable" });
    expect(rows.map((r) => r.symbol)).toEqual(["AAA"]);
    expect(rows[0].position_weight_pct).toBeCloseTo(100, 6);
    expect(Math.abs(sumWeights(rows) - 100)).toBeLessThan(0.1);
    expect(rows[0].weight_basis).toBe("account");

    const byIds = getHoldingsForChat(db, { account_ids: [3] });
    expect(byIds.map((r) => r.symbol)).toEqual(["BBB"]);
    expect(Math.abs(sumWeights(byIds) - 100)).toBeLessThan(0.1);
  });

  it("an all-accounts call keeps whole-book weights", () => {
    const rows = getHoldingsForChat(db);
    const bySymbol = Object.fromEntries(rows.map((r) => [r.symbol, r.position_weight_pct]));
    expect(bySymbol.AAA).toBeCloseTo(10, 6);
    expect(bySymbol.BBB).toBeCloseTo(90, 6);
    expect(rows.every((r) => r.weight_basis === "all accounts")).toBe(true);
  });

  it("a symbol or sector filter does not narrow the denominator", () => {
    // BBB's weight in the whole book is 90%, not 100% of a one-row result.
    const [bbb] = getHoldingsForChat(db, { symbol: "BBB" });
    expect(bbb.position_weight_pct).toBeCloseTo(90, 6);
    const [energy] = getHoldingsForChat(db, { sector: "Energy" });
    expect(energy.position_weight_pct).toBeCloseTo(90, 6);
  });

  it("an id list covering every account is the whole book (nit)", () => {
    const allIds = (db.prepare("SELECT id FROM accounts").all() as { id: number }[]).map((a) => a.id);
    const rows = getHoldingsForChat(db, { account_ids: allIds });
    expect(rows.every((r) => r.weight_basis === "all accounts")).toBe(true);
    expect(Math.abs(sumWeights(rows) - 100)).toBeLessThan(0.1);
  });

  it("an empty id list reads no account", () => {
    expect(getHoldingsForChat(db, { account_ids: [] })).toEqual([]);
  });

  it("a yen holding carries currency JPY; market_value is USD", () => {
    db.prepare("INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('JPY', 0.007, '2026-10-30', 'ibkr_ledger')").run();
    // 10 shares at 500 JPY = 5000 JPY = 35 USD.
    hold(3, security("YYY", "JPY"), 10, 500);
    const [row] = getHoldingsForChat(db, { symbol: "YYY" });
    expect(row.currency).toBe("JPY");
    expect(row.latest_price).toBe(500); // native, never converted
    expect(row.market_value).toBeCloseTo(35, 6);
    const [usd] = getHoldingsForChat(db, { symbol: "AAA" });
    expect(usd.currency).toBe("USD");
  });
});
