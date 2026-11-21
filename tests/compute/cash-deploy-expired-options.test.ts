/**
 * Cash-Deploy leaves an EXPIRED option contract out (QA 2026-11-21).
 *
 * A contract past its expiry can still have a non-zero holdings row (the
 * purge keeps a one-day grace, and a row may outlive it). The What-if,
 * Scenarios and Defense cards already drop it through the one reader of a
 * stored expiry (lib/compute/option-expiry.ts); Cash-Deploy counted its last
 * mark in the sector weights, in `optionsAtMarketValue`, and as a "puts"
 * cause in `shortHeldSectors`. A LIVE option is still counted as before.
 *
 * Synthetic symbols and round figures only. Dates are relative to todayET().
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { addDays, todayET } from "@/lib/calendar/date-utils";
import { measureLongOnlyBook, suggestAllocation, type CashDeploySuggestion } from "@/lib/compute/cash-deploy";

let db: Database.Database;
const today = todayET();
const yesterday = addDays(today, -1);
const lastWeekCompact = addDays(today, -7).replace(/-/g, "");
const nextYear = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
let nextId = 1;

function add(
  symbol: string,
  o: {
    type: string;
    sector?: string | null;
    price: number;
    qty?: number;
    underlying?: string;
    optionType?: "PUT" | "CALL";
    strike?: number;
    expiration?: string;
    multiplier?: number;
  },
): number {
  const id = nextId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector, currency, multiplier,
       underlying_symbol, option_type, strike_price, expiration_date)
     VALUES (?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    symbol,
    o.type,
    o.sector ?? null,
    o.multiplier ?? null,
    o.underlying ?? null,
    o.optionType ?? null,
    o.strike ?? null,
    o.expiration ?? null,
  );
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`).run(
    id,
    today,
    o.price,
  );
  if (o.qty !== undefined) {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, ?, ?)`,
    ).run(id, today, o.qty, `exp-${symbol}`);
  }
  return id;
}

function baseBook() {
  add("AAA", { type: "Stock", sector: "Technology", price: 100, qty: 100 });
  add("AAB", { type: "Stock", sector: "Industrials", price: 100, qty: 400 });
  const t = add("AAT", { type: "Stock", sector: "Technology", price: 100 });
  db.prepare(
    `INSERT INTO watchlist (security_id, group_name, is_active, thesis, added_date) VALUES (?, 'vanguard_buy', 1, 'test', ?)`,
  ).run(t, today);
}

function expiredOptions() {
  // An expired put WITH Greeks inputs (strike, expiry): it would read as a hedge.
  add("AAA   P100", {
    type: "Option",
    price: 8,
    qty: 5,
    multiplier: 100,
    underlying: "AAA",
    optionType: "PUT",
    strike: 100,
    expiration: yesterday,
  });
  // An expired call with no strike (no Greeks), stored in the legacy compact form.
  add("AAA   C100", {
    type: "Option",
    price: 10,
    qty: 3,
    multiplier: 100,
    underlying: "AAA",
    optionType: "CALL",
    expiration: lastWeekCompact,
  });
}

function liveNoGreeksCall() {
  add("ZZZ   C100", {
    type: "Option",
    price: 10,
    qty: 2,
    multiplier: 100,
    underlying: "AAA",
    optionType: "CALL",
    expiration: nextYear,
  });
}

const cents = (x: number) => Math.round(x * 100);

function expectConserved(r: CashDeploySuggestion, cash: number) {
  const picked = r.picks.reduce((s, p) => s + cents(p.allocationDollars), 0);
  expect(picked + cents(r.cashRemaining)).toBe(cents(cash));
}

function freshDb() {
  nextId = 1;
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("DELETE FROM watchlist").run();
  db.prepare("UPDATE settings SET value = ? WHERE key = 'construction_caps_vanguard'").run(
    JSON.stringify({ top1_max: 1 }),
  );
}

beforeEach(freshDb);

describe("Cash-Deploy leaves expired option contracts out", () => {
  it("an expired put and an expired no-Greeks call change nothing", () => {
    baseBook();
    const baseline = suggestAllocation(db, "vanguard", [1], 10_000);
    const baselineBook = measureLongOnlyBook(db, "vanguard", [1], 10_000);

    freshDb();
    baseBook();
    expiredOptions();
    const r = suggestAllocation(db, "vanguard", [1], 10_000);
    const book = measureLongOnlyBook(db, "vanguard", [1], 10_000);

    expect(r.optionsAtMarketValue).toBe(0);
    expect(r.shortHeldSectors).toEqual([]);
    expect(r.shortHeldSectors.flatMap((s) => s.causes)).not.toContain("puts");
    expect(r.gaps).toEqual(baseline.gaps);
    expect(r.picks).toEqual(baseline.picks);
    expect(book).toEqual(baselineBook);
    expect(book.sectors.flatMap((s) => s.causes)).toEqual([]);
    expectConserved(r, 10_000);
  });

  it("a live no-Greeks option is still counted at market value", () => {
    baseBook();
    expiredOptions();
    liveNoGreeksCall();
    const r = suggestAllocation(db, "vanguard", [1], 10_000);
    expect(r.optionsAtMarketValue).toBe(1);
    const tech = measureLongOnlyBook(db, "vanguard", [1], 10_000).sectors.find((s) => s.sector === "Technology");
    // 10,000 of stock plus the live call's 2 x 10 x 100 mark.
    expect(tech?.longDollars).toBeCloseTo(12_000, 6);
    expectConserved(r, 10_000);
  });
});
