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
    const aapl = seedStock("ZZZ");
    seedHolding(aapl, 1, 100);
    seedPrice(aapl, 70);

    const out = buildCurrentPrices(db, {
      holdings: [{ symbol: "ZZZ" }],
      expiringOptions: [],
      portfolioEarnings: [],
      wshEarnings: [],
    });

    expect(out.get("ZZZ")).toEqual({ close: 70, date: "2026-04-27" });
  });

  it("includes underlyings of options the user holds even when the stock isn't held — the AAA LEAP case", () => {
    // User holds a Jan '28 $120 AAA call but no AAA stock. Without this,
    // the briefing model has no price for AAA and fabricates one.
    const ter = seedStock("AAA");
    seedPrice(ter, 275.0);
    const terCall = seedOption("AAA  280121C00120000", "AAA", 120, "2028-01-21");
    seedHolding(terCall, 1, 1);

    const out = buildCurrentPrices(db, {
      holdings: [], // intentionally empty: no AAA stock holding
      expiringOptions: [], // option doesn't expire this week
      portfolioEarnings: [],
      wshEarnings: [],
    });

    // The function must discover AAA via the option-underlyings sub-query.
    expect(out.has("AAA")).toBe(true);
    expect(out.get("AAA")?.close).toBe(275.0);
  });

  it("picks the most recent price when multiple are available", () => {
    const hood = seedStock("BBB");
    seedHolding(hood, 1, 100);
    seedPrice(hood, 61.0, "2026-04-20");
    seedPrice(hood, 66.5, "2026-04-27");
    seedPrice(hood, 63.5, "2026-04-23");

    const out = buildCurrentPrices(db, {
      holdings: [{ symbol: "BBB" }],
      expiringOptions: [],
      portfolioEarnings: [],
      wshEarnings: [],
    });

    expect(out.get("BBB")).toEqual({ close: 66.5, date: "2026-04-27" });
  });

  it("does not include options themselves — only the stock/ETF/etc. underlying gets priced", () => {
    const ter = seedStock("AAA");
    seedPrice(ter, 275.0);
    const terCall = seedOption("AAA  280121C00120000", "AAA", 120, "2028-01-21");
    seedHolding(terCall, 1, 1);

    const out = buildCurrentPrices(db, {
      holdings: [],
      expiringOptions: [],
      portfolioEarnings: [],
      wshEarnings: [],
    });

    // The OCC-format option symbol should not appear (no price expected for the option itself).
    expect(out.has("AAA  280121C00120000")).toBe(false);
    // The underlying AAA should appear.
    expect(out.has("AAA")).toBe(true);
  });

  it("includes earnings tickers (so an event-driven name has a price)", () => {
    const xom = seedStock("CCC");
    seedPrice(xom, 45.25);

    const earnings: CalendarEvent = {
      id: 1,
      source: "finnhub",
      event_type: "earnings",
      event_date: "2026-05-01",
      title: "CCC earnings",
      symbol: "CCC",
      source_key: "finnhub:CCC:2026-05-01",
    } as CalendarEvent;

    const out = buildCurrentPrices(db, {
      holdings: [],
      expiringOptions: [],
      portfolioEarnings: [earnings],
      wshEarnings: [],
    });

    expect(out.get("CCC")?.close).toBe(45.25);
  });

  // ── per-(account, security) "latest" keying ──────────────────────
  //
  // The option-underlyings sub-query keyed "latest" off a per-ACCOUNT
  // MAX(as_of_date). A LEAP that only restates on the monthly statement lost
  // to a same-account daily row for another security, so the underlying was
  // never discovered — and Opus, handed no price, fabricated one.

  it("discovers an option underlying whose leg lags behind a newer row for another security in the same account", () => {
    const ter = seedStock("AAA");
    seedPrice(ter, 275.0);
    const terCall = seedOption("AAA  280121C00120000", "AAA", 120, "2028-01-21");
    seedHolding(terCall, 1, 1, "2026-03-31"); // monthly statement row
    const aapl = seedStock("ZZZ");
    seedHolding(aapl, 1, 100, "2026-04-27"); // newer daily row, same account

    const out = buildCurrentPrices(db, {
      holdings: [], // AAA stock is not held — discovery is via the option
      expiringOptions: [],
      portfolioEarnings: [],
      wshEarnings: [],
    });

    expect(out.has("AAA")).toBe(true);
    expect(out.get("AAA")?.close).toBe(275.0);
  });

  it("does not discover an underlying whose option leg is a quantity=0 tombstone", () => {
    const ter = seedStock("AAA");
    seedPrice(ter, 275.0);
    const terCall = seedOption("AAA  280121C00120000", "AAA", 120, "2028-01-21");
    seedHolding(terCall, 1, 1, "2026-03-31");
    seedHolding(terCall, 1, 0, "2026-04-27"); // closed-position tombstone

    const out = buildCurrentPrices(db, {
      holdings: [],
      expiringOptions: [],
      portfolioEarnings: [],
      wshEarnings: [],
    });

    expect(out.has("AAA")).toBe(false);
  });
});

describe("formatCurrentPricesBlock", () => {
  it("returns empty string for empty map", () => {
    expect(formatCurrentPricesBlock(new Map())).toBe("");
  });

  it("formats prices alphabetically with dollar precision", () => {
    const m = new Map([
      ["AAA", { close: 275.8, date: "2026-04-27" }],
      ["ZZZ", { close: 70, date: "2026-04-27" }],
      ["GGG", { close: 90, date: "2026-04-27" }],
    ]);
    const out = formatCurrentPricesBlock(m);
    expect(out).toBe(
      "- AAA: $275.80 (2026-04-27)\n- GGG: $90.00 (2026-04-27)\n- ZZZ: $70.00 (2026-04-27)"
    );
  });
});

describe("buildCurrentPrices FX conversion", () => {
  it("converts a foreign-currency close to USD before it reaches the LLM prompt", () => {
    const krw = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier, currency) VALUES ('000001', 'Synthetic KRW Corp', 'stock', 'equity', 1, 'KRW')"
      )
      .run().lastInsertRowid as number;
    seedHolding(krw, 1, 12);
    seedPrice(krw, 2_400_000);
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.0007, asOf: "2026-07-03", source: "test" });

    const out = buildCurrentPrices(db, {
      holdings: [{ symbol: "000001" }],
      expiringOptions: [],
      portfolioEarnings: [],
      wshEarnings: [],
    });

    // Opus reads "000001 closed at $X" verbatim — native won here means the
    // model narrates a $2.4M/share stock.
    expect(out.get("000001")!.close).toBeCloseTo(2_400_000 * 0.0007, 4);
    expect(out.get("000001")!.close).toBeLessThan(2_000);
  });
});
