import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  buildCombinedPositionsForEvents,
  formatCombinedPosition,
  type CombinedPosition,
} from "@/lib/calendar/briefing";
import type { CalendarEvent } from "@/lib/types";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // Migration 002 seeds default accounts: Vanguard Taxable (id=1),
  // Vanguard Roth IRA (id=2), IBKR (id=3). Tests below assume that order.
});

function seedStock(symbol: string, name?: string): number {
  const r = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)",
    )
    .run(symbol, name ?? `${symbol} Corp`);
  return r.lastInsertRowid as number;
}

function seedOption(
  symbol: string,
  underlying: string,
  strike: number,
  exp: string,
  optType: "CALL" | "PUT" = "CALL",
): number {
  const r = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, multiplier, underlying_symbol, strike_price, expiration_date, option_type)
       VALUES (?, ?, 'option', 'option', 100, ?, ?, ?, ?)`,
    )
    .run(symbol, `${underlying} option`, underlying, strike, exp, optType);
  return r.lastInsertRowid as number;
}

function seedHolding(
  secId: number,
  accountId: number,
  qty: number,
  asOfDate = "2026-04-27",
): void {
  db.prepare(
    "INSERT INTO holdings (security_id, account_id, quantity, as_of_date) VALUES (?, ?, ?, ?)",
  ).run(secId, accountId, qty, asOfDate);
}

function makeEvent(id: number, symbol: string): CalendarEvent {
  return {
    id,
    source: "finnhub",
    event_type: "earnings",
    event_date: "2026-04-29",
    title: `${symbol} earnings`,
    symbol,
    source_key: `finnhub:${symbol}:2026-04-29`,
  } as CalendarEvent;
}

describe("buildCombinedPositionsForEvents", () => {
  it("rolls up GOOG common into GOOGL earnings — the user-reported bug", () => {
    // The original bug: briefing ranked AMZN as "largest combined exposure"
    // for the week because GOOG common (Class C) didn't get linked to GOOGL
    // earnings (Class A ticker). issuerSiblings normalizes the family.
    const goog = seedStock("GOOG", "Alphabet Inc Cl C");
    seedHolding(goog, 1, 65.5);
    const googlLeap = seedOption(
      "GOOGL 270115C00220000",
      "GOOGL",
      220,
      "2027-01-15",
    );
    seedHolding(googlLeap, 1, 1);

    const currentPrices = new Map([
      ["GOOG", { close: 343.31, date: "2026-04-27" }],
    ]);

    const out = buildCombinedPositionsForEvents(
      db,
      [makeEvent(1, "GOOGL")],
      currentPrices,
    );

    const cp = out.get(1);
    expect(cp).toBeDefined();
    expect(cp!.family).toContain("GOOG");
    expect(cp!.family).toContain("GOOGL");
    expect(cp!.stockPositions).toHaveLength(1);
    expect(cp!.stockPositions[0]).toMatchObject({
      symbol: "GOOG",
      quantity: 65.5,
      account: "Vanguard Taxable",
      latestClose: 343.31,
    });
    expect(cp!.optionPositions).toHaveLength(1);
    expect(cp!.optionPositions[0]).toMatchObject({
      occSymbol: "GOOGL 270115C00220000",
      underlying: "GOOGL",
      strike: 220,
      optionType: "CALL",
      quantity: 1,
      account: "Vanguard Taxable",
    });
  });

  it("returns no entry for events whose issuer family has zero positions", () => {
    seedStock("AAPL");
    // No AAPL holdings seeded.
    const out = buildCombinedPositionsForEvents(
      db,
      [makeEvent(1, "AAPL")],
      new Map(),
    );
    expect(out.has(1)).toBe(false);
  });

  it("matches single-class issuers without an entry in the family map", () => {
    const aapl = seedStock("AAPL");
    seedHolding(aapl, 1, 100);
    const out = buildCombinedPositionsForEvents(
      db,
      [makeEvent(1, "AAPL")],
      new Map([["AAPL", { close: 267.75, date: "2026-04-27" }]]),
    );
    const cp = out.get(1);
    expect(cp).toBeDefined();
    expect(cp!.family).toEqual(["AAPL"]);
    expect(cp!.stockPositions[0].quantity).toBe(100);
  });

  it("includes options on any sibling underlying", () => {
    // User holds a GOOG option; event is for GOOGL.
    const goog = seedStock("GOOG");
    seedHolding(goog, 1, 0); // zero stock holding — only the option matters
    const googCall = seedOption("GOOG  260320C00250000", "GOOG", 250, "2026-03-20");
    seedHolding(googCall, 1, 2);

    const out = buildCombinedPositionsForEvents(
      db,
      [makeEvent(1, "GOOGL")],
      new Map([["GOOG", { close: 343.31, date: "2026-04-27" }]]),
    );
    const cp = out.get(1);
    expect(cp).toBeDefined();
    expect(cp!.optionPositions).toHaveLength(1);
    expect(cp!.optionPositions[0].underlying).toBe("GOOG");
  });

  it("returns latestClose=null when the price isn't available", () => {
    const goog = seedStock("GOOG");
    seedHolding(goog, 1, 65.5);
    const out = buildCombinedPositionsForEvents(
      db,
      [makeEvent(1, "GOOGL")],
      new Map(), // no prices
    );
    const cp = out.get(1);
    expect(cp).toBeDefined();
    expect(cp!.stockPositions[0].latestClose).toBeNull();
  });

  it("skips events with no symbol or no id", () => {
    const noIdEvent: CalendarEvent = {
      source: "finnhub",
      event_type: "earnings",
      event_date: "2026-04-29",
      title: "Nameless earnings",
      symbol: "AAPL",
      source_key: "finnhub:AAPL:2026-04-29",
    } as CalendarEvent;

    const noSymbolEvent: CalendarEvent = {
      id: 99,
      source: "finnhub",
      event_type: "earnings",
      event_date: "2026-04-29",
      title: "Macro event",
      source_key: "noid",
    } as CalendarEvent;

    const out = buildCombinedPositionsForEvents(
      db,
      [noIdEvent, noSymbolEvent],
      new Map(),
    );
    expect(out.size).toBe(0);
  });
});

describe("formatCombinedPosition", () => {
  // 2026-08-02: direction-only — share/contract counts AND fractional-share
  // fingerprints removed (count x public price reconstructs $ exposure in a
  // cc'd email). Same idiom as lib/digest/presence-only-position.ts.
  it("formats a stock+option combined position with no counts and no mkt val", () => {
    const cp: CombinedPosition = {
      family: ["GOOG", "GOOGL"],
      stockPositions: [
        { symbol: "GOOG", quantity: 65.5, account: "Vanguard", latestClose: 343.31 },
      ],
      optionPositions: [
        {
          occSymbol: "GOOGL 270115C00220000",
          underlying: "GOOGL",
          strike: 220,
          expiry: "2027-01-15",
          optionType: "CALL",
          quantity: 1,
          account: "Vanguard",
        },
      ],
    };
    const out = formatCombinedPosition(cp);
    expect(out).toContain("long GOOG (Vanguard)");
    expect(out).not.toContain("65.5"); // fractional share count = fingerprint
    expect(out).not.toContain("sh ");
    expect(out).not.toContain("mkt val");
    expect(out).not.toMatch(/\$\d{1,3}(,\d{3})+/); // no comma-grouped $ values
    expect(out).toContain("long GOOGL $220 calls exp 2027-01-15 (Vanguard)");
    expect(out).toContain(" + ");
  });

  it("stock lines carry no digits at all", () => {
    const cp: CombinedPosition = {
      family: ["AMZN"],
      stockPositions: [
        { symbol: "AMZN", quantity: 105, account: "Vanguard", latestClose: 263.2 },
      ],
      optionPositions: [],
    };
    const out = formatCombinedPosition(cp);
    expect(out).toBe("long AMZN (Vanguard)");
    expect(out).not.toMatch(/\d/);
  });

  it("renders SHORT stock with direction only", () => {
    const cp: CombinedPosition = {
      family: ["META"],
      stockPositions: [
        { symbol: "META", quantity: -200, account: "IBKR", latestClose: 400 },
      ],
      optionPositions: [],
    };
    const out = formatCombinedPosition(cp);
    expect(out).toBe("short META (IBKR)");
    expect(out).not.toContain("200");
  });

  it("renders SHORT options without a contract count", () => {
    const cp: CombinedPosition = {
      family: ["MSFT"],
      stockPositions: [],
      optionPositions: [
        {
          occSymbol: "MSFT 260516C00450000",
          underlying: "MSFT",
          strike: 450,
          expiry: "2026-05-16",
          optionType: "CALL",
          quantity: -2,
          account: "IBKR",
        },
      ],
    };
    const out = formatCombinedPosition(cp);
    expect(out).toBe("short MSFT $450 calls exp 2026-05-16 (IBKR)");
    expect(out).not.toContain("2 short");
  });

  it("does not emit mkt val even when latestClose is populated (privacy boundary)", () => {
    const cp: CombinedPosition = {
      family: ["XYZ"],
      stockPositions: [
        { symbol: "XYZ", quantity: 10, account: "IBKR", latestClose: 12345.67 },
      ],
      optionPositions: [],
    };
    const out = formatCombinedPosition(cp);
    expect(out).toBe("long XYZ (IBKR)");
    expect(out).not.toContain("mkt val");
    expect(out).not.toContain("$12,345");
    expect(out).not.toContain("$123,456");
  });
});
