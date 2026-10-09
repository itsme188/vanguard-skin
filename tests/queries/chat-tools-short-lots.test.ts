/**
 * Short lots in the chat tax-lot tool (query_tax_lots, open lots).
 *
 * A short opened at 100 that now trades at 60 is a GAIN; a short opened at 50
 * that now trades at 80 is a LOSS. The open-lots query must sign the figure by
 * side, tell the model the lot is short, and never present a short as
 * long-term or approaching long-term: the engine books every short close as
 * short-term however long the short was open (lib/compute/tax-lots.ts).
 *
 * Every lot here is minted by the real engine (computeTaxLots) from ledger
 * rows. Synthetic tickers and invented round figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import {
  getTaxLotsForChat,
  PENDING_STATEMENT_CHAT_NOTE,
  SHORT_LOT_CHAT_NOTE,
  type TaxLotResult,
} from "@/lib/queries/chat-tools";
import { lotSideSignSql } from "@/lib/queries/tax-lots";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { ibkrTradeDirectionNote } from "@/lib/import/ibkr-trade-direction";
import { todayET } from "@/lib/calendar/date-utils";
import { createPendingTestDb, seedSec, seedHold, seedPx } from "../setup/pending-statement-fixtures";

const IBKR = 3; // seeded by migration 002
const HELD_DAYS = 340; // under one year
const OLD_DAYS = 400; // over one year

let db: Database.Database;
let seq = 0;

/** A date N days before today (ET), so the day counts are wall-clock safe. */
function daysAgo(n: number): string {
  const d = new Date(`${todayET()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** One ledger fill the way the importer writes it: broker dollars in `amount`. */
function fill(
  securityId: number,
  type: string,
  qty: number,
  price: number,
  opts: { multiplier?: number; opening?: boolean; heldDays?: number } = {}
): void {
  const date = daysAgo(opts.heldDays ?? HELD_DAYS);
  const sign = /^buy/i.test(type) ? -1 : 1;
  const notes = opts.opening ? ibkrTradeDirectionNote("O", `${date}, 10:00:00`) ?? null : null;
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, notes, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(IBKR, securityId, date, type, qty, price, sign * qty * price * (opts.multiplier ?? 1), notes, `chat-short-lots-${seq++}`);
}

const OPTION_SYMBOL = "ZZO 270115C00100000";

function lot(symbol: string): TaxLotResult {
  const rows = getTaxLotsForChat(db, { symbol });
  expect(rows).toHaveLength(1);
  return rows[0];
}

beforeEach(() => {
  db = createPendingTestDb();
  const px = daysAgo(2);

  // Long loser: bought 10 at 100, now 50 -> a 500 loss.
  const longLoser = seedSec(db, "ZZA");
  fill(longLoser, "BUY", 10, 100);
  seedPx(db, longLoser, px, 50);

  // Long winner: bought 10 at 100, now 150 -> a 500 gain.
  const longWinner = seedSec(db, "ZZB");
  fill(longWinner, "BUY", 10, 100);
  seedPx(db, longWinner, px, 150);

  // Short winner: sold short 10 at 100, now 60 -> a 400 GAIN.
  const shortWinner = seedSec(db, "ZZC");
  fill(shortWinner, "SELL", 10, 100, { opening: true });
  seedPx(db, shortWinner, px, 60);

  // Short loser: sold short 10 at 50, now 80 -> a 300 LOSS.
  const shortLoser = seedSec(db, "ZZD");
  fill(shortLoser, "SELL", 10, 50, { opening: true });
  seedPx(db, shortLoser, px, 80);

  // Short option: wrote 2 contracts at 5, now 9 -> 2 x 100 x 4 = an 800 LOSS.
  const expiry = daysAgo(-90);
  const shortOption = Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
         VALUES (?, 'ZZO 100 CALL', 'option', 'ZZO', 'CALL', 100, ?, 100)`
      )
      .run(OPTION_SYMBOL, expiry).lastInsertRowid
  );
  fill(shortOption, "SELL_TO_OPEN", 2, 5, { multiplier: 100 });
  seedPx(db, shortOption, px, 9);

  // Non-USD short loser: short 10 at 100, now 140 -> 400 native, 500 in USD at 1.25.
  const shortEur = seedSec(db, "ZZE", "Stock", "EUR");
  fill(shortEur, "SELL", 10, 100, { opening: true });
  seedPx(db, shortEur, px, 140);
  upsertFxRate(db, { currency: "EUR", usdPerUnit: 1.25, asOf: px, source: "test" });

  // Long lot open more than a year: long-term.
  const longOld = seedSec(db, "ZZF");
  fill(longOld, "BUY", 10, 100, { heldDays: OLD_DAYS });
  seedPx(db, longOld, px, 120);

  // Short lot open more than a year: still NOT long-term. Short 10 at 100, now 70 -> a 300 gain.
  const shortOld = seedSec(db, "ZZG");
  fill(shortOld, "SELL", 10, 100, { opening: true, heldDays: OLD_DAYS });
  seedPx(db, shortOld, px, 70);

  // Pending statement: a long loser the live data shows flat.
  const pending = seedSec(db, "ZZP");
  fill(pending, "BUY", 10, 100);
  seedHold(db, IBKR, pending, px, "live-zero");
  seedPx(db, pending, px, 50);

  computeTaxLots(db);
});

describe("fixture shape (what the engine writes for a short lot)", () => {
  it("stores a short lot with is_short = 1 and a POSITIVE quantity_remaining", () => {
    const lots = db
      .prepare(
        `SELECT s.symbol, tl.is_short, tl.quantity_remaining, tl.cost_basis
         FROM tax_lots tl JOIN securities s ON s.id = tl.security_id`
      )
      .all() as Array<{ symbol: string; is_short: number; quantity_remaining: number; cost_basis: number }>;
    const bySymbol = new Map(lots.map((l) => [l.symbol, l]));
    expect(bySymbol.get("ZZA")).toMatchObject({ is_short: 0, quantity_remaining: 10, cost_basis: 1000 });
    expect(bySymbol.get("ZZC")).toMatchObject({ is_short: 1, quantity_remaining: 10, cost_basis: 1000 });
    expect(bySymbol.get("ZZD")).toMatchObject({ is_short: 1, quantity_remaining: 10, cost_basis: 500 });
    expect(bySymbol.get("ZZG")).toMatchObject({ is_short: 1, quantity_remaining: 10, cost_basis: 1000 });
    expect(bySymbol.get(OPTION_SYMBOL)).toMatchObject({ is_short: 1, quantity_remaining: 2, cost_basis: 1000 });
  });
});

describe("the shared side-sign fragment", () => {
  it("is the one CASE every lot read multiplies by", () => {
    expect(lotSideSignSql("tl")).toBe("(CASE WHEN tl.is_short=1 THEN -1 ELSE 1 END)");
    expect(lotSideSignSql("tax_lots")).toBe("(CASE WHEN tax_lots.is_short=1 THEN -1 ELSE 1 END)");
  });
});

describe("long lots are unchanged", () => {
  it("a long loser keeps every figure", () => {
    const r = lot("ZZA");
    expect(r).toMatchObject({
      account_name: "IBKR",
      symbol: "ZZA",
      acquisition_price: 100,
      quantity_remaining: 10,
      cost_basis: 1000,
      current_price: 50,
      current_value: 500,
      unrealized_gain: -500,
      days_held: HELD_DAYS,
      is_long_term: false,
      pending_statement: false,
      position_side: "long",
    });
    expect(r.long_term_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.status_note).toBeUndefined();
  });

  it("a long winner keeps every figure", () => {
    expect(lot("ZZB")).toMatchObject({ current_value: 1500, unrealized_gain: 500, position_side: "long" });
  });

  it("a long lot open more than a year is long-term", () => {
    const r = lot("ZZF");
    expect(r).toMatchObject({ unrealized_gain: 200, days_held: OLD_DAYS, is_long_term: true, position_side: "long" });
    expect(r.long_term_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("short lots are signed by side", () => {
  it("a short that fell is a GAIN", () => {
    const r = lot("ZZC");
    expect(r).toMatchObject({ cost_basis: 1000, current_price: 60, unrealized_gain: 400, position_side: "short" });
  });

  it("a short that rose is a LOSS", () => {
    const r = lot("ZZD");
    expect(r).toMatchObject({ cost_basis: 500, current_price: 80, unrealized_gain: -300, position_side: "short" });
  });

  it("a short option applies the contract multiplier", () => {
    const r = lot(OPTION_SYMBOL);
    expect(r).toMatchObject({ quantity_remaining: 2, cost_basis: 1000, unrealized_gain: -800, position_side: "short" });
  });

  it("a non-USD short is converted to dollars", () => {
    const r = lot("ZZE");
    expect(r).toMatchObject({ cost_basis: 1250, unrealized_gain: -500, position_side: "short" });
  });

  it("says in words that the lot is short", () => {
    expect(lot("ZZC").status_note).toBe(SHORT_LOT_CHAT_NOTE);
    expect(SHORT_LOT_CHAT_NOTE).toMatch(/short/i);
    expect(SHORT_LOT_CHAT_NOTE).toMatch(/buying to cover/i);
  });

  it("sorts losses first across both sides", () => {
    // The pending-statement lot is left out: its figure is blanked after the sort.
    const symbols = getTaxLotsForChat(db, {})
      .filter((r) => !r.pending_statement)
      .map((r) => r.symbol);
    // -800 option, then the two -500s (ZZA long, ZZE short), then -300 ZZD.
    expect(symbols.slice(0, 4).sort()).toEqual([OPTION_SYMBOL, "ZZA", "ZZD", "ZZE"].sort());
    expect(symbols[0]).toBe(OPTION_SYMBOL);
    expect(symbols[3]).toBe("ZZD");
    // The profitable short ranks with the winners, after every loser.
    expect(symbols.indexOf("ZZC")).toBeGreaterThan(symbols.indexOf("ZZD"));
  });
});

describe("a short lot is never long-term or approaching it", () => {
  it("a short open under a year carries no long-term date", () => {
    const r = lot("ZZD");
    expect(r.is_long_term).toBe(false);
    expect(r.long_term_date).toBeNull();
  });

  it("a short open more than a year is still not long-term", () => {
    const r = lot("ZZG");
    expect(r).toMatchObject({ unrealized_gain: 300, days_held: OLD_DAYS, is_long_term: false, position_side: "short" });
    expect(r.long_term_date).toBeNull();
  });
});

describe("a pending-statement lot is unchanged", () => {
  it("carries no unrealized figure and the pending note", () => {
    const r = lot("ZZP");
    expect(r).toMatchObject({
      cost_basis: 1000,
      current_value: null,
      unrealized_gain: null,
      pending_statement: true,
      position_side: "long",
      status_note: PENDING_STATEMENT_CHAT_NOTE,
    });
  });
});
