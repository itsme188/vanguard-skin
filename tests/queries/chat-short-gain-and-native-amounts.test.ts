/**
 * Three defects a live evaluation found in what the chat is told (2026-11-12).
 *
 * 1. query_holdings' short gain. Every IBKR source (TWS sync, Web API
 *    refresh, the statement's Open Positions) stores a short's cost basis
 *    NEGATIVE (position x avgCost): the sale proceeds. The holdings tool
 *    asked for a basis above zero, so every real short came back with no
 *    gain at all, and a short stored with a positive basis (the eval
 *    fixture) came back as market value minus proceeds, -2,580 where the
 *    position is 180 down. The figure must agree with query_tax_lots and the
 *    Accounts page (market value minus the signed basis).
 * 2. A transaction amount is the security's NATIVE currency for a trade leg
 *    (the IBKR Trades section's Proceeds; the lot engine reads it native),
 *    while the IBKR cash sections (dividends, interest, fees, deposits and
 *    withdrawals) are converted to USD at import. A yen buy printed as
 *    "$230,000".
 * 3. Interest paid (a negative INTEREST row) printed without its sign.
 *
 * Synthetic tickers and invented round figures only.
 */
import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getHoldingsForChat, getTaxLotsForChat, getTransactionsForChat } from "@/lib/queries/chat-tools";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { computeIbkrTradingContext } from "@/lib/chat/ibkr-context";
import { executeTool } from "@/lib/chat/tools";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { ibkrTradeDirectionNote } from "@/lib/import/ibkr-trade-direction";
import { todayET } from "@/lib/calendar/date-utils";
import { createPendingTestDb, seedSec, seedPx } from "../setup/pending-statement-fixtures";

const IBKR = 3; // seeded by migration 002
const OPTION_SYMBOL = "ZZQ 270115C00100000";
let seq = 0;

function daysAgo(n: number): string {
  const d = new Date(`${todayET()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** One ledger fill the way the IBKR importer writes it: GROSS amount, fee apart. */
function fill(
  db: Database.Database,
  securityId: number,
  type: string,
  qty: number,
  price: number,
  fee: number,
  opts: { scale?: number; code?: "O" | "C"; date?: string } = {}
): void {
  const date = opts.date ?? daysAgo(40);
  const sign = /^buy/i.test(type) ? -1 : 1;
  const notes = opts.code ? ibkrTradeDirectionNote(opts.code, `${date}, 10:00:00`) ?? null : null;
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, notes, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(IBKR, securityId, date, type, qty, price, sign * qty * price * (opts.scale ?? 1), fee, notes, `short-native-${seq++}`);
}

function hold(db: Database.Database, securityId: number, quantity: number, costBasis: number): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(IBKR, securityId, quantity, costBasis, daysAgo(1), `short-native-hold-${seq++}`);
}

function cashRow(db: Database.Database, type: string, amount: number, securityId: number | null = null): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, amount, fees, source_key)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  ).run(IBKR, securityId, daysAgo(5), type, amount, `short-native-cash-${seq++}`);
}

/**
 * A short stock (10 sold at 100, 10 fee: 990 net proceeds, now 60) and a
 * short call (2 sold at 5 x100, 10 fee: 990 net premium, now 9). Holdings
 * carry the broker's negative basis (position x avgCost).
 */
function shortBook(): { db: Database.Database; stockId: number; optionId: number } {
  const db = createPendingTestDb();
  const px = daysAgo(1);
  const stockId = seedSec(db, "ZZS");
  fill(db, stockId, "SELL", 10, 100, 10, { code: "O" });
  seedPx(db, stockId, px, 60);
  hold(db, stockId, -10, -990);
  const optionId = Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
         VALUES (?, 'ZZQ 100 CALL', 'option', 'ZZQ', 'CALL', 100, ?, 100)`
      )
      .run(OPTION_SYMBOL, daysAgo(-90)).lastInsertRowid
  );
  fill(db, optionId, "SELL_TO_OPEN", 2, 5, 10, { scale: 100 });
  seedPx(db, optionId, px, 9);
  hold(db, optionId, -2, -990);
  computeTaxLots(db);
  return { db, stockId, optionId };
}

describe("query_holdings: a short's unrealized gain agrees with query_tax_lots", () => {
  it.each([
    ["short stock", "ZZS", 390, -600],
    ["short option", OPTION_SYMBOL, -810, -1800],
  ])("%s", (_what, symbol, expected, value) => {
    const { db } = shortBook();
    const [lot] = getTaxLotsForChat(db, { symbol });
    expect(lot.unrealized_gain).toBeCloseTo(expected, 6);
    const [row] = getHoldingsForChat(db, { symbol, includeShorts: true });
    expect(row.market_value).toBeCloseTo(value, 6);
    expect(row.cost_basis).toBeCloseTo(-990, 6);
    expect(row.unrealized_gain).toBeCloseTo(lot.unrealized_gain as number, 6);
    // Percent of the proceeds, signed by the gain.
    expect(row.unrealized_gain_pct).toBeCloseTo((expected * 100) / 990, 6);
  });

  it("a short whose basis was stored positive is still read as proceeds (the reconciliation rule)", () => {
    const { db, stockId } = shortBook();
    db.prepare("UPDATE holdings SET cost_basis = 990 WHERE security_id = ?").run(stockId);
    const [row] = getHoldingsForChat(db, { symbol: "ZZS", includeShorts: true });
    expect(row.cost_basis).toBeCloseTo(-990, 6);
    expect(row.unrealized_gain).toBeCloseTo(390, 6);
    expect(row.unrealized_gain_pct).toBeCloseTo(39000 / 990, 6);
  });

  it("the query_holdings tool returns the same figure as the query_tax_lots tool", async () => {
    const { db } = shortBook();
    for (const symbol of ["ZZS", OPTION_SYMBOL]) {
      const h = (await executeTool(db, "query_holdings", { symbol })) as { data: Array<{ unrealized_gain: number }> };
      const l = (await executeTool(db, "query_tax_lots", { symbol })) as { data: Array<{ unrealized_gain: number }> };
      expect(h.data).toHaveLength(1);
      expect(l.data).toHaveLength(1);
      expect(h.data[0].unrealized_gain).toBeCloseTo(l.data[0].unrealized_gain, 6);
    }
  });

  it("a long position is unchanged", () => {
    const db = createPendingTestDb();
    const id = seedSec(db, "ZZL");
    seedPx(db, id, daysAgo(1), 120);
    hold(db, id, 10, 1000);
    const [row] = getHoldingsForChat(db, { symbol: "ZZL" });
    expect(row.cost_basis).toBe(1000);
    expect(row.unrealized_gain).toBe(200);
    expect(row.unrealized_gain_pct).toBe(20);
  });
});

/** A yen buy (100 at 2,000 = 200,000 JPY), a USD buy, interest paid and earned. */
function nativeBook(withRate = true): Database.Database {
  const db = createPendingTestDb();
  const yen = seedSec(db, "ZZJ", "Stock", "JPY");
  const usd = seedSec(db, "ZZU");
  fill(db, yen, "BUY", 100, 2000, 0, { date: daysAgo(10) });
  fill(db, usd, "BUY", 10, 50, 0, { date: daysAgo(9) });
  cashRow(db, "INTEREST", -35);
  cashRow(db, "INTEREST", 12);
  // An IBKR dividend on the yen stock is stored in USD (converted at import).
  cashRow(db, "DIVIDEND", 40, yen);
  if (withRate) upsertFxRate(db, { currency: "JPY", usdPerUnit: 0.0065, asOf: daysAgo(1), source: "test" });
  return db;
}

describe("query_transactions: an amount carries its currency", () => {
  it("a yen trade is native JPY with a USD figure at the current rate", () => {
    const rows = getTransactionsForChat(nativeBook(), {});
    const buy = rows.find((r) => r.symbol === "ZZJ" && r.type === "BUY")!;
    expect(buy.amount).toBe(-200000);
    expect(buy.amount_currency).toBe("JPY");
    expect(buy.amount_usd).toBeCloseTo(-1300, 6);
    const usdBuy = rows.find((r) => r.symbol === "ZZU")!;
    expect(usdBuy.amount_currency).toBe("USD");
    expect(usdBuy.amount_usd).toBe(-500);
    const div = rows.find((r) => r.type === "DIVIDEND")!;
    expect(div.amount_currency).toBe("USD");
    expect(div.amount_usd).toBe(40);
    const interest = rows.find((r) => r.type === "INTEREST" && (r.amount as number) < 0)!;
    expect(interest.amount_currency).toBe("USD");
  });

  it("with no rate on file the USD figure is null, never the native number", () => {
    const buy = getTransactionsForChat(nativeBook(false), {}).find((r) => r.symbol === "ZZJ" && r.type === "BUY")!;
    expect(buy.amount_currency).toBe("JPY");
    expect(buy.amount_usd).toBeNull();
  });
});

describe("Portfolio Context recent transactions", () => {
  const recent = (db: Database.Database) =>
    getPortfolioSummaryForChat(db, { accountIds: [IBKR], label: "IBKR" })
      .split("### Recent Transactions")[1]
      .split("\n###")[0];

  it("a yen amount is shown in yen, with a USD figure, never as dollars", () => {
    const text = recent(nativeBook());
    const line = text.split("\n").find((l) => l.includes("BUY ZZJ"))!;
    expect(line).toContain("JPY 200,000");
    expect(line).toContain("$1,300");
    expect(line).not.toContain("$200,000");
  });

  it("with no rate the line says so", () => {
    const line = recent(nativeBook(false)).split("\n").find((l) => l.includes("BUY ZZJ"))!;
    expect(line).toContain("JPY 200,000");
    expect(line).toContain("no USD rate on file");
    expect(line).not.toContain("$200,000");
  });

  it("interest paid and interest earned are told apart", () => {
    const lines = recent(nativeBook()).split("\n").filter((l) => l.includes("INTEREST"));
    expect(lines.some((l) => l.includes("interest paid $35"))).toBe(true);
    expect(lines.some((l) => l.includes("interest earned $12"))).toBe(true);
    expect(lines.some((l) => /amount \$35\b/.test(l))).toBe(false);
  });
});

describe("IBKR dashboard recent trades", () => {
  it("amount is USD; the native figure and currency ride beside it", () => {
    const ctx = computeIbkrTradingContext(nativeBook(), IBKR, "IBKR");
    const yen = ctx.recentTrades.find((t) => t.symbol === "ZZJ")!;
    expect(yen.amount).toBeCloseTo(1300, 6);
    expect(yen.currency).toBe("JPY");
    expect(yen.amountNative).toBe(200000);
    const usd = ctx.recentTrades.find((t) => t.symbol === "ZZU")!;
    expect(usd.amount).toBe(500);
    expect(usd.currency).toBe("USD");
  });

  it("a trade with no USD rate is never given a dollar amount", () => {
    const ctx = computeIbkrTradingContext(nativeBook(false), IBKR, "IBKR");
    expect(ctx.recentTrades.find((t) => t.symbol === "ZZJ")).toBeUndefined();
    expect(ctx.recentTradesWithoutUsd).toEqual([
      expect.objectContaining({ symbol: "ZZJ", currency: "JPY", amountNative: 200000 }),
    ]);
  });
});

describe("query_holdings by_symbol agrees with its own rows for a short", () => {
  /** Short 10 in IBKR (net proceeds 990, now 60), long 5 in account 1 (basis 400, now 60). */
  function mixed(shortBasis: number): Database.Database {
    const db = createPendingTestDb();
    const id = seedSec(db, "ZZM");
    seedPx(db, id, daysAgo(1), 60);
    hold(db, id, -10, shortBasis);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (1, ?, 5, 400, ?, 'short-native-long-zzm')`
    ).run(id, daysAgo(1));
    return db;
  }

  it.each([
    ["negative as IBKR stores it", -990],
    ["positive (a shape no real source writes)", 990],
  ])("short basis %s", async (_what, basis) => {
    const out = (await executeTool(mixed(basis), "query_holdings", { symbol: "ZZM" })) as {
      data: Array<{ unrealized_gain: number }>;
      by_symbol: Array<{ unrealized_gain: number; total_cost_basis_usd: number }>;
    };
    const rowSum = out.data.reduce((s, r) => s + r.unrealized_gain, 0);
    expect(rowSum).toBeCloseTo(290, 6); // short +390, long -100
    expect(out.by_symbol).toHaveLength(1);
    expect(out.by_symbol[0].unrealized_gain).toBeCloseTo(290, 6);
    expect(out.by_symbol[0].total_cost_basis_usd).toBeCloseTo(-590, 6);
  });
});
