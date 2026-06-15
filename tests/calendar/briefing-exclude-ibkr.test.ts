import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getBriefingHoldings,
  buildCombinedPositionsForEvents,
} from "@/lib/calendar/briefing";
import type { CalendarEvent } from "@/lib/types";

// Migration 002 seeds default accounts:
//   Vanguard Taxable (id=1), Vanguard Roth IRA (id=2), IBKR (id=3).
const VANGUARD_TAXABLE = 1;
const VANGUARD_ROTH = 2;
const IBKR = 3;

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedStock(symbol: string, sector?: string): number {
  const r = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, sector, multiplier) VALUES (?, ?, 'stock', 'equity', ?, 1)",
    )
    .run(symbol, `${symbol} Corp`, sector ?? null);
  return r.lastInsertRowid as number;
}

function seedEtf(symbol: string): number {
  const r = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'ETF', 'equity', 1)",
    )
    .run(symbol, `${symbol} ETF`);
  return r.lastInsertRowid as number;
}

function seedOption(
  symbol: string,
  underlying: string,
  strike: number,
  exp: string,
): number {
  const r = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, multiplier, underlying_symbol, strike_price, expiration_date, option_type)
       VALUES (?, ?, 'option', 'option', 100, ?, ?, ?, 'PUT')`,
    )
    .run(symbol, `${underlying} option`, underlying, strike, exp);
  return r.lastInsertRowid as number;
}

function seedHolding(
  secId: number,
  accountId: number,
  qty: number,
  asOfDate = "2026-06-15",
): void {
  db.prepare(
    "INSERT INTO holdings (security_id, account_id, quantity, as_of_date) VALUES (?, ?, ?, ?)",
  ).run(secId, accountId, qty, asOfDate);
}

describe("getBriefingHoldings — IBKR exclusion (U4: 'holds QQQ outright' bug)", () => {
  it("excludes a position held ONLY in IBKR (the QQQ case)", () => {
    // QQQ held only in IBKR — exactly the real-world bug. It must NOT appear
    // in the briefing's portfolio context.
    const qqq = seedEtf("QQQ");
    seedHolding(qqq, IBKR, 20);

    // A genuine Vanguard holding that SHOULD appear.
    const vti = seedEtf("VTI");
    seedHolding(vti, VANGUARD_TAXABLE, 100);

    const holdings = getBriefingHoldings(db);
    const symbols = holdings.map((h) => h.symbol);

    expect(symbols).toContain("VTI");
    expect(symbols).not.toContain("QQQ");
  });

  it("includes a Vanguard position and excludes the IBKR leg of the same symbol", () => {
    // AAPL held in BOTH Vanguard Taxable and IBKR. The briefing's net_qty
    // must reflect ONLY the Vanguard legs.
    const aapl = seedStock("AAPL", "Technology");
    seedHolding(aapl, VANGUARD_TAXABLE, 50);
    seedHolding(aapl, VANGUARD_ROTH, 10);
    seedHolding(aapl, IBKR, 1000); // huge IBKR position must be ignored

    const holdings = getBriefingHoldings(db);
    const aaplRow = holdings.find((h) => h.symbol === "AAPL");

    expect(aaplRow).toBeDefined();
    // 50 (Taxable) + 10 (Roth) = 60, NOT 1060.
    expect(aaplRow!.net_qty).toBe(60);
  });

  it("still surfaces Vanguard net shorts (A7 behavior preserved)", () => {
    const msft = seedStock("MSFT", "Technology");
    seedHolding(msft, VANGUARD_TAXABLE, -25);

    const holdings = getBriefingHoldings(db);
    const msftRow = holdings.find((h) => h.symbol === "MSFT");

    expect(msftRow).toBeDefined();
    expect(msftRow!.net_qty).toBe(-25);
  });

  it("returns nothing when the user holds the name only in IBKR", () => {
    const qqq = seedEtf("QQQ");
    seedHolding(qqq, IBKR, 20);
    const qqqPut = seedOption("QQQ 260612P00715000", "QQQ", 715, "2026-06-12");
    seedHolding(qqqPut, IBKR, -5);

    expect(getBriefingHoldings(db)).toHaveLength(0);
  });
});

describe("buildCombinedPositionsForEvents — IBKR exclusion", () => {
  it("omits IBKR-only positions from an earnings event roster", () => {
    const nvda = seedStock("NVDA", "Technology");
    seedHolding(nvda, IBKR, 30); // IBKR-only → excluded

    const event = {
      id: 1,
      source: "finnhub",
      event_type: "earnings",
      event_date: "2026-06-18",
      title: "NVDA earnings",
      symbol: "NVDA",
      source_key: "finnhub:NVDA:2026-06-18",
    } as CalendarEvent;

    const out = buildCombinedPositionsForEvents(db, [event], new Map());
    // No Vanguard position → no roster entry at all.
    expect(out.has(1)).toBe(false);
  });

  it("keeps the Vanguard leg and drops the IBKR leg for a split-account name", () => {
    const nvda = seedStock("NVDA", "Technology");
    seedHolding(nvda, VANGUARD_ROTH, 5);
    seedHolding(nvda, IBKR, 30);

    const event = {
      id: 2,
      source: "finnhub",
      event_type: "earnings",
      event_date: "2026-06-18",
      title: "NVDA earnings",
      symbol: "NVDA",
      source_key: "finnhub:NVDA:2026-06-18",
    } as CalendarEvent;

    const out = buildCombinedPositionsForEvents(db, [event], new Map());
    const cp = out.get(2);
    expect(cp).toBeDefined();
    expect(cp!.stockPositions).toHaveLength(1);
    expect(cp!.stockPositions[0]).toMatchObject({
      symbol: "NVDA",
      quantity: 5,
      account: "Vanguard Roth IRA",
    });
  });
});
