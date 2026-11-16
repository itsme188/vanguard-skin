/**
 * The facts the trade-review prompt is given about each sale (unit H1,
 * 2026-11-15). Every lot and sale here is minted by the real `computeTaxLots`
 * from a synthetic ledger, then read back through the same round-trip path the
 * review uses, so the test exercises the engine's split replay and same-day
 * sale order rather than a hand-guessed copy of them.
 *
 *  H1a: the "TRIM vs FULL EXIT" line is the position left JUST AFTER this
 *       sale, not today's open lots (shares bought again later are not
 *       "retained"; three trims on one day see shrinking remainders; a later
 *       split does not restate the figure into another share basis).
 *  H1b: a buy the broker marks as a pure close (a short cover) is not new
 *       capital deployed, and a long buy list is capped with an exact total.
 *  H1c: an expired option is described by its own side (a long expiry loses
 *       the premium paid), shares come from the stored multiplier, and the
 *       premium is labelled per share.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import {
  getRoundTrips,
  computeGroupedTrades,
  type GroupedTrade,
} from "@/lib/compute/trade-roundtrips";
import { getMarketContext, formatMarketContext } from "@/lib/trade-review/market-context";
import { ibkrTradeDirectionNote } from "@/lib/import/ibkr-trade-direction";
import {
  createPendingTestDb,
  seedSec,
  seedFill,
  seedImportSplit,
} from "../setup/pending-statement-fixtures";

const ACCT = 3; // IBKR, seeded by runMigrations

let db: Database.Database;

beforeEach(() => {
  db = createPendingTestDb();
});

function grouped(start = "2026-01-01", end = "2026-12-31"): GroupedTrade[] {
  computeTaxLots(db);
  return computeGroupedTrades(getRoundTrips(db, ACCT, start, end)).sort(
    (a, b) => a.exitDate.localeCompare(b.exitDate) || a.saleTransactionId - b.saleTransactionId
  );
}

function fill(
  securityId: number,
  date: string,
  type: string,
  qty: number,
  price: number,
  notes: string | null = null
): number {
  seedFill(db, ACCT, securityId, date, type, qty, price);
  const id = Number(
    (db.prepare("SELECT MAX(id) AS id FROM transactions").get() as { id: number }).id
  );
  if (notes != null) db.prepare("UPDATE transactions SET notes = ? WHERE id = ?").run(notes, id);
  return id;
}

describe("H1a: the position left is measured as of the sale", () => {
  it("a full exit stays a full exit when the name is bought again later", () => {
    const sec = seedSec(db, "ZZA");
    fill(sec, "2026-01-05", "BUY", 100, 10);
    fill(sec, "2026-02-10", "SELL", 100, 12);
    fill(sec, "2026-03-10", "BUY", 50, 11); // later re-entry, still open today

    const trades = grouped();
    expect(trades).toHaveLength(1);
    const [ctx] = getMarketContext(db, trades, ACCT);
    expect(ctx.remainingPosition).toEqual({
      remainingShares: 0,
      soldShares: 100,
      retainedPct: 0,
      isTrim: false,
    });
    expect(formatMarketContext([ctx], trades)).toContain("FULL EXIT");
  });

  it("three trims on one day each see the shares left after that trim", () => {
    const sec = seedSec(db, "ZZA");
    fill(sec, "2026-01-05", "BUY", 90, 10);
    fill(sec, "2026-02-10", "SELL", 30, 12);
    fill(sec, "2026-02-10", "SELL", 30, 12);
    fill(sec, "2026-02-10", "SELL", 30, 12);

    const trades = grouped();
    expect(trades).toHaveLength(3);
    const ctxs = getMarketContext(db, trades, ACCT);
    expect(ctxs.map((c) => c.remainingPosition?.remainingShares)).toEqual([60, 30, 0]);
    expect(ctxs.map((c) => c.remainingPosition?.isTrim)).toEqual([true, true, false]);
    expect(ctxs[0].remainingPosition!.retainedPct).toBeCloseTo(60 / 90);
    expect(ctxs[1].remainingPosition!.retainedPct).toBeCloseTo(30 / 60);
  });

  it("a split after the sale does not restate the remainder into post-split shares", () => {
    const sec = seedSec(db, "ZZA");
    fill(sec, "2026-01-05", "BUY", 100, 10);
    fill(sec, "2026-02-10", "SELL", 40, 12);
    seedImportSplit(db, sec, "2026-03-02"); // 2-for-1
    fill(sec, "2026-04-01", "SELL", 20, 7); // post-split shares

    const trades = grouped();
    expect(trades.map((t) => t.totalQuantity)).toEqual([40, 20]);
    const ctxs = getMarketContext(db, trades, ACCT);
    // Just after the first sale: 60 pre-split shares left, same basis as the 40 sold.
    expect(ctxs[0].remainingPosition!.remainingShares).toBeCloseTo(60);
    expect(ctxs[0].remainingPosition!.retainedPct).toBeCloseTo(0.6);
    // Just after the second: 120 post-split shares less 20 sold.
    expect(ctxs[1].remainingPosition!.remainingShares).toBeCloseTo(100);
    expect(ctxs[1].remainingPosition!.retainedPct).toBeCloseTo(100 / 120);
  });

  it("a short cover is measured against short lots only, never the long book", () => {
    const sec = seedSec(db, "ZZA");
    // A long lot of 50 open the whole time, and a 30-share short covered in full.
    const longLot = Number(
      db
        .prepare(
          `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price,
                                 quantity_acquired, quantity_remaining, cost_basis, is_short)
           VALUES (?, ?, '2026-01-02', 10, 50, 50, 500, 0)`
        )
        .run(ACCT, sec).lastInsertRowid
    );
    void longLot;
    const shortLot = Number(
      db
        .prepare(
          `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price,
                                 quantity_acquired, quantity_remaining, cost_basis, is_short)
           VALUES (?, ?, '2026-01-05', 20, 30, 0, -600, 1)`
        )
        .run(ACCT, sec).lastInsertRowid
    );
    const cover = Number(
      db
        .prepare(
          `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
           VALUES (?, ?, '2026-02-10', 'BUY_TO_COVER', 30, 15, -450, 'h1-cover')`
        )
        .run(ACCT, sec).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, quantity_sold, sale_price, proceeds,
                                  cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days, sale_date)
       VALUES (?, ?, 30, 15, 450, 600, 150, 0, 36, '2026-02-10')`
    ).run(shortLot, cover);

    const trade: GroupedTrade = {
      saleTransactionId: cover,
      securityId: sec,
      symbol: "ZZA",
      securityName: null,
      lots: [],
      isShort: true,
      totalQuantity: 30,
      sellTransactionQty: 30,
      lotCoverage: 1,
      avgEntryPrice: 20,
      exitPrice: 15,
      exitDate: "2026-02-10",
      earliestEntryDate: "2026-01-05",
      latestEntryDate: "2026-01-05",
      avgHoldingDays: 36,
      maxHoldingDays: 36,
      minHoldingDays: 36,
      totalCost: 600,
      totalProceeds: 450,
      realizedPnl: 150,
      returnPct: 25,
      usdPerUnit: 1,
      conventionPending: false,
      isSyntheticClose: false,
    };
    const [ctx] = getMarketContext(db, [trade], ACCT);
    expect(ctx.remainingPosition!.remainingShares).toBe(0);
    expect(ctx.remainingPosition!.isTrim).toBe(false);
  });
});

describe("H1b: concurrent buys are new capital only, and the list is capped", () => {
  it("leaves out a buy the broker marks as a pure close; keeps opens and rows with no evidence", () => {
    const sold = seedSec(db, "ZZA");
    const other = seedSec(db, "ZZB");
    fill(sold, "2026-01-05", "BUY", 10, 10);
    fill(sold, "2026-02-10", "SELL", 10, 12);
    fill(other, "2026-02-09", "BUY", 5, 100, ibkrTradeDirectionNote("C", "2026-02-09, 10:00:00")!); // short cover
    fill(other, "2026-02-11", "BUY", 3, 100, ibkrTradeDirectionNote("O", "2026-02-11, 10:00:00")!);
    fill(other, "2026-02-12", "BUY", 2, 100); // no broker evidence

    const trades = grouped();
    const [ctx] = getMarketContext(db, trades, ACCT);
    expect(ctx.concurrentActivity!.buys.map((b) => b.quantity).sort()).toEqual([2, 3]);
    expect(ctx.concurrentActivity!.totalBuyAmount).toBe(500);
  });

  it("caps a long buy list to the largest buys with an exact remainder and total", () => {
    const sold = seedSec(db, "ZZA");
    fill(sold, "2026-01-05", "BUY", 10, 10);
    fill(sold, "2026-02-10", "SELL", 10, 12);
    const other = seedSec(db, "ZZB");
    // 15 buys costing 1,000 … 15,000 (qty 1..15 at 1,000 a share).
    for (let q = 1; q <= 15; q++) fill(other, "2026-02-12", "BUY", q, 1000);

    const trades = grouped();
    const ctxs = getMarketContext(db, trades, ACCT);
    const [ctx] = ctxs;
    expect(ctx.concurrentActivity!.buys).toHaveLength(15); // the data keeps every row
    expect(ctx.concurrentActivity!.totalBuyAmount).toBe(120_000);

    const text = formatMarketContext(ctxs, trades);
    const line = text.split("\n").find((l) => l.startsWith("- Concurrent buys"))!;
    expect(line.match(/ ZZB \(/g)).toHaveLength(10);
    expect(line).toContain("$15,000");
    expect(line).not.toContain("($5,000)");
    // The 5 smallest (1,000 … 5,000) are folded into one line with their exact sum.
    expect(line).toContain("+5 more ($15,000)");
    expect(text).toContain("- Total deployed nearby: $120,000");
  });
});

describe("H1c: expired options carry their own side, multiplier and per-share premium", () => {
  function optionSec(symbol: string, underlying: string, type: "CALL" | "PUT", multiplier: number): number {
    return Number(
      db
        .prepare(
          `INSERT INTO securities (symbol, name, security_type, underlying_symbol, strike_price,
                                   expiration_date, option_type, multiplier, currency)
           VALUES (?, ?, 'Option', ?, 50, '2026-03-20', ?, ?, 'USD')`
        )
        .run(symbol, symbol, underlying, type, multiplier).lastInsertRowid
    );
  }

  function stockTrade(): GroupedTrade[] {
    const stock = seedSec(db, "ZZQ");
    fill(stock, "2026-03-02", "BUY", 10, 50);
    fill(stock, "2026-03-25", "SELL", 10, 52);
    return grouped("2026-03-01", "2026-03-31").filter((t) => t.symbol === "ZZQ");
  }

  it("a long call that expires is a lost premium, not a kept one", () => {
    const opt = optionSec("ZZQ   260320C00050000", "ZZQ", "CALL", 100);
    fill(opt, "2026-03-03", "BUY_TO_OPEN", 2, 1.5);
    fill(opt, "2026-03-20", "EXPIRED", 2, 0);
    const trades = stockTrade();
    const ctxs = getMarketContext(db, trades, ACCT);
    const text = formatMarketContext(ctxs, trades);
    expect(text).toContain("EXPIRED long call options worthless");
    expect(text).toContain("premium paid was lost");
    expect(text).not.toContain("EXPIRED short");
    expect(text).toContain("premium $1.50/share ($150/contract) = $300 total");
    expect(ctxs[0].optionOrigin![0].openPremiumPerContract).toBe(150);
  });

  it("a short put that expires keeps the premium received", () => {
    const opt = optionSec("ZZQ   260320P00050000", "ZZQ", "PUT", 100);
    fill(opt, "2026-03-03", "SELL_TO_OPEN", 1, 2);
    fill(opt, "2026-03-20", "EXPIRED", 1, 0);
    const trades = stockTrade();
    const text = formatMarketContext(getMarketContext(db, trades, ACCT), trades);
    expect(text).toContain("EXPIRED short put options worthless");
    expect(text).toContain("premium received was kept");
  });

  it("an exercise moves contracts times the stored multiplier, not a fixed 100", () => {
    const opt = optionSec("ZZQ   260320C00050000", "ZZQ", "CALL", 10);
    fill(opt, "2026-03-03", "BUY_TO_OPEN", 2, 1.5);
    fill(opt, "2026-03-20", "EXERCISED", 2, 0);
    const trades = stockTrade();
    const text = formatMarketContext(getMarketContext(db, trades, ACCT), trades);
    expect(text).toContain("bought 20 shares at $50.00 strike");
    expect(text).toContain("premium $1.50/share ($15/contract) = $30 total");
  });
});
