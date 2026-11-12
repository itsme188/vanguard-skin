/**
 * Live-evaluation gaps (Portfolio Assistant, 2026-11-11 round): the model did
 * hand arithmetic where a tool did not return the figure it needed.
 *
 * 1. query_tax_lots `totals`: over EVERY lot matching the filter, never the
 *    rows returned. Hand-worked book (account 3, IBKR), limit 50:
 *      - 80 long lots of ZTL, 1 share each, basis 100, price 110: long count
 *        80, cost basis 8,000.00, unrealized gain 80 x 10 = 800.00;
 *      - 30 short lots of ZTS, 1 share each, proceeds 50, price 40: short
 *        count 30, proceeds 1,500.00, unrealized gain 30 x (50 - 40) = 300.00
 *        (never netted with the long figures: no 1,100 anywhere);
 *      - 10 expired option lots of ZTO (basis 30 each): pending, counted
 *        only, no figure;
 *      - 1 lot of ZTP closed per live broker data: pending
 *        (awaiting_statement), counted only.
 *    Closed sales: 5 USD sales of 20.00 gain each = 100.00; 2 JPY sales
 *    with no fx rate on file are left out of the USD total and counted.
 * 2. query_holdings `by_symbol`: ZTB held 10 shares at basis 3,000 (300 a
 *    share) in Vanguard Taxable and 30 shares at basis 12,600 (420 a share)
 *    in IBKR: total quantity 40, total basis 15,600.00, cost basis per share
 *    15,600 / 40 = 390.00 (not the mean of 300 and 420, 360). The same
 *    totals as the security page's POSITIONS row (computePositionTotals).
 * 3. query_holdings `currency` / `non_usd`: a yen stock is found.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { executeTool, CHAT_TOOLS } from "@/lib/chat/tools";
import { getHoldingsBySecurity, computePositionTotals } from "@/lib/queries/security-detail";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { createPendingTestDb, seedSec, seedFill, seedHold, seedPx, seedLot } from "../setup/pending-statement-fixtures";

let db: Database.Database;

function sale(securityId: number, gain: number): void {
  const lot = db
    .prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (3, ?, '2026-01-05', 100, 1, 0, 100)`,
    )
    .run(securityId).lastInsertRowid as number;
  const tx = db
    .prepare("INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, source_key) VALUES (3, ?, '2026-03-02', 'SELL', 1, ?, ?)")
    .run(securityId, 100 + gain, `zt-sale-${lot}`).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, sale_price, quantity_sold, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days)
     VALUES (?, ?, '2026-03-02', ?, 1, ?, 100, ?, 0, 56)`,
  ).run(lot, tx, 100 + gain, 100 + gain, gain);
}

function seedLotBook(): void {
  const today = todayET();
  // A pending pair first: computeTaxLots rebuilds lots from fills.
  const pend = seedSec(db, "ZTP");
  seedFill(db, 3, pend, addDays(today, -200), "BUY", 1, 100);
  seedHold(db, 3, pend, addDays(today, -2), "live-zero");
  seedPx(db, pend, addDays(today, -2), 90);
  computeTaxLots(db);

  const long = seedSec(db, "ZTL");
  seedPx(db, long, today, 110);
  for (let i = 0; i < 80; i++) seedLot(db, 3, long, { qty: 1, price: 100, date: addDays(today, -300 - i) });
  const short = seedSec(db, "ZTS");
  seedPx(db, short, today, 40);
  for (let i = 0; i < 30; i++) seedLot(db, 3, short, { qty: 1, price: 50, isShort: 1, date: addDays(today, -60 - i) });
  const opt = Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier, currency)
         VALUES ('ZTO 1C', 'option', 'CALL', 100, ?, 'ZTL', 100, 'USD')`,
      )
      .run(addDays(today, -3)).lastInsertRowid,
  );
  seedPx(db, opt, addDays(today, -3), 0.3);
  for (let i = 0; i < 10; i++) seedLot(db, 3, opt, { qty: 1, price: 30, date: addDays(today, -90 - i) });

  const usd = seedSec(db, "ZTU");
  for (let i = 0; i < 5; i++) sale(usd, 20);
  const yen = seedSec(db, "ZTY", "Stock", "JPY");
  for (let i = 0; i < 2; i++) sale(yen, 500);
}

beforeEach(() => {
  db = createPendingTestDb();
});

type Totals = {
  open_lots: {
    long: { count: number; cost_basis_usd: number; unrealized_gain_usd: number; unpriced_count: number };
    short: { count: number; short_sale_proceeds_usd: number; unrealized_gain_usd: number; unpriced_count: number };
  };
  pending_lots: { count: number; by_reason: Record<string, number> };
  closed_sales: { count: number; realized_gain_usd_at_current_fx: number; left_out_no_fx_rate: number };
  note: string;
};

describe("query_tax_lots totals cover every matching lot, not the rows returned", () => {
  it("120 open lots, limit 50: long and short apart, pending counted only", async () => {
    seedLotBook();
    const r = (await executeTool(db, "query_tax_lots", { status: "all", limit: 50 })) as {
      data: unknown[];
      totals: Totals;
      list_info: { open: { truncated: boolean } };
    };
    expect(r.list_info.open.truncated).toBe(true);
    const t = r.totals;
    expect(t.open_lots.long).toEqual({ count: 80, cost_basis_usd: 8000, unrealized_gain_usd: 800, unpriced_count: 0 });
    expect(t.open_lots.short).toEqual({ count: 30, short_sale_proceeds_usd: 1500, unrealized_gain_usd: 300, unpriced_count: 0 });
    expect(t.pending_lots).toEqual({ count: 11, by_reason: { awaiting_statement: 1, expired_option_awaiting_close: 10 } });
    expect(t.closed_sales).toEqual({ count: 7, realized_gain_usd_at_current_fx: 100, left_out_no_fx_rate: 2 });
    // Never netted: no combined long + short figure anywhere.
    expect(JSON.stringify(t)).not.toMatch(/\b1100\b|\b9500\b/);
    // A pending lot never carries a figure in the totals.
    expect(JSON.stringify(t.pending_lots)).not.toMatch(/usd|gain|basis/);
  });

  it("totals equal the sums over the full list (limit 150 shows every open lot)", async () => {
    seedLotBook();
    const r = (await executeTool(db, "query_tax_lots", { limit: 150 })) as {
      data: Array<{ position_side: string; cost_basis: number; unrealized_gain: number | null; pending_statement: boolean; current_value: number | null }>;
      totals: Totals;
    };
    const live = r.data.filter((x) => !x.pending_statement && x.current_value != null);
    const longRows = live.filter((x) => x.position_side === "long");
    const shortRows = live.filter((x) => x.position_side === "short");
    expect(r.totals.open_lots.long.cost_basis_usd).toBeCloseTo(longRows.reduce((a, x) => a + x.cost_basis, 0), 6);
    expect(r.totals.open_lots.short.unrealized_gain_usd).toBeCloseTo(shortRows.reduce((a, x) => a + (x.unrealized_gain ?? 0), 0), 6);
    expect(r.totals.closed_sales).toBeUndefined(); // status open: no closed block
  });

  it("a symbol filter narrows the totals the same way", async () => {
    seedLotBook();
    const r = (await executeTool(db, "query_tax_lots", { symbol: "zts" })) as { totals: Totals };
    expect(r.totals.open_lots.long.count).toBe(0);
    expect(r.totals.open_lots.short.count).toBe(30);
  });
});

describe("query_holdings by_symbol", () => {
  function seedTwoAccounts(): number {
    const today = todayET();
    const id = seedSec(db, "ZTB");
    seedPx(db, id, today, 400);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (1, ?, 10, 3000, ?, 'zb1')",
    ).run(id, today);
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (3, ?, 30, 12600, ?, 'zb3')",
    ).run(id, today);
    return id;
  }
  type BySymbol = Array<{
    symbol: string;
    positions: number;
    total_quantity: number;
    total_cost_basis_usd: number | null;
    cost_basis_per_share_usd: number | null;
    cost_basis_per_share_reason?: string;
    market_value: number;
    unrealized_gain: number | null;
  }>;

  it("10 at 300 and 30 at 420 is 390 a share, the security page's totals", async () => {
    const id = seedTwoAccounts();
    const r = (await executeTool(db, "query_holdings", {})) as { by_symbol: BySymbol };
    const z = r.by_symbol.find((x) => x.symbol === "ZTB")!;
    expect(z.positions).toBe(2);
    expect(z.total_quantity).toBe(40);
    expect(z.total_cost_basis_usd).toBe(15600);
    expect(z.cost_basis_per_share_usd).toBe(390);
    expect(z.market_value).toBe(16000);
    expect(z.unrealized_gain).toBe(400);
    const page = computePositionTotals(getHoldingsBySecurity(db, id));
    expect(z.total_cost_basis_usd).toBe(page.totalCostBasis);
    expect(z.market_value).toBe(page.totalValue);
    expect(z.unrealized_gain).toBe(page.totalUnrealizedGain);
  });

  it("is left out for a symbol held once, and follows the account scope", async () => {
    seedTwoAccounts();
    const one = (await executeTool(db, "query_holdings", { account_name: "IBKR" })) as { by_symbol?: BySymbol };
    expect(one.by_symbol).toBeUndefined();
  });

  it("a short, a mixed long/short or an option has no per-share figure, with a reason", async () => {
    const today = todayET();
    const id = seedSec(db, "ZTM");
    seedPx(db, id, today, 50);
    db.prepare("INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (1, ?, 10, 400, ?, 'm1')").run(id, today);
    db.prepare("INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (3, ?, -5, -300, ?, 'm3')").run(id, today);
    const r = (await executeTool(db, "query_holdings", {})) as { by_symbol: BySymbol };
    const z = r.by_symbol.find((x) => x.symbol === "ZTM")!;
    expect(z.cost_basis_per_share_usd).toBeNull();
    expect(z.cost_basis_per_share_reason).toMatch(/long and short/);
  });

  it("the description names the block", () => {
    const d = CHAT_TOOLS.find((t) => t.name === "query_holdings")!.description!;
    expect(d).toContain("by_symbol");
    expect(d).toContain("cost_basis_per_share_usd");
  });
});

describe("query_holdings currency filter", () => {
  function seedFx(): void {
    const today = todayET();
    const us = seedSec(db, "ZTD");
    const jp = seedSec(db, "ZTJ", "Stock", "JPY");
    db.prepare("INSERT INTO fx_rates (currency, usd_per_unit, as_of) VALUES ('JPY', 0.007, ?)").run(today);
    for (const [id, px] of [[us, 10], [jp, 1500]] as const) {
      seedPx(db, id, today, px);
      db.prepare("INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (1, ?, 10, 50, ?, ?)").run(id, today, `c${id}`);
    }
  }
  const symbols = (r: unknown) => ((r as { data: Array<{ symbol: string }> }).data ?? []).map((x) => x.symbol);

  it("currency 'jpy' and non_usd find the yen stock only", async () => {
    seedFx();
    expect(symbols(await executeTool(db, "query_holdings", { currency: "jpy" }))).toEqual(["ZTJ"]);
    expect(symbols(await executeTool(db, "query_holdings", { non_usd: true }))).toEqual(["ZTJ"]);
    expect(symbols(await executeTool(db, "query_holdings", { currency: "USD" }))).toEqual(["ZTD"]);
  });

  it("an unknown or malformed code is an error naming the currencies in scope", async () => {
    seedFx();
    const r = (await executeTool(db, "query_holdings", { currency: "EUR" })) as { error?: string };
    expect(r.error).toBe("No holdings priced in EUR in this scope. Currencies held: JPY, USD.");
    const bad = (await executeTool(db, "query_holdings", { currency: "japanese yen" })) as { error?: string };
    expect(bad.error).toMatch(/three-letter ISO code/);
    const both = (await executeTool(db, "query_holdings", { currency: "JPY", non_usd: true })) as { error?: string };
    expect(both.error).toMatch(/not both/);
  });
});
