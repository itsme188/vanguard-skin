/**
 * Review fixes on the trade-review market-context facts (2026-11-15, Y1-Y4).
 * Lots and sales are minted by the real `computeTaxLots` from a synthetic
 * ledger, so the same-day order is the engine's own, not a guessed copy.
 *
 *  Y1: a lot opened LATER the same day as the sale (by the engine's replay
 *      order: IBKR execution time, else buys at 00:00 and sells at 23:59,
 *      then id) is not "retained" at the sale; later same-day sales follow the
 *      same order, not the sale id.
 *  Y2: concurrent buys are totalled and ranked in USD (a native trade leg is
 *      converted with the dashboard's factor), and a converted row says so.
 *  Y3: an option's premium is the exact figure of the lots the event closed,
 *      not the first opening fill; the first fill is used only when no lot
 *      sale rows exist, and is then marked "approx.".
 *  Y4: an engine reconciliation close dated after the sale makes the
 *      remainder uncertain; the line says so instead of asserting TRIM.
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
  seedHold,
} from "../setup/pending-statement-fixtures";

const ACCT = 3;
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

function fill(securityId: number, date: string, type: string, qty: number, price: number, notes: string | null = null): number {
  seedFill(db, ACCT, securityId, date, type, qty, price);
  const id = Number((db.prepare("SELECT MAX(id) AS id FROM transactions").get() as { id: number }).id);
  if (notes != null) db.prepare("UPDATE transactions SET notes = ? WHERE id = ?").run(notes, id);
  return id;
}

const at = (code: string, date: string, time: string) => ibkrTradeDirectionNote(code, `${date}, ${time}`)!;

describe("Y1: same-day lots and sales follow the engine's replay order", () => {
  it("a full exit stays a full exit when the name is bought again later that day", () => {
    const sec = seedSec(db, "ZZA");
    fill(sec, "2026-01-05", "BUY", 10, 10);
    fill(sec, "2026-02-10", "SELL", 10, 12, at("C", "2026-02-10", "10:00:00"));
    fill(sec, "2026-02-10", "BUY", 5, 11, at("O", "2026-02-10", "11:00:00"));

    const trades = grouped();
    expect(trades).toHaveLength(1);
    const [ctx] = getMarketContext(db, trades, ACCT);
    expect(ctx.remainingPosition).toMatchObject({ remainingShares: 0, soldShares: 10, isTrim: false });
    expect(formatMarketContext([ctx], trades)).toContain("FULL EXIT");
  });

  it("a same-day buy executed BEFORE the sale is held at the sale", () => {
    const sec = seedSec(db, "ZZA");
    fill(sec, "2026-01-05", "BUY", 10, 10);
    fill(sec, "2026-02-10", "SELL", 10, 12, at("C", "2026-02-10", "10:00:00"));
    fill(sec, "2026-02-10", "BUY", 5, 11, at("O", "2026-02-10", "09:00:00"));

    const [ctx] = getMarketContext(db, grouped(), ACCT);
    expect(ctx.remainingPosition).toMatchObject({ remainingShares: 5, isTrim: true });
  });

  it("parity with the engine: with no execution times a same-day buy replays before the sale", () => {
    // The engine sorts a time-less buy at 00:00 and a time-less sell at 23:59,
    // so the sale of 12 consumes the 10 older shares AND 2 of the same-day buy.
    const sec = seedSec(db, "ZZA");
    fill(sec, "2026-01-05", "BUY", 10, 10);
    const sale = fill(sec, "2026-02-10", "SELL", 12, 12);
    fill(sec, "2026-02-10", "BUY", 5, 11);

    const trades = grouped();
    const consumed = db
      .prepare("SELECT COALESCE(SUM(quantity_sold), 0) AS q FROM tax_lot_sales WHERE sale_transaction_id = ?")
      .get(sale) as { q: number };
    expect(consumed.q).toBe(12); // the engine saw the same-day buy as held
    const [ctx] = getMarketContext(db, trades, ACCT);
    expect(ctx.remainingPosition!.remainingShares).toBeCloseTo(3);
    expect(ctx.remainingPosition!.isTrim).toBe(true);
  });

  it("parity with the engine: a buy executed after the sale is not available to it", () => {
    const sec = seedSec(db, "ZZA");
    fill(sec, "2026-01-05", "BUY", 10, 10);
    const sale = fill(sec, "2026-02-10", "SELL", 12, 12, at("C", "2026-02-10", "10:00:00"));
    fill(sec, "2026-02-10", "BUY", 5, 11, at("O", "2026-02-10", "11:00:00"));
    computeTaxLots(db);
    const consumed = db
      .prepare("SELECT COALESCE(SUM(quantity_sold), 0) AS q FROM tax_lot_sales WHERE sale_transaction_id = ?")
      .get(sale) as { q: number };
    expect(consumed.q).toBe(10); // the 11:00 lot did not exist yet for the engine
  });

  it("two same-day trims are ordered by execution time, not by sale id", () => {
    const sec = seedSec(db, "ZZA");
    fill(sec, "2026-01-05", "BUY", 90, 10);
    const late = fill(sec, "2026-02-10", "SELL", 30, 12, at("C", "2026-02-10", "15:00:00"));
    const early = fill(sec, "2026-02-10", "SELL", 30, 12, at("C", "2026-02-10", "10:00:00"));

    const trades = grouped();
    const ctxs = getMarketContext(db, trades, ACCT);
    const bySale = new Map(trades.map((t, i) => [t.saleTransactionId, ctxs[i].remainingPosition!.remainingShares]));
    expect(bySale.get(early)).toBeCloseTo(60);
    expect(bySale.get(late)).toBeCloseTo(30);
  });
});

describe("Y2: concurrent buys are totalled and ranked in USD", () => {
  it("converts a native JPY trade leg, never a USD one, and labels it", () => {
    db.prepare("INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('JPY', 0.01, '2026-02-01', 'test')").run();
    const sold = seedSec(db, "ZZA");
    const usd = seedSec(db, "ZZB");
    const jpy = seedSec(db, "ZZJ", "Stock", "JPY");
    fill(sold, "2026-01-05", "BUY", 10, 10);
    fill(sold, "2026-02-10", "SELL", 10, 12);
    fill(usd, "2026-02-11", "BUY", 10, 200); // $2,000
    fill(jpy, "2026-02-12", "BUY", 100, 1000); // 100,000 yen = $1,000

    const trades = grouped();
    const ctxs = getMarketContext(db, trades, ACCT);
    const ca = ctxs[0].concurrentActivity!;
    expect(ca.totalBuyAmount).toBeCloseTo(3000);
    const jpyRow = ca.buys.find((b) => b.symbol === "ZZJ")!;
    expect(jpyRow.totalCost).toBeCloseTo(1000);
    expect(jpyRow.currency).toBe("JPY");
    expect(ca.buys.find((b) => b.symbol === "ZZB")!.totalCost).toBeCloseTo(2000);

    const text = formatMarketContext(ctxs, trades);
    expect(text).toContain("- Total deployed nearby: $3,000");
    expect(text).toMatch(/ZZJ \(\$1,000, converted from JPY\)/);
    expect(text).not.toContain("100,000");
  });

  it("ranks the largest buys by USD value", () => {
    db.prepare("INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('JPY', 0.01, '2026-02-01', 'test')").run();
    const sold = seedSec(db, "ZZA");
    const usd = seedSec(db, "ZZB");
    const jpy = seedSec(db, "ZZJ", "Stock", "JPY");
    fill(sold, "2026-01-05", "BUY", 10, 10);
    fill(sold, "2026-02-10", "SELL", 10, 12);
    for (let q = 1; q <= 10; q++) fill(usd, "2026-02-11", "BUY", q, 1000); // $1,000 … $10,000
    fill(jpy, "2026-02-12", "BUY", 1, 50_000); // 50,000 yen = $500: the smallest in USD

    const trades = grouped();
    const text = formatMarketContext(getMarketContext(db, trades, ACCT), trades);
    const line = text.split("\n").find((l) => l.startsWith("- Concurrent buys"))!;
    expect(line).not.toContain("ZZJ");
    expect(line).toContain("+1 more ($500, incl. amounts converted from JPY)");
    expect(text).toContain("- Total deployed nearby: $55,500");
  });
});

describe("Y3: an option's premium is the exact figure of the lots it closed", () => {
  function optionSec(symbol: string, type: "CALL" | "PUT"): number {
    return Number(
      db
        .prepare(
          `INSERT INTO securities (symbol, name, security_type, underlying_symbol, strike_price,
                                   expiration_date, option_type, multiplier, currency)
           VALUES (?, ?, 'Option', 'ZZQ', 50, '2026-03-20', ?, 100, 'USD')`
        )
        .run(symbol, symbol, type).lastInsertRowid
    );
  }
  // A real option leg stores contracts x price x multiplier (seedFill omits the multiplier).
  function scaleOptionAmounts(): void {
    db.prepare(
      `UPDATE transactions SET amount = amount * (SELECT COALESCE(multiplier, 1) FROM securities s WHERE s.id = security_id)
       WHERE security_id IN (SELECT id FROM securities WHERE LOWER(security_type) = 'option')`
    ).run();
  }
  function stockTrade(): GroupedTrade[] {
    scaleOptionAmounts();
    const stock = seedSec(db, "ZZQ");
    fill(stock, "2026-03-02", "BUY", 10, 50);
    fill(stock, "2026-03-25", "SELL", 10, 52);
    return grouped("2026-03-01", "2026-03-31").filter((t) => t.symbol === "ZZQ");
  }

  it("two long fills at different prices: the expired total is both fills", () => {
    const opt = optionSec("ZZQ   260320C00050000", "CALL");
    fill(opt, "2026-03-03", "BUY_TO_OPEN", 2, 1.0); // $200
    fill(opt, "2026-03-04", "BUY_TO_OPEN", 2, 2.0); // $400
    fill(opt, "2026-03-20", "EXPIRED", 4, 0);
    const trades = stockTrade();
    const ctxs = getMarketContext(db, trades, ACCT);
    const ev = ctxs[0].optionOrigin![0];
    expect(ev.premiumTotal).toBeCloseTo(600);
    expect(ev.premiumFromLots).toBe(true);
    expect(ev.openPremiumPerShare).toBeCloseTo(1.5);
    expect(ev.openPremiumPerContract).toBeCloseTo(150);
    const text = formatMarketContext(ctxs, trades);
    expect(text).toContain("premium $1.50/share ($150/contract) = $600 total");
    expect(text).not.toContain("approx.");
  });

  it("a partial expiry counts only what expired", () => {
    const opt = optionSec("ZZQ   260320C00050000", "CALL");
    fill(opt, "2026-03-03", "BUY_TO_OPEN", 3, 1.0);
    fill(opt, "2026-03-10", "SELL_TO_CLOSE", 2, 1.2);
    fill(opt, "2026-03-20", "EXPIRED", 1, 0);
    const trades = stockTrade();
    const text = formatMarketContext(getMarketContext(db, trades, ACCT), trades);
    expect(text).toContain("1 contract(s)");
    expect(text).toContain("premium $1.00/share ($100/contract) = $100 total");
  });

  it("a short expiry reads the premium received from the lot's proceeds", () => {
    const opt = optionSec("ZZQ   260320P00050000", "PUT");
    fill(opt, "2026-03-03", "SELL_TO_OPEN", 1, 2.0);
    fill(opt, "2026-03-05", "SELL_TO_OPEN", 1, 3.0);
    fill(opt, "2026-03-20", "EXPIRED", 2, 0);
    const trades = stockTrade();
    const ctxs = getMarketContext(db, trades, ACCT);
    const ev = ctxs[0].optionOrigin![0];
    expect(ev.isShort).toBe(true);
    expect(ev.premiumTotal).toBeCloseTo(500);
    const text = formatMarketContext(ctxs, trades);
    expect(text).toContain("premium received was kept");
    expect(text).toContain("premium $2.50/share ($250/contract) = $500 total");
  });

  it("with no lot sale rows the first fill is used and marked approx.", () => {
    const opt = optionSec("ZZQ   260320C00050000", "CALL");
    fill(opt, "2026-03-03", "BUY_TO_OPEN", 2, 1.5);
    fill(opt, "2026-03-20", "EXPIRED", 2, 0);
    const trades = stockTrade();
    db.prepare(
      `DELETE FROM tax_lot_sales WHERE sale_transaction_id IN
         (SELECT id FROM transactions WHERE type = 'EXPIRED')`
    ).run();
    const ctxs = getMarketContext(db, trades, ACCT);
    expect(ctxs[0].optionOrigin![0].premiumFromLots).toBe(false);
    const text = formatMarketContext(ctxs, trades);
    expect(text).toContain("approx. premium $1.50/share ($150/contract) = $300 total");
  });
});

describe("Y4: a later engine reconciliation close makes the remainder uncertain", () => {
  it("does not assert TRIM when the engine closed the rest without an imported sale", () => {
    const sec = seedSec(db, "ZZA");
    fill(sec, "2026-01-05", "BUY", 100, 10);
    fill(sec, "2026-02-10", "SELL", 50, 12);
    seedHold(db, ACCT, sec, "2026-03-31", "stmt-zero"); // statement shows the name flat

    const trades = grouped().filter((t) => !t.isSyntheticClose);
    expect(trades).toHaveLength(1);
    const [ctx] = getMarketContext(db, trades, ACCT);
    expect(ctx.remainingPosition!.laterEngineClose).toEqual({ quantity: 50, date: "2026-03-31" });
    const text = formatMarketContext([ctx], trades);
    expect(text).not.toContain("TRIM");
    expect(text).toContain("remainder uncertain");
    expect(text).toContain("engine reconciliation");
    expect(text).not.toMatch(/user sold|you sold/i);
  });

  it("no engine close: the field is absent and TRIM stands", () => {
    const sec = seedSec(db, "ZZA");
    fill(sec, "2026-01-05", "BUY", 100, 10);
    fill(sec, "2026-02-10", "SELL", 50, 12);
    const trades = grouped();
    const [ctx] = getMarketContext(db, trades, ACCT);
    expect(ctx.remainingPosition!.laterEngineClose).toBeUndefined();
    expect(formatMarketContext([ctx], trades)).toContain("TRIM");
  });
});
