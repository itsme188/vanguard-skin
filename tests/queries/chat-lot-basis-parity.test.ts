/**
 * One unrealized figure for an open lot, on every surface.
 *
 * The Tax Lots page measures an open lot against its fee-inclusive REMAINING
 * basis (`remainingLotBasisSql`: cost_basis x remaining / acquired). The chat
 * tax-lot tool and the chat summary used `quantity_remaining x
 * acquisition_price`, which drops the fee on every fill: the page read
 * -310 / -810 / +390 where both chat readers read -300 / -800 / +400.
 *
 * Every lot here is minted by the real engine (computeTaxLots) from ledger
 * fills that carry a fee, in the IBKR shape (gross `amount`, fee in `fees`).
 * Synthetic tickers and invented round figures only.
 */
import { describe, it, expect } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getTaxLotsForChat, type TaxLotResult } from "@/lib/queries/chat-tools";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { getOpenTaxLots, remainingLotBasisSql } from "@/lib/queries/tax-lots";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { ibkrTradeDirectionNote } from "@/lib/import/ibkr-trade-direction";
import { todayET } from "@/lib/calendar/date-utils";
import { formatUSD } from "@/lib/format";
import { createPendingTestDb, seedSec, seedPx } from "../setup/pending-statement-fixtures";

const IBKR = 3; // seeded by migration 002
const HELD_DAYS = 340; // inside the 60-day approaching-long-term window
const OPTION_SYMBOL = "ZZO 270115C00100000";

let seq = 0;

/** A date N days before today (ET), so the day counts are wall-clock safe. */
function daysAgo(n: number): string {
  const d = new Date(`${todayET()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

interface FillOpts {
  /** Dollars per quantity-unit of price: 100 for an option, 0.01 for a bond. */
  scale?: number;
  /** IBKR open/close code written into the note (shorts need it). */
  code?: "O" | "C";
  heldDays?: number;
}

/** One ledger fill the way the IBKR importer writes it: GROSS `amount`, fee apart. */
function fill(
  db: Database.Database,
  securityId: number,
  type: string,
  qty: number,
  price: number,
  fee: number,
  opts: FillOpts = {}
): void {
  const date = daysAgo(opts.heldDays ?? HELD_DAYS);
  const sign = /^buy/i.test(type) ? -1 : 1;
  const notes = opts.code ? ibkrTradeDirectionNote(opts.code, `${date}, 10:00:00`) ?? null : null;
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, notes, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(IBKR, securityId, date, type, qty, price, sign * qty * price * (opts.scale ?? 1), fee, notes, `lot-basis-parity-${seq++}`);
}

/**
 * One case = one open lot. `expected` is the signed unrealized figure worked
 * by hand from the fills; `basis` the remaining (fee-inclusive) basis in USD;
 * `fullBasis` the whole lot's basis in USD.
 */
interface LotCase {
  symbol: string;
  what: string;
  seed: (db: Database.Database, px: string) => void;
  basis: number;
  fullBasis: number;
  value: number;
  expected: number;
  short: boolean;
}

const CASES: LotCase[] = [
  {
    symbol: "ZZA",
    what: "long stock: 10 at 100 + 10 fee = 1,010 basis, now 70",
    seed: (db, px) => {
      const id = seedSec(db, "ZZA");
      fill(db, id, "BUY", 10, 100, 10);
      seedPx(db, id, px, 70);
    },
    basis: 1010, fullBasis: 1010, value: 700, expected: -310, short: false,
  },
  {
    symbol: "ZZB",
    what: "long winner: 10 at 100 + 10 fee, now 150",
    seed: (db, px) => {
      const id = seedSec(db, "ZZB");
      fill(db, id, "BUY", 10, 100, 10);
      seedPx(db, id, px, 150);
    },
    basis: 1010, fullBasis: 1010, value: 1500, expected: 490, short: false,
  },
  {
    symbol: "ZZC",
    what: "short stock: 10 at 100 - 10 fee = 990 net proceeds, now 60",
    seed: (db, px) => {
      const id = seedSec(db, "ZZC");
      fill(db, id, "SELL", 10, 100, 10, { code: "O" });
      seedPx(db, id, px, 60);
    },
    basis: 990, fullBasis: 990, value: 600, expected: 390, short: true,
  },
  {
    symbol: OPTION_SYMBOL,
    what: "short option x100: 2 at 5 - 10 fee = 990 net premium, now 9",
    seed: (db, px) => {
      const id = Number(
        db
          .prepare(
            `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
             VALUES (?, 'ZZO 100 CALL', 'option', 'ZZO', 'CALL', 100, ?, 100)`
          )
          .run(OPTION_SYMBOL, daysAgo(-90)).lastInsertRowid
      );
      fill(db, id, "SELL_TO_OPEN", 2, 5, 10, { scale: 100 });
      seedPx(db, id, px, 9);
    },
    basis: 990, fullBasis: 990, value: 1800, expected: -810, short: true,
  },
  {
    symbol: "ZZH",
    what: "partly sold long: 10 at 100 + 10 fee, 4 sold; 6 left carry 606, now 80",
    seed: (db, px) => {
      const id = seedSec(db, "ZZH");
      fill(db, id, "BUY", 10, 100, 10);
      fill(db, id, "SELL", 4, 110, 4, { heldDays: 100 });
      seedPx(db, id, px, 80);
    },
    basis: 606, fullBasis: 1010, value: 480, expected: -126, short: false,
  },
  {
    symbol: "ZZI",
    what: "partly covered short: 10 at 100 - 10 fee, 4 covered; 6 left carry 594, now 120",
    seed: (db, px) => {
      const id = seedSec(db, "ZZI");
      fill(db, id, "SELL", 10, 100, 10, { code: "O" });
      fill(db, id, "BUY", 4, 90, 4, { code: "C", heldDays: 100 });
      seedPx(db, id, px, 120);
    },
    basis: 594, fullBasis: 990, value: 720, expected: -126, short: true,
  },
  {
    symbol: "ZZE",
    what: "non-USD long: 10 at 100 + 10 fee = 1,010 native, now 60, at 1.25 dollars per unit",
    seed: (db, px) => {
      const id = seedSec(db, "ZZE", "Stock", "EUR");
      fill(db, id, "BUY", 10, 100, 10);
      seedPx(db, id, px, 60);
      upsertFxRate(db, { currency: "EUR", usdPerUnit: 1.25, asOf: px, source: "test" });
    },
    basis: 1262.5, fullBasis: 1262.5, value: 750, expected: -512.5, short: false,
  },
  {
    symbol: "ZZT",
    what: "bond, per-100 price: 10,000 face at 98 + 5 fee = 9,805 dollars, now 96",
    seed: (db, px) => {
      const id = seedSec(db, "ZZT", "Bond");
      fill(db, id, "BUY", 10000, 98, 5, { scale: 0.01 });
      seedPx(db, id, px, 96);
    },
    basis: 9805, fullBasis: 9805, value: 9600, expected: -205, short: false,
  },
];

function book(cases: LotCase[]): Database.Database {
  const db = createPendingTestDb();
  const px = daysAgo(2);
  for (const c of cases) c.seed(db, px);
  computeTaxLots(db);
  return db;
}

function pageLot(db: Database.Database, symbol: string) {
  const rows = getOpenTaxLots(db).filter((l) => l.symbol === symbol);
  expect(rows).toHaveLength(1);
  return rows[0];
}

function chatLot(db: Database.Database, symbol: string): TaxLotResult {
  const rows = getTaxLotsForChat(db, { symbol });
  expect(rows).toHaveLength(1);
  return rows[0];
}

function section(summary: string, heading: string): string[] {
  const body = summary.split(heading)[1]?.split("\n###")[0] ?? "";
  return body.split("\n").filter((l) => l.startsWith("- "));
}
const lineFor = (lines: string[], symbol: string) => lines.find((l) => l.startsWith(`- ${symbol} `));

describe("the remaining-basis fragment is the one copy", () => {
  it("is exported byte-identical for the page and both chat readers", () => {
    expect(remainingLotBasisSql()).toBe(
      "(CASE WHEN tl.quantity_acquired != 0 THEN tl.cost_basis * tl.quantity_remaining / tl.quantity_acquired ELSE 0 END) * COALESCE(fx.usd_per_unit, 1)"
    );
  });
});

describe("mixed book with a fee on every fill: page, chat tool and chat summary agree", () => {
  it("the engine capitalizes the fee into the lot (fixture shape)", () => {
    const db = book(CASES);
    const lots = db
      .prepare(
        `SELECT s.symbol, tl.is_short, tl.quantity_acquired, tl.quantity_remaining, tl.cost_basis, tl.acquisition_price
         FROM tax_lots tl JOIN securities s ON s.id = tl.security_id`
      )
      .all() as Array<{ symbol: string }>;
    const by = new Map(lots.map((l) => [l.symbol, l]));
    expect(by.get("ZZA")).toMatchObject({ is_short: 0, quantity_remaining: 10, cost_basis: 1010, acquisition_price: 100 });
    expect(by.get("ZZC")).toMatchObject({ is_short: 1, quantity_remaining: 10, cost_basis: 990, acquisition_price: 100 });
    expect(by.get(OPTION_SYMBOL)).toMatchObject({ is_short: 1, quantity_remaining: 2, cost_basis: 990 });
    expect(by.get("ZZH")).toMatchObject({ is_short: 0, quantity_acquired: 10, quantity_remaining: 6, cost_basis: 1010 });
    expect(by.get("ZZI")).toMatchObject({ is_short: 1, quantity_acquired: 10, quantity_remaining: 6, cost_basis: 990 });
    expect(by.get("ZZE")).toMatchObject({ is_short: 0, cost_basis: 1010 });
    // Bond: true economic dollars (10,000 face at 98 per 100, plus the fee).
    expect(by.get("ZZT")).toMatchObject({ is_short: 0, quantity_remaining: 10000, cost_basis: 9805, acquisition_price: 98 });
    expect(lots).toHaveLength(CASES.length);
  });

  it.each(CASES)("page and chat tool, same book: $symbol ($what)", (c) => {
    const db = book(CASES);
    const page = pageLot(db, c.symbol);
    const chat = chatLot(db, c.symbol);

    // The page's own figure is the hand-worked one...
    expect(page.unrealized_gain).toBeCloseTo(c.expected, 2);
    expect(page.adjusted_cost_basis).toBeCloseTo(c.basis, 2);
    // ...and the chat tool gives the same figure, to the cent.
    expect(chat.unrealized_gain).not.toBeNull();
    expect(Math.round((chat.unrealized_gain as number) * 100)).toBe(Math.round((page.unrealized_gain as number) * 100));
    expect(Math.round((chat.current_value as number) * 100)).toBe(Math.round((page.current_value as number) * 100));
    expect(chat.current_value).toBeCloseTo(c.value, 2);
    expect(chat.position_side).toBe(c.short ? "short" : "long");

    // The row's basis is the basis of the quantity still open: the one the
    // gain uses, so (value - basis) signed by side IS the gain.
    expect(chat.cost_basis).toBeCloseTo(c.basis, 2);
    const side = c.short ? -1 : 1;
    expect(side * ((chat.current_value as number) - chat.cost_basis)).toBeCloseTo(chat.unrealized_gain as number, 2);
    // The whole lot's figure survives under its own name.
    expect(chat.original_lot_cost_basis).toBeCloseTo(c.fullBasis, 2);
    expect(chat.original_lot_cost_basis).toBeCloseTo(page.cost_basis, 2);
  });

  it.each(CASES)("chat summary line, lot on its own: $symbol ($what)", (c) => {
    const db = book([c]);
    const page = pageLot(db, c.symbol);
    const figure = page.unrealized_gain as number;
    expect(figure).toBeCloseTo(c.expected, 2);

    const summary = getPortfolioSummaryForChat(db);
    const harvest = lineFor(section(summary, "### Tax-Loss Harvesting Candidates"), c.symbol);
    const approaching = lineFor(section(summary, "### Lots Approaching Long-Term Status"), c.symbol);

    // The summary prints whole dollars; it must be the PAGE figure's rendering.
    if (figure < -100) {
      expect(harvest).toBeDefined();
      expect(harvest).toContain(`: ${formatUSD(figure)} unrealized loss`);
    } else {
      expect(harvest).toBeUndefined();
    }
    if (c.short) {
      expect(approaching).toBeUndefined();
    } else {
      expect(approaching).toBeDefined();
      expect(approaching).toContain(`(unrealized: ${figure >= 0 ? "+" : ""}${formatUSD(figure)})`);
    }
  });

  it("the summary lists the five largest losses of the mixed book with the page's figures", () => {
    const db = book(CASES);
    const lines = section(getPortfolioSummaryForChat(db), "### Tax-Loss Harvesting Candidates");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain(`- ${OPTION_SYMBOL} short (IBKR): -$810 unrealized loss`);
    expect(lines[1]).toContain("- ZZE (IBKR): -$513 unrealized loss");
    expect(lines[2]).toContain("- ZZA (IBKR): -$310 unrealized loss");
    expect(lines[3]).toContain("- ZZT (IBKR): -$205 unrealized loss");
    expect(lines[4]).toMatch(/^- ZZ[HI] .*-\$126 unrealized loss/);
  });
});

describe("the harvesting threshold (< -100) applies to the fee-inclusive figure", () => {
  it("a lot the fee pushes past the threshold is listed; the bare price move alone would not be", () => {
    // 10 at 100 + 10 fee = 1,010; now 90.50 -> 905. Price move alone: -95. With the fee: -105.
    const db = createPendingTestDb();
    const id = seedSec(db, "ZZJ");
    fill(db, id, "BUY", 10, 100, 10);
    seedPx(db, id, daysAgo(2), 90.5);
    computeTaxLots(db);
    expect(pageLot(db, "ZZJ").unrealized_gain).toBeCloseTo(-105, 2);
    expect(chatLot(db, "ZZJ").unrealized_gain).toBeCloseTo(-105, 2);
    const line = lineFor(section(getPortfolioSummaryForChat(db), "### Tax-Loss Harvesting Candidates"), "ZZJ");
    expect(line).toBe(`- ZZJ (IBKR): -$105 unrealized loss, held ${HELD_DAYS} days`);
  });

  it("a short the fee pulls back inside the threshold... is still judged on the fee-inclusive figure", () => {
    // Short 10 at 100 - 10 fee = 990; now 109.50 -> 1,095. Price move alone: -95. With the fee: -105.
    const db = createPendingTestDb();
    const id = seedSec(db, "ZZK");
    fill(db, id, "SELL", 10, 100, 10, { code: "O" });
    seedPx(db, id, daysAgo(2), 109.5);
    computeTaxLots(db);
    expect(pageLot(db, "ZZK").unrealized_gain).toBeCloseTo(-105, 2);
    const line = lineFor(section(getPortfolioSummaryForChat(db), "### Tax-Loss Harvesting Candidates"), "ZZK");
    expect(line).toContain("- ZZK short (IBKR): -$105 unrealized loss");
  });
});

describe("the tool description says what cost_basis means", () => {
  it("names cost_basis as the basis of the quantity still open", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/chat/tools.ts", "utf8");
    const start = src.indexOf('name: "query_tax_lots"');
    expect(start).toBeGreaterThan(-1);
    const description = src.slice(start, src.indexOf("input_schema", start));
    expect(description).toMatch(/cost_basis is the basis of the quantity still open/);
    expect(description).toMatch(/original_lot_cost_basis/);
  });
});
