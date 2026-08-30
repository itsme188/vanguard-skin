import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  buildCurrentPrices,
  formatCurrentPricesBlock,
} from "@/lib/calendar/briefing";
import type { CalendarEvent } from "@/lib/types";
import { upsertFxRate } from "@/lib/mutations/fx-rates";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  // Migrations may seed default accounts; INSERT OR IGNORE keeps the test
  // robust to either case.
  db.prepare(
    "INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Vanguard'), (2, 'IBKR')"
  ).run();
});

function seedStock(symbol: string): number {
  const r = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)"
    )
    .run(symbol, `${symbol} Corp`);
  return r.lastInsertRowid as number;
}

function seedOption(
  symbol: string,
  underlying: string,
  strike: number,
  exp: string
): number {
  const r = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, multiplier, underlying_symbol, strike_price, expiration_date, option_type)
       VALUES (?, ?, 'option', 'option', 100, ?, ?, ?, 'CALL')`
    )
    .run(symbol, `${underlying} call`, underlying, strike, exp);
  return r.lastInsertRowid as number;
}

function seedHolding(
  secId: number,
  accountId: number,
  qty: number,
  asOfDate = "2026-04-27"
): void {
  db.prepare(
    "INSERT INTO holdings (security_id, account_id, quantity, as_of_date) VALUES (?, ?, ?, ?)"
  ).run(secId, accountId, qty, asOfDate);
}

function seedPrice(secId: number, price: number, date = "2026-04-27"): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')"
  ).run(secId, date, price);
}

describe("buildCurrentPrices", () => {
  it("returns an empty map when there's nothing to price", () => {
    const out = buildCurrentPrices(db, {
      holdings: [],
      expiringOptions: [],
      portfolioEarnings: [],
      wshEarnings: [],
    });
    expect(out.size).toBe(0);
    expect(formatCurrentPricesBlock(out)).toBe("");
  });

  it("includes prices for held stocks", () => {
    const aapl = seedStock("AAPL");
    seedHolding(aapl, 1, 100);
    seedPrice(aapl, 267.75);

    const out = buildCurrentPrices(db, {
      holdings: [{ symbol: "AAPL" }],
      expiringOptions: [],
      portfolioEarnings: [],
      wshEarnings: [],
    });

    expect(out.get("AAPL")).toEqual({ close: 267.75, date: "2026-04-27" });
  });

  it("includes underlyings of options the user holds even when the stock isn't held — the TER LEAP case", () => {
    // User holds a Jan '28 $180 TER call but no TER stock. Without this,
    // the briefing model has no price for TER and fabricates one.
    const ter = seedStock("TER");
    seedPrice(ter, 420.0);
    const terCall = seedOption("TER  280121C00180000", "TER", 180, "2028-01-21");
    seedHolding(terCall, 1, 1);

    const out = buildCurrentPrices(db, {
      holdings: [], // intentionally empty: no TER stock holding
      expiringOptions: [], // option doesn't expire this week
      portfolioEarnings: [],
      wshEarnings: [],
    });

    // The function must discover TER via the option-underlyings sub-query.
    expect(out.has("TER")).toBe(true);
    expect(out.get("TER")?.close).toBe(420.0);
  });

  it("picks the most recent price when multiple are available", () => {
    const hood = seedStock("HOOD");
    seedHolding(hood, 1, 400);
    seedPrice(hood, 80.0, "2026-04-20");
    seedPrice(hood, 84.43, "2026-04-27");
    seedPrice(hood, 82.0, "2026-04-23");

    const out = buildCurrentPrices(db, {
      holdings: [{ symbol: "HOOD" }],
      expiringOptions: [],
      portfolioEarnings: [],
      wshEarnings: [],
    });

    expect(out.get("HOOD")).toEqual({ close: 84.43, date: "2026-04-27" });
  });

  it("does not include options themselves — only the stock/ETF/etc. underlying gets priced", () => {
    const ter = seedStock("TER");
    seedPrice(ter, 420.0);
    const terCall = seedOption("TER  280121C00180000", "TER", 180, "2028-01-21");
    seedHolding(terCall, 1, 1);

    const out = buildCurrentPrices(db, {
      holdings: [],
      expiringOptions: [],
      portfolioEarnings: [],
      wshEarnings: [],
    });

    // The OCC-format option symbol should not appear (no price expected for the option itself).
    expect(out.has("TER  280121C00180000")).toBe(false);
    // The underlying TER should appear.
    expect(out.has("TER")).toBe(true);
  });

  it("includes earnings tickers (so an event-driven name has a price)", () => {
    const xom = seedStock("XOM");
    seedPrice(xom, 149.54);

    const earnings: CalendarEvent = {
      id: 1,
      source: "finnhub",
      event_type: "earnings",
      event_date: "2026-05-01",
      title: "XOM earnings",
      symbol: "XOM",
      source_key: "finnhub:XOM:2026-05-01",
    } as CalendarEvent;

    const out = buildCurrentPrices(db, {
      holdings: [],
      expiringOptions: [],
      portfolioEarnings: [earnings],
      wshEarnings: [],
    });

    expect(out.get("XOM")?.close).toBe(149.54);
  });

  // ── per-(account, security) "latest" keying ──────────────────────
  //
  // The option-underlyings sub-query keyed "latest" off a per-ACCOUNT
  // MAX(as_of_date). A LEAP that only restates on the monthly statement lost
  // to a same-account daily row for another security, so the underlying was
  // never discovered — and Opus, handed no price, fabricated one.

  it("discovers an option underlying whose leg lags behind a newer row for another security in the same account", () => {
    const ter = seedStock("TER");
    seedPrice(ter, 420.0);
    const terCall = seedOption("TER  280121C00180000", "TER", 180, "2028-01-21");
    seedHolding(terCall, 1, 1, "2026-03-31"); // monthly statement row
    const aapl = seedStock("AAPL");
    seedHolding(aapl, 1, 100, "2026-04-27"); // newer daily row, same account

    const out = buildCurrentPrices(db, {
      holdings: [], // TER stock is not held — discovery is via the option
      expiringOptions: [],
      portfolioEarnings: [],
      wshEarnings: [],
    });

    expect(out.has("TER")).toBe(true);
    expect(out.get("TER")?.close).toBe(420.0);
  });

  it("does not discover an underlying whose option leg is a quantity=0 tombstone", () => {
    const ter = seedStock("TER");
    seedPrice(ter, 420.0);
    const terCall = seedOption("TER  280121C00180000", "TER", 180, "2028-01-21");
    seedHolding(terCall, 1, 1, "2026-03-31");
    seedHolding(terCall, 1, 0, "2026-04-27"); // closed-position tombstone

    const out = buildCurrentPrices(db, {
      holdings: [],
      expiringOptions: [],
      portfolioEarnings: [],
      wshEarnings: [],
    });

    expect(out.has("TER")).toBe(false);
  });
});

describe("formatCurrentPricesBlock", () => {
  it("returns empty string for empty map", () => {
    expect(formatCurrentPricesBlock(new Map())).toBe("");
  });

  it("formats prices alphabetically with dollar precision", () => {
    const m = new Map([
      ["TER", { close: 420.8, date: "2026-04-27" }],
      ["AAPL", { close: 267.75, date: "2026-04-27" }],
      ["GOOG", { close: 343.31, date: "2026-04-27" }],
    ]);
    const out = formatCurrentPricesBlock(m);
    expect(out).toBe(
      "- AAPL: $267.75 (2026-04-27)\n- GOOG: $343.31 (2026-04-27)\n- TER: $420.80 (2026-04-27)"
    );
  });
});

describe("buildCurrentPrices FX conversion", () => {
  it("converts a foreign-currency close to USD before it reaches the LLM prompt", () => {
    const krw = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier, currency) VALUES ('402340', 'Hanwha Vision', 'stock', 'equity', 1, 'KRW')"
      )
      .run().lastInsertRowid as number;
    seedHolding(krw, 1, 10);
    seedPrice(krw, 1_602_000);
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.0006531, asOf: "2026-07-03", source: "test" });

    const out = buildCurrentPrices(db, {
      holdings: [{ symbol: "402340" }],
      expiringOptions: [],
      portfolioEarnings: [],
      wshEarnings: [],
    });

    // Opus reads "402340 closed at $X" verbatim — native won here means the
    // model narrates a $1.6M/share stock.
    expect(out.get("402340")!.close).toBeCloseTo(1_602_000 * 0.0006531, 4);
    expect(out.get("402340")!.close).toBeLessThan(2_000);
  });
});
