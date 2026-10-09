/**
 * Short lots in the chat summary's two lot lists.
 *
 * A short opened at 50 that now trades at 40 is a GAIN; at 60 it is a LOSS.
 * The harvesting list must sign the figure by side, and label a short so the
 * chat model never tells the owner to "sell" one. The engine treats every
 * short close as short-term (section 1233 general rule, lib/compute/tax-lots.ts),
 * so a short lot never approaches long-term and is left out of that list.
 *
 * Every lot here is minted by the real engine (computeTaxLots) from ledger
 * rows. Synthetic tickers and invented round figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { ibkrTradeDirectionNote } from "@/lib/import/ibkr-trade-direction";
import { todayET } from "@/lib/calendar/date-utils";
import { createPendingTestDb, seedSec, seedHold, seedPx } from "../setup/pending-statement-fixtures";

const IBKR = 3; // seeded by migration 002
const HELD_DAYS = 340; // inside the 60-day approaching-long-term window

let db: Database.Database;
let seq = 0;

/** A date N days before today (ET), so the day counts are wall-clock safe. */
function daysAgo(n: number): string {
  const d = new Date(`${todayET()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function daysAhead(n: number): string {
  return daysAgo(-n);
}

/** One ledger fill the way the importer writes it: broker dollars in `amount`. */
function fill(
  securityId: number,
  type: string,
  qty: number,
  price: number,
  opts: { multiplier?: number; opening?: boolean } = {}
): void {
  const date = daysAgo(HELD_DAYS);
  const sign = /^buy/i.test(type) ? -1 : 1;
  const notes = opts.opening ? ibkrTradeDirectionNote("O", `${date}, 10:00:00`) ?? null : null;
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, notes, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run(IBKR, securityId, date, type, qty, price, sign * qty * price * (opts.multiplier ?? 1), notes, `short-lots-${seq++}`);
}

function section(summary: string, heading: string): string[] {
  const body = summary.split(heading)[1]?.split("\n###")[0] ?? "";
  return body.split("\n").filter((l) => l.startsWith("- "));
}

const harvestLines = (s: string) => section(s, "### Tax-Loss Harvesting Candidates");
const approachingLines = (s: string) => section(s, "### Lots Approaching Long-Term Status");
const lineFor = (lines: string[], symbol: string) => lines.find((l) => l.startsWith(`- ${symbol} `));

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
  const shortOption = Number(
    db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
         VALUES ('ZZO 270115C00100000', 'ZZO 100 CALL', 'option', 'ZZO', 'CALL', 100, ?, 100)`
      )
      .run(daysAhead(90)).lastInsertRowid
  );
  fill(shortOption, "SELL_TO_OPEN", 2, 5, { multiplier: 100 });
  seedPx(db, shortOption, px, 9);

  // Non-USD short loser: short 10 at 100, now 140 -> 400 native, 500 in USD at 1.25.
  const shortEur = seedSec(db, "ZZE", "Stock", "EUR");
  fill(shortEur, "SELL", 10, 100, { opening: true });
  seedPx(db, shortEur, px, 140);
  upsertFxRate(db, { currency: "EUR", usdPerUnit: 1.25, asOf: px, source: "test" });

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
         FROM tax_lots tl JOIN securities s ON s.id = tl.security_id ORDER BY s.symbol`
      )
      .all() as Array<{ symbol: string; is_short: number; quantity_remaining: number; cost_basis: number }>;
    const bySymbol = new Map(lots.map((l) => [l.symbol, l]));
    expect(bySymbol.get("ZZA")).toMatchObject({ is_short: 0, quantity_remaining: 10, cost_basis: 1000 });
    expect(bySymbol.get("ZZC")).toMatchObject({ is_short: 1, quantity_remaining: 10, cost_basis: 1000 });
    expect(bySymbol.get("ZZD")).toMatchObject({ is_short: 1, quantity_remaining: 10, cost_basis: 500 });
    expect(bySymbol.get("ZZE")).toMatchObject({ is_short: 1, quantity_remaining: 10, cost_basis: 1000 });
    expect(bySymbol.get("ZZO 270115C00100000")).toMatchObject({ is_short: 1, quantity_remaining: 2, cost_basis: 1000 });
  });
});

describe("tax-loss harvesting candidates", () => {
  it("lists the long loser exactly as before", () => {
    const lines = harvestLines(getPortfolioSummaryForChat(db));
    expect(lines).toContain(`- ZZA (IBKR): -$500 unrealized loss, held ${HELD_DAYS} days`);
  });

  it("does not list the long winner", () => {
    expect(lineFor(harvestLines(getPortfolioSummaryForChat(db)), "ZZB")).toBeUndefined();
  });

  it("does not list a profitable short", () => {
    expect(lineFor(harvestLines(getPortfolioSummaryForChat(db)), "ZZC")).toBeUndefined();
  });

  it("lists a losing short with its true loss and a short label", () => {
    const line = lineFor(harvestLines(getPortfolioSummaryForChat(db)), "ZZD");
    expect(line).toBe(
      `- ZZD short (IBKR): -$300 unrealized loss, open ${HELD_DAYS} days (short position: closing it means buying to cover)`
    );
  });

  it("applies the contract multiplier to a losing short option", () => {
    const line = lineFor(harvestLines(getPortfolioSummaryForChat(db)), "ZZO");
    expect(line).toBe(
      `- ZZO 270115C00100000 short (IBKR): -$800 unrealized loss, open ${HELD_DAYS} days (short position: closing it means buying to cover)`
    );
  });

  it("converts a non-USD losing short to dollars", () => {
    const line = lineFor(harvestLines(getPortfolioSummaryForChat(db)), "ZZE");
    expect(line).toContain("- ZZE short (IBKR): -$500 unrealized loss");
  });

  it("orders longs and shorts together, largest loss first", () => {
    const symbols = harvestLines(getPortfolioSummaryForChat(db)).map((l) => l.slice(2, 5));
    expect(symbols).toEqual(["ZZO", expect.stringMatching(/ZZA|ZZE/), expect.stringMatching(/ZZA|ZZE/), "ZZD"]);
  });

  it("still leaves out a pending-statement lot", () => {
    expect(lineFor(harvestLines(getPortfolioSummaryForChat(db)), "ZZP")).toBeUndefined();
  });
});

describe("lots approaching long-term status", () => {
  it("lists long lots exactly as before", () => {
    const lines = approachingLines(getPortfolioSummaryForChat(db));
    expect(lineFor(lines, "ZZA")).toMatch(
      /^- ZZA \(IBKR\): \d+ days until long-term \(\d{4}-\d{2}-\d{2}\) \(unrealized: -\$500\)$/
    );
    expect(lineFor(lines, "ZZB")).toMatch(
      /^- ZZB \(IBKR\): \d+ days until long-term \(\d{4}-\d{2}-\d{2}\) \(unrealized: \+\$500\)$/
    );
  });

  it("never lists a short lot: a short close is short-term however long it was open", () => {
    const lines = approachingLines(getPortfolioSummaryForChat(db));
    expect(lines.map((l) => l.slice(2, 5)).sort()).toEqual(["ZZA", "ZZB"]);
  });

  it("the engine agrees: covering a short open more than a year is still short-term", () => {
    const sec = seedSec(db, "ZZF");
    const insert = db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, notes, source_key)
       VALUES (?, ?, ?, ?, 10, ?, ?, 0, ?, ?)`
    );
    insert.run(IBKR, sec, "2024-01-10", "SELL", 100, 1000, ibkrTradeDirectionNote("O", "2024-01-10, 10:00:00"), "short-lots-open");
    insert.run(IBKR, sec, "2025-06-10", "BUY", 60, -600, ibkrTradeDirectionNote("C", "2025-06-10, 10:00:00"), "short-lots-cover");
    computeTaxLots(db);
    const sale = db
      .prepare(
        `SELECT tls.is_long_term, tls.realized_gain_loss FROM tax_lot_sales tls
         JOIN tax_lots tl ON tl.id = tls.tax_lot_id WHERE tl.security_id = ?`
      )
      .get(sec) as { is_long_term: number; realized_gain_loss: number };
    expect(sale).toEqual({ is_long_term: 0, realized_gain_loss: 400 });
  });
});
