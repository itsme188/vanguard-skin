/**
 * query_options_book (Portfolio Assistant plan, Task 6).
 *
 * Protects: the expiries and exposure the chat quotes are the Expirations
 * card's and the Analysis page's own (getExpiringOptions,
 * getPortfolioExposureSummary), live contracts only, shorts kept with their
 * sign. Bound: a book of +1,000 and -200 of stock has net exposure 800 and
 * gross 1,200 exactly; the listed contract count over a window that covers
 * every live contract equals the holdings tool's live option rows.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/compute/options-expirations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compute/options-expirations")>();
  return { ...actual, getExpiringOptions: vi.fn(actual.getExpiringOptions) };
});
vi.mock("@/lib/compute/exposure", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compute/exposure")>();
  return { ...actual, getPortfolioExposureSummary: vi.fn(actual.getPortfolioExposureSummary) };
});

import { getExpiringOptions } from "@/lib/compute/options-expirations";
import { getPortfolioExposureSummary } from "@/lib/compute/exposure";
import { getHoldingsForChat } from "@/lib/queries/chat-tools";
import { queryOptionsBookTool } from "@/lib/chat/composite/options-book";
import { COMPOSITE_MAX_JSON_CHARS } from "@/lib/chat/composite/shared";
import { addDays, todayET } from "@/lib/calendar/date-utils";

const TODAY = todayET();
let db: Database.Database;
let n = 0;

function hold(accountId: number, securityId: number, qty: number, price: number): void {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, 1, ?, ?)",
  ).run(accountId, securityId, qty, TODAY, `h-${++n}`);
  db.prepare("INSERT OR IGNORE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(securityId, TODAY, price);
}

function stock(symbol: string, accountId: number, qty: number, price: number): void {
  const id = db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'Stock', 'USD')")
    .run(symbol, `${symbol} Co`).lastInsertRowid as number;
  hold(accountId, id, qty, price);
}

function option(underlying: string, type: "C" | "P", strike: number, daysOut: number, accountId: number, qty: number): void {
  const exp = addDays(TODAY, daysOut);
  const symbol = `${underlying} ${exp.replace(/-/g, "").slice(2)}${type}${String(strike * 1000).padStart(8, "0")}`;
  const id = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, currency, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
       VALUES (?, ?, 'Option', 'USD', ?, ?, ?, ?, 100)`,
    )
    .run(symbol, symbol, underlying, type === "C" ? "CALL" : "PUT", strike, exp).lastInsertRowid as number;
  hold(accountId, id, qty, 1.5);
}

type Out = {
  error?: string;
  contracts: { symbol: string; type: string; days_to_expiry: number; quantity: number; account: string }[];
  list_info: { returned: number; truncated: boolean };
  totals_in_window: { positions: number; short_positions: number; long_positions: number };
  exposure: { total_market_value_usd: number; net_exposure_usd: number; gross_exposure_usd: number; net_ratio: number | null; gross_ratio: number | null };
  excluded: { expired_option_positions: number };
  scope: { account_names: string[] };
};

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  n = 0;
  vi.mocked(getExpiringOptions).mockClear();
  vi.mocked(getPortfolioExposureSummary).mockClear();
  // Account 1: stock only, +1,000 long and -200 short.
  stock("LNG", 1, 100, 10);
  stock("SHT", 1, -20, 10);
  // Account 3: a short put in 10 days, a long call in 45 days, a call that expired 5 days ago.
  stock("XYZ", 3, 10, 50);
  option("XYZ", "P", 45, 10, 3, -2);
  option("XYZ", "C", 60, 45, 3, 1);
  option("XYZ", "C", 55, -5, 3, 3);
});

describe("query_options_book", () => {
  it("returns the engines' figures for the same scope (parity)", () => {
    const out = queryOptionsBookTool.run(db, { days: 60 }, { accountIds: [3], today: TODAY }) as Out;
    const rows = getExpiringOptions(db, { accountIds: [3], daysWindow: 60, today: TODAY });
    const exp = getPortfolioExposureSummary(db, [3], TODAY);
    expect(out.contracts.map((c) => [c.symbol, c.days_to_expiry, c.quantity])).toEqual(
      rows.map((r) => [r.symbol, r.daysToExpiry, r.quantity]),
    );
    expect(out.exposure.net_exposure_usd).toBe(exp.net_exposure);
    expect(out.exposure.gross_exposure_usd).toBe(exp.gross_exposure);
    expect(out.exposure.total_market_value_usd).toBe(exp.total_market_value);
  });

  it("matches the hand-worked window, signs and exposure", () => {
    const opts = queryOptionsBookTool.run(db, {}, { accountIds: [3], today: TODAY }) as Out;
    // Default 30 days: only the short put (10 days) is inside.
    expect(opts.contracts).toHaveLength(1);
    expect(opts.contracts[0]).toMatchObject({ type: "PUT", days_to_expiry: 10, quantity: -2, account: "IBKR" });
    expect(opts.totals_in_window).toEqual({ positions: 1, short_positions: 1, long_positions: 0 });
    expect(opts.excluded.expired_option_positions).toBe(1);

    const stocks = queryOptionsBookTool.run(db, {}, { accountIds: [1], today: TODAY }) as Out;
    expect(stocks.exposure.total_market_value_usd).toBeCloseTo(800, 9);
    expect(stocks.exposure.net_exposure_usd).toBeCloseTo(800, 9);
    expect(stocks.exposure.gross_exposure_usd).toBeCloseTo(1200, 9);
    expect(stocks.exposure.net_ratio).toBeCloseTo(1, 9);
    expect(stocks.exposure.gross_ratio).toBeCloseTo(1.5, 9);
    expect(stocks.scope.account_names).toEqual(["Vanguard Taxable"]);
    expect(JSON.stringify(stocks)).not.toContain("XYZ");
    expect(JSON.stringify(stocks)).not.toContain("IBKR");
  });

  it("lists every live contract the holdings tool shows when the window covers them (conservation)", () => {
    const out = queryOptionsBookTool.run(db, { days: 120 }, { accountIds: undefined, today: TODAY }) as Out;
    const liveOptionRows = getHoldingsForChat(db, { security_type: "option", includeShorts: true, noLimit: true });
    expect(out.totals_in_window.positions).toBe(liveOptionRows.length);
    expect(out.totals_in_window.positions).toBe(2);
  });

  it("strict days: zero, negative, fractional, too large or non-numeric is an error (R6-9)", () => {
    for (const days of [0, -5, 2.5, 121, "30"]) {
      const out = queryOptionsBookTool.run(db, { days }, { accountIds: undefined, today: TODAY }) as Out;
      expect(out.error, String(days)).toBe("days must be a whole number of days from 1 to 120 (default 30).");
    }
    expect(getExpiringOptions).not.toHaveBeenCalled();
  });

  it("does not claim the card's window: the description states the 30-day default and the card's 90 (R6-6)", () => {
    const d = queryOptionsBookTool.definition.description ?? "";
    expect(d).not.toMatch(/as the Expirations card lists them/);
    expect(d).toMatch(/default the next 30 days, at most 120; the Expirations card's own default is 90/);
  });

  it("an empty scope answers without calling either engine", () => {
    const out = queryOptionsBookTool.run(db, {}, { accountIds: [], today: TODAY });
    expect(out).toEqual({ error: "No account is in this chat's scope." });
    expect(getExpiringOptions).not.toHaveBeenCalled();
    expect(getPortfolioExposureSummary).not.toHaveBeenCalled();
  });

  it("caps the list, writes nothing and stays under the size cap with 60 contracts", () => {
    for (let i = 0; i < 60; i++) option(`U${i}`, i % 2 ? "C" : "P", 20 + i, 5 + i, 3, i % 3 === 0 ? -1 : 2);
    const before = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const out = queryOptionsBookTool.run(db, { days: 120, limit: 999 }, { accountIds: undefined, today: TODAY }) as Out;
    const after = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    expect(after).toBe(before);
    expect(out.contracts).toHaveLength(25);
    expect(out.list_info.truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThan(COMPOSITE_MAX_JSON_CHARS);
  });
});
