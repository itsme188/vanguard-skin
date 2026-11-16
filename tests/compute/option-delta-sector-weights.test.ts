/**
 * Option rows in the sector tables of Cash deploy and the What-if (review
 * finding S-B1, 2026-11-15). An option enters its sector at its DELTA-ADJUSTED
 * exposure (lib/compute/exposure.ts `perValueDollar`, the path the What-if
 * beta already used), never at its market value: a long put is short
 * exposure and must LOWER its sector's weight. Where the Greeks cannot
 * compute, the row falls back to its market value and is counted. An option
 * on a fund with stored sector weights is spread by those weights.
 *
 * Denominator (both engines): the book's NET MARKET VALUE, options at their
 * market value (the dollars in the book), so the two cards agree on every
 * sector weight for the same scope.
 *
 * Synthetic symbols and round figures only. Vanguard scope = account 1,
 * benchmark VTI.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { todayET } from "@/lib/calendar/date-utils";
import { suggestAllocation, NET_OF_SHORTS_CAPTION } from "@/lib/compute/cash-deploy";
import { computeExposureDelta } from "@/lib/compute/exposure-delta";
import { getOptionExposureMap } from "@/lib/compute/exposure";

let db: Database.Database;
const today = todayET();
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
    optionType?: string;
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
    ).run(id, today, o.qty, `od-${symbol}`);
  }
  return id;
}

function fundWeights(symbol: string, weights: Array<[string, number]>) {
  const ins = db.prepare(
    `INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES (?, ?, ?, ?, 'manual')`,
  );
  for (const [s, p] of weights) ins.run(symbol, s, p, today);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("DELETE FROM watchlist").run();
  nextId = 1;
});

/** Stock 10,000 Technology + 10,000 Industrials; a long at-the-money put on the tech name. */
function bookWithLongPut(withGreeks = true): number {
  add("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 100 });
  add("ZZI", { type: "Stock", sector: "Industrials", price: 100, qty: 100 });
  // Option's own sector left blank: the underlying's sector is read.
  return add("ZZA   PUT100", {
    type: "Option",
    price: 8,
    qty: 1,
    multiplier: 100,
    underlying: "ZZA",
    optionType: "PUT",
    strike: withGreeks ? 100 : undefined,
    expiration: withGreeks ? nextYear : undefined,
  });
}

/** A sector's dollars as Cash deploy measures them, from its public output. */
function cashDeploySectorDollars(cash: number, sector: string, netValue: number): number {
  const r = suggestAllocation(db, "vanguard", [1], cash);
  const gap = r.gaps.find((g) => g.sector === sector);
  if (!gap) throw new Error(`no gap row for ${sector}`);
  expect(r.excludedSleeve).toBeNull();
  return gap.currentWeight * (netValue + cash);
}

describe("S-B1: a long put lowers its sector's weight in the What-if", () => {
  it("weights the put at delta-adjusted exposure, below the stock-only weight", () => {
    const putId = bookWithLongPut();
    const perValue = getOptionExposureMap(db, [1]).perValueDollar.get(putId);
    expect(perValue).toBeDefined();
    expect(perValue!).toBeLessThan(0);

    const d = computeExposureDelta(db, "vanguard", [1], []);
    // Denominator: net market value, the put at its 800 of market value.
    expect(d.before.totalValue).toBeCloseTo(20_800, 6);
    const stockOnly = 10_000 / 20_800;
    const expected = (10_000 + 800 * perValue!) / 20_800;
    expect(d.before.sectorWeights.Technology).toBeCloseTo(expected, 9);
    expect(d.before.sectorWeights.Technology).toBeLessThan(stockOnly);
    // Before the fix the put ADDED its market value: 10,800 / 20,800.
    expect(d.before.sectorWeights.Technology).toBeLessThan(10_800 / 20_800);
    expect(d.before.sectorWeights.Unknown).toBeUndefined();
    expect(d.before.optionsAtMarketValue).toBe(0);
  });

  it("an option whose Greeks cannot compute enters at market value and is counted", () => {
    bookWithLongPut(false);
    const d = computeExposureDelta(db, "vanguard", [1], []);
    expect(d.before.sectorWeights.Technology).toBeCloseTo(10_800 / 20_800, 9);
    expect(d.before.optionsAtMarketValue).toBe(1);
  });

  it("an option on a fund with stored weights is spread by those weights", () => {
    add("ZZI", { type: "Stock", sector: "Industrials", price: 100, qty: 100 }); // 10,000
    add("ZZIX", { type: "ETF", sector: "Diversified", price: 100 }); // not held
    fundWeights("ZZIX", [["Technology", 60], ["Healthcare", 40]]);
    const callId = add("ZZIX  CALL50", {
      type: "Option",
      sector: "Diversified",
      price: 52,
      qty: 1,
      multiplier: 100,
      underlying: "ZZIX",
      optionType: "CALL",
      strike: 50,
      expiration: nextYear,
    });
    const perValue = getOptionExposureMap(db, [1]).perValueDollar.get(callId)!;
    const d = computeExposureDelta(db, "vanguard", [1], []);
    const exposure = 5_200 * perValue;
    expect(d.before.sectorWeights.Technology).toBeCloseTo((exposure * 0.6) / 15_200, 9);
    expect(d.before.sectorWeights.Healthcare).toBeCloseTo((exposure * 0.4) / 15_200, 9);
    expect(d.before.sectorWeights.Diversified).toBeUndefined();
  });
});

describe("S-B1: Cash deploy measures the put the same way", () => {
  it("the put lowers Technology below the stock-only weight, and the two cards agree", () => {
    const putId = bookWithLongPut();
    const perValue = getOptionExposureMap(db, [1]).perValueDollar.get(putId)!;
    const CASH = 1_000;
    const wi = computeExposureDelta(db, "vanguard", [1], []);
    const techDollars = cashDeploySectorDollars(CASH, "Technology", wi.before.totalValue);
    expect(techDollars).toBeCloseTo(10_000 + 800 * perValue, 6);
    expect(techDollars / 20_800).toBeLessThan(10_000 / 20_800);
    // Same sector dollars, same net denominator: the cards agree to the cent.
    expect(techDollars).toBeCloseTo(wi.before.sectorWeights.Technology * wi.before.totalValue, 6);
    const indDollars = cashDeploySectorDollars(CASH, "Industrials", wi.before.totalValue);
    expect(indDollars).toBeCloseTo(wi.before.sectorWeights.Industrials * wi.before.totalValue, 6);
  });

  it("counts an option that fell back to market value", () => {
    bookWithLongPut(false);
    const r = suggestAllocation(db, "vanguard", [1], 1_000);
    expect(r.optionsAtMarketValue).toBe(1);
    const r2 = (() => {
      db.prepare("DELETE FROM holdings WHERE source_key = 'od-ZZA   PUT100'").run();
      return suggestAllocation(db, "vanguard", [1], 1_000);
    })();
    expect(r2.optionsAtMarketValue).toBe(0);
  });

  it("picks plus unallocated still equal the cash asked, to the cent", () => {
    bookWithLongPut();
    db.prepare(
      `INSERT INTO watchlist (security_id, group_name, thesis, is_active, added_date) VALUES (1, 'default', 't', 1, ?)`,
    ).run(today);
    for (const cash of [1_000, 10_000, 250_000, 1_000_000]) {
      const r = suggestAllocation(db, "vanguard", [1], cash);
      const picked = r.picks.reduce((s, p) => s + Math.round(p.allocationDollars * 100), 0);
      expect(picked + Math.round(r.cashRemaining * 100)).toBe(Math.round(cash * 100));
    }
  });

  it("the caption says options are counted at their delta-adjusted exposure", () => {
    expect(NET_OF_SHORTS_CAPTION).toMatch(/net of short positions/i);
    expect(NET_OF_SHORTS_CAPTION).toMatch(/options counted at their delta-adjusted exposure/i);
  });
});
