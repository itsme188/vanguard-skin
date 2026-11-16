/**
 * Cash-Deploy — review fixes FX3 to the rulings-24/25 build (2026-11-16).
 *
 * A1  Ruling 25's long-only weight is measured on a LONG-ONLY BOOK: long-only
 *     sector dollars over (every positive sector contribution in the compared
 *     sectors + the cash being deployed). A sector's fillable room is the
 *     smaller of its net room and its long-only room. Over the NET basis, puts
 *     shrank the denominator while staying out of the numerator, so the
 *     long-only weights summed past 1 and sectors looked fuller than they were.
 * A2  A short-held sector carries its causes (short stock, puts, short calls)
 *     and its line is worded from them; nothing says "short positions" when
 *     the only negative exposure is puts.
 * A3  A pick's rationale quotes the gap it may fill, not the wider net gap.
 * A5  The small-weight tolerance has no cumulative cap; the overshoot in any
 *     sector is bounded by 2% of the cash placed through tolerance picks.
 * A6  A short-held sector's kind comes from what was placed there; a long put
 *     with no Greeks never counts as long exposure.
 * A7  Each option shape's treatment, with Greeks seeded.
 *
 * Synthetic symbols and round figures only. Vanguard scope = account 1,
 * benchmark VTI (migration 050: Technology 31%, Healthcare 11.5%,
 * Industrials 9%, Energy 3.5%).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { todayET } from "@/lib/calendar/date-utils";
import { getOptionExposureMap } from "@/lib/compute/exposure";
import {
  FUND_SMALL_WEIGHT_TOLERANCE,
  measureLongOnlyBook,
  NET_OF_SHORTS_CAPTION,
  SHORT_UNALLOCATED_LABEL,
  SHORT_UNALLOCATED_REASON,
  shortHeldSectorLine,
  suggestAllocation,
  type CashDeploySuggestion,
} from "@/lib/compute/cash-deploy";

const TECH = 0.31;
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
    ).run(id, today, o.qty, `fx3-${symbol}`);
  }
  return id;
}

/** An option on ZZA (Technology, price 100), its own sector left blank. */
function option(symbol: string, optionType: "PUT" | "CALL", qty: number, price: number, withGreeks = true): number {
  return add(symbol, {
    type: "Option",
    price,
    qty,
    multiplier: 100,
    underlying: "ZZA",
    optionType,
    strike: withGreeks ? 100 : undefined,
    expiration: withGreeks ? nextYear : undefined,
  });
}

function watch(id: number) {
  db.prepare(
    `INSERT INTO watchlist (security_id, group_name, is_active, thesis, added_date) VALUES (?, 'vanguard_buy', 1, 'test', ?)`,
  ).run(id, today);
}

function fund(symbol: string, weights: Array<[string, number]>): number {
  const id = add(symbol, { type: "ETF", sector: weights[0][0], price: 50 });
  for (const [sector, pct] of weights) {
    db.prepare(
      `INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES (?, ?, ?, ?, 'manual')`,
    ).run(symbol, sector, pct, today);
  }
  watch(id);
  return id;
}

const cents = (x: number) => Math.round(x * 100);

function expectConserved(r: CashDeploySuggestion, cash: number) {
  const picked = r.picks.reduce((s, p) => s + cents(p.allocationDollars), 0);
  expect(picked).toBe(cents(r.totalAllocated));
  expect(picked + cents(r.cashRemaining)).toBe(cents(cash));
  expect(cents(r.unallocatedShortDollars)).toBeLessThanOrEqual(cents(r.cashRemaining));
  expect(cents(r.unallocatedShortDollars)).toBeGreaterThanOrEqual(0);
}

function sector(cash: number, name: string) {
  const book = measureLongOnlyBook(db, "vanguard", [1], cash);
  const s = book.sectors.find((x) => x.sector === name);
  if (!s) throw new Error(`no sector ${name}`);
  return { book, s };
}

function perValue(id: number): number {
  const v = getOptionExposureMap(db, [1]).perValueDollar.get(id);
  if (v === undefined) throw new Error("Greeks did not compute");
  return v;
}

beforeEach(() => {
  nextId = 1;
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("DELETE FROM watchlist").run();
  db.prepare("UPDATE settings SET value = ? WHERE key = 'construction_caps_vanguard'").run(
    JSON.stringify({ top1_max: 1 }),
  );
});

/** Tech 10,000 + Industrials 40,000 long; protective puts on the tech name. */
function protectedTechBook(putQty: number, techQty = 100, indQty = 400): number {
  add("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: techQty });
  add("ZZI", { type: "Stock", sector: "Industrials", price: 100, qty: indQty });
  return option("ZZA   P100", "PUT", putQty, 8);
}

describe("A1: the long-only weight is measured on a long-only book", () => {
  it("long-only weights sum to at most 1 on any book", () => {
    const books: Array<() => void> = [
      () => protectedTechBook(3),
      () => {
        add("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 400 });
        add("ZZS", { type: "Stock", sector: "Technology", price: 100, qty: -380 });
        add("ZZI", { type: "Stock", sector: "Industrials", price: 100, qty: 200 });
      },
      () => {
        add("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 50 });
        add("ZZI", { type: "Stock", sector: "Industrials", price: 100, qty: 100 });
        option("ZZA   C100", "CALL", 10, 12); // long calls at full delta
        option("ZZA   P100", "PUT", 10, 8);
        add("ZZS", { type: "Stock", sector: "Industrials", price: 100, qty: -50 });
      },
    ];
    for (const build of books) {
      nextId = 1;
      db = new Database(":memory:");
      db.pragma("foreign_keys = ON");
      runMigrations(db);
      db.prepare("DELETE FROM watchlist").run();
      build();
      for (const cash of [0.01, 1_000, 100_000]) {
        const book = measureLongOnlyBook(db, "vanguard", [1], cash);
        const sum = book.sectors.reduce((s, x) => s + x.longWeight, 0);
        expect(sum).toBeGreaterThan(0);
        expect(sum).toBeLessThanOrEqual(1 + 1e-12);
        // Independent: the basis is every positive contribution plus the cash.
        const longs = book.sectors.reduce((s, x) => s + x.longDollars, 0);
        expect(book.longBasisTotal).toBeCloseTo(longs + cash, 6);
      }
    }
  });

  it("near-neutral sector (40k long, 38k short) gets a sane long-only weight", () => {
    add("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 400 }); // +40,000
    add("ZZS", { type: "Stock", sector: "Technology", price: 100, qty: -380 }); // -38,000
    add("ZZI", { type: "Stock", sector: "Industrials", price: 100, qty: 200 }); // +20,000
    const t = add("ZZT", { type: "Stock", sector: "Technology", price: 100 });
    watch(t);
    const { book, s } = sector(10_000, "Technology");
    // Long-only book 60,000 + 10,000. Over the net basis (32,000) the weight
    // read 40/32 = 125%.
    expect(book.longBasisTotal).toBeCloseTo(70_000, 6);
    expect(s.longWeight).toBeCloseTo(40_000 / 70_000, 12);
    expect(s.longWeight).toBeLessThan(1);
    expect(s.causes).toEqual(["short_stock"]);
    // 57% long-only is past the 31% target: nothing is bought back.
    expect(s.fillableDollars).toBe(0);
    const r = suggestAllocation(db, "vanguard", [1], 10_000);
    expect(r.picks.map((p) => p.symbol)).not.toContain("ZZT");
    expect(r.shortHeldSectors).toEqual([{ sector: "Technology", kind: "not_filled", causes: ["short_stock"] }]);
    expectConserved(r, 10_000);
  });

  it("a book with only protective puts on a sector underweight on the long-only book still gets a pick there", () => {
    protectedTechBook(1);
    const t = add("ZZT", { type: "Stock", sector: "Technology", price: 100 });
    watch(t);
    const CASH = 10_000;
    const { book, s } = sector(CASH, "Technology");
    // Long-only book: 50,000 of stock + 10,000 cash (the put is not long).
    expect(book.longBasisTotal).toBeCloseTo(60_000, 6);
    expect(s.longDollars).toBeCloseTo(10_000, 6);
    // Fillable: 31% of 60,000 - 10,000 = 8,600; the net room is wider.
    expect(s.fillableDollars).toBeCloseTo(8_600, 6);
    const r = suggestAllocation(db, "vanguard", [1], CASH);
    const zzt = r.picks.find((p) => p.symbol === "ZZT");
    expect(zzt).toBeDefined();
    expect(zzt!.allocationDollars).toBeCloseTo(8_600, 2);
    // Independent: the net Technology weight after the pick is under target.
    const netTechAfter = (s.netDollars + zzt!.allocationDollars) / book.gapBasisTotal;
    expect(netTechAfter).toBeLessThanOrEqual(TECH + 1e-12);
    expect(r.shortHeldSectors).toEqual([{ sector: "Technology", kind: "partly_filled", causes: ["puts"] }]);
    expectConserved(r, CASH);
  });

  it("a sector at or above target on the long-only book gets no pick, though net underweight", () => {
    protectedTechBook(3, 320, 580); // Tech 32,000 of a 90,000 long book
    const t = add("ZZT", { type: "Stock", sector: "Technology", price: 100 });
    watch(t);
    const CASH = 10_000;
    const { s } = sector(CASH, "Technology");
    expect(s.longWeight).toBeCloseTo(32_000 / 100_000, 12);
    expect(s.longWeight).toBeGreaterThanOrEqual(TECH);
    expect(s.fillableDollars).toBe(0);
    const r = suggestAllocation(db, "vanguard", [1], CASH);
    const gap = r.gaps.find((g) => g.sector === "Technology")!;
    expect(gap.gapPp).toBeLessThan(0); // net underweight
    expect(r.picks.map((p) => p.symbol)).not.toContain("ZZT");
    expect(r.picks.map((p) => p.symbol)).not.toContain("ZZA");
    expect(r.shortHeldSectors).toEqual([{ sector: "Technology", kind: "not_filled", causes: ["puts"] }]);
    expectConserved(r, CASH);
  });

  it("conservation to the cent: picks + unallocated == cash on hedged books", () => {
    protectedTechBook(2);
    add("ZZS", { type: "Stock", sector: "Healthcare", price: 100, qty: -20 });
    add("ZZH", { type: "Stock", sector: "Healthcare", price: 100, qty: 30 });
    watch(add("ZZT", { type: "Stock", sector: "Technology", price: 100 }));
    watch(add("ZZK", { type: "Stock", sector: "Healthcare", price: 100 }));
    fund("ZZF", [["Healthcare", 40], ["Technology", 58.5], ["Energy", 1.5]]);
    for (const CASH of [1, 99.99, 1_234.57, 33_333.33, 250_000, 1_000_000.01]) {
      const r = suggestAllocation(db, "vanguard", [1], CASH);
      expectConserved(r, CASH);
      for (const p of r.picks) expect(p.allocationDollars).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("A2: the short-held line is worded from its causes", () => {
  it("puts only: says puts, never short positions", () => {
    const line = shortHeldSectorLine({ sector: "Technology", kind: "not_filled", causes: ["puts"] });
    expect(line).toBe("Technology: you hold puts here; not filled.");
    expect(line).not.toMatch(/short positions/);
  });

  it("short stock only, and the mix", () => {
    expect(shortHeldSectorLine({ sector: "Energy", kind: "partly_filled", causes: ["short_stock"] })).toBe(
      "Energy: you hold short positions here; filled only up to the gap your long positions leave.",
    );
    expect(shortHeldSectorLine({ sector: "Energy", kind: "not_filled", causes: ["short_stock", "puts"] })).toBe(
      "Energy: you hold short positions and puts here; not filled.",
    );
    expect(
      shortHeldSectorLine({ sector: "Energy", kind: "not_filled", causes: ["short_stock", "puts", "short_calls"] }),
    ).toBe("Energy: you hold short positions, puts and short calls here; not filled.");
  });

  it("the unallocated label and reason never say short positions", () => {
    expect(SHORT_UNALLOCATED_LABEL).toBe("Left out for sectors you have hedged or sold short:");
    expect(SHORT_UNALLOCATED_REASON).not.toMatch(/short positions/);
    expect(SHORT_UNALLOCATED_REASON).not.toMatch(/\d/);
  });

  it("a puts-only book's suggestion says puts in every string it shows", () => {
    protectedTechBook(1);
    watch(add("ZZT", { type: "Stock", sector: "Technology", price: 100 }));
    const r = suggestAllocation(db, "vanguard", [1], 20_000);
    expect(r.shortHeldSectors.map((s) => s.causes)).toEqual([["puts"]]);
    for (const s of r.shortHeldSectors) expect(shortHeldSectorLine(s)).not.toMatch(/short positions/);
    for (const text of [r.unallocatedReason, r.unallocatedShortReason, ...r.picks.map((p) => p.rationale)]) {
      if (text) expect(text).not.toMatch(/short positions/);
    }
  });
});

describe("A3: the rationale quotes the fillable gap", () => {
  it("quotes the long-only room, not the wider net gap, and says so", () => {
    protectedTechBook(1);
    watch(add("ZZT", { type: "Stock", sector: "Technology", price: 100 }));
    const CASH = 10_000;
    const r = suggestAllocation(db, "vanguard", [1], CASH);
    const { book } = sector(CASH, "Technology");
    const zzt = r.picks.find((p) => p.symbol === "ZZT")!;
    const fillPp = ((8_600 / book.gapBasisTotal) * 100).toFixed(1);
    const netPp = Math.abs(r.gaps.find((g) => g.sector === "Technology")!.gapPp).toFixed(1);
    expect(fillPp).not.toBe(netPp);
    expect(zzt.rationale).toBe(`Underweight Technology by ${fillPp}pp on your long positions vs benchmark`);
  });

  it("an unhedged sector keeps the table's gap", () => {
    add("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 100 });
    add("ZZI", { type: "Stock", sector: "Industrials", price: 100, qty: 400 });
    watch(add("ZZT", { type: "Stock", sector: "Technology", price: 100 }));
    const r = suggestAllocation(db, "vanguard", [1], 10_000);
    const gap = r.gaps.find((g) => g.sector === "Technology")!;
    const zzt = r.picks.find((p) => p.symbol === "ZZT")!;
    expect(zzt.rationale).toBe(`Underweight Technology by ${Math.abs(gap.gapPp).toFixed(1)}pp vs benchmark`);
  });

  it("the caption says picks are sized on the long-only book", () => {
    expect(NET_OF_SHORTS_CAPTION).toMatch(/net of short positions/i);
    expect(NET_OF_SHORTS_CAPTION).toMatch(/Picks are sized on the long-only book/);
    expect(NET_OF_SHORTS_CAPTION).toMatch(/not bought back/);
  });
});

describe("A6: a short-held sector's kind comes from what was placed there", () => {
  it("room but nothing placed (per-name cap at zero) is not filled", () => {
    add("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 100 }); // +10,000
    add("ZZS", { type: "Stock", sector: "Technology", price: 100, qty: -50 }); // -5,000
    add("ZZI", { type: "Stock", sector: "Industrials", price: 100, qty: 450 });
    watch(add("ZZT", { type: "Stock", sector: "Technology", price: 100 }));
    db.prepare("UPDATE settings SET value = ? WHERE key = 'construction_caps_vanguard'").run(
      JSON.stringify({ top1_max: 0 }),
    );
    const { s } = sector(20_000, "Technology");
    expect(s.fillableDollars).toBeGreaterThan(1); // the old rule said "partly filled" here
    const r = suggestAllocation(db, "vanguard", [1], 20_000);
    expect(r.picks).toEqual([]);
    expect(r.shortHeldSectors).toEqual([{ sector: "Technology", kind: "not_filled", causes: ["short_stock"] }]);
    expectConserved(r, 20_000);
  });

  it("a long put with no Greeks is not long exposure (its net weight keeps market value)", () => {
    protectedTechBook(1);
    db.prepare("UPDATE securities SET strike_price = NULL, expiration_date = NULL WHERE symbol = 'ZZA   P100'").run();
    const { book, s } = sector(1_000, "Technology");
    const r = suggestAllocation(db, "vanguard", [1], 1_000);
    expect(r.optionsAtMarketValue).toBe(1);
    expect(s.longDollars).toBeCloseTo(10_000, 6); // not 10,800
    expect(s.netDollars).toBeCloseTo(10_800, 6); // What-if parity: market value
    expect(s.causes).toEqual(["puts"]);
    expect(book.longBasisTotal).toBeCloseTo(51_000, 6);
  });
});

describe("A7: each option shape's treatment, with Greeks", () => {
  beforeEach(() => {
    add("ZZI", { type: "Stock", sector: "Industrials", price: 100, qty: 100 }); // +10,000
  });

  it("protective long put: hedge, out of the long-only numerator", () => {
    add("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 100 });
    const id = option("ZZA   P100", "PUT", 1, 8);
    expect(perValue(id)).toBeLessThan(0);
    const { s } = sector(1_000, "Technology");
    expect(s.longDollars).toBeCloseTo(10_000, 6);
    expect(s.netDollars).toBeCloseTo(10_000 + 800 * perValue(id), 6);
    expect(s.causes).toEqual(["puts"]);
  });

  it("covered short call: hedge, out of the long-only numerator", () => {
    add("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 100 });
    const id = option("ZZA   C100", "CALL", -1, 12);
    expect(-1_200 * perValue(id)).toBeLessThan(0);
    const { s } = sector(1_000, "Technology");
    expect(s.longDollars).toBeCloseTo(10_000, 6);
    expect(s.netDollars).toBeCloseTo(10_000 - 1_200 * perValue(id), 6);
    expect(s.causes).toEqual(["short_calls"]);
  });

  it("short stock: out of the long-only numerator", () => {
    add("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: 100 });
    add("ZZS", { type: "Stock", sector: "Technology", price: 100, qty: -40 });
    const { s } = sector(1_000, "Technology");
    expect(s.longDollars).toBeCloseTo(10_000, 6);
    expect(s.netDollars).toBeCloseTo(6_000, 6);
    expect(s.causes).toEqual(["short_stock"]);
  });

  it("long call with short stock: the call is long exposure at its delta, the short is the cause", () => {
    add("ZZA", { type: "Stock", sector: "Technology", price: 100, qty: -100 });
    const id = option("ZZA   C100", "CALL", 2, 12);
    const callExposure = 2_400 * perValue(id);
    expect(callExposure).toBeGreaterThan(0);
    const { book, s } = sector(1_000, "Technology");
    expect(s.longDollars).toBeCloseTo(callExposure, 6);
    expect(s.netDollars).toBeCloseTo(callExposure - 10_000, 6);
    expect(s.causes).toEqual(["short_stock"]);
    expect(book.longBasisTotal).toBeCloseTo(10_000 + callExposure + 1_000, 6);
  });

  it("short put: LONG exposure (positive delta), in the long-only numerator, no cause", () => {
    // Selling a put is a bet the price holds up: its delta exposure is
    // positive, so it counts as long exposure, not as a hedge.
    add("ZZA", { type: "Stock", sector: "Technology", price: 100 }); // priced, not held
    const id = option("ZZA   P100", "PUT", -1, 8);
    const exposure = -800 * perValue(id);
    expect(exposure).toBeGreaterThan(0);
    const { s } = sector(1_000, "Technology");
    expect(s.longDollars).toBeCloseTo(exposure, 6);
    expect(s.netDollars).toBeCloseTo(exposure, 6);
    expect(s.causes).toEqual([]);
    const r = suggestAllocation(db, "vanguard", [1], 1_000);
    expect(r.shortHeldSectors).toEqual([]);
  });
});

describe("A5: the small-weight tolerance overshoot is bounded", () => {
  it("total overshoot in any sector <= 2% of the cash placed through tolerance picks", () => {
    add("ZZE", { type: "Stock", sector: "Energy", price: 100, qty: 100 }); // Energy past target
    add("ZZI", { type: "Stock", sector: "Industrials", price: 100, qty: 300 });
    // Each fund fills its own sector, so the funds stack on the Energy sliver.
    const own = ["Technology", "Financials", "Healthcare", "Consumer Discretionary", "Communication Services", "Consumer Staples", "Real Estate", "Utilities"];
    own.forEach((sec, i) => fund(`ZZF${i}`, [[sec, 98], ["Energy", 2]]));
    for (const CASH of [10_000, 100_000, 250_000, 1_000_000]) {
      const r = suggestAllocation(db, "vanguard", [1], CASH);
      expectConserved(r, CASH);
      const tolerancePicks = r.picks.filter((p) => p.toleranceSectors.length > 0);
      // The funds stack on the sliver at 100,000 (at 1,000,000 Energy is
      // under target and no pick needs the tolerance).
      if (CASH === 100_000) expect(tolerancePicks.length).toBeGreaterThan(1);
      const toleranceDollars = tolerancePicks.reduce((s, p) => s + p.allocationDollars, 0);
      // Independent overshoot: Energy dollars placed past Energy's room
      // (3.5% of the 40,000 + cash basis, less the 10,000 held).
      const energyPlaced = r.picks.reduce(
        (s, p) => s + p.allocationDollars * (p.sectorExposure.find((e) => e.sector === "Energy")?.weight ?? 0),
        0,
      );
      const energyRoom = Math.max(0, 0.035 * (40_000 + CASH) - 10_000);
      const overshoot = Math.max(0, energyPlaced - energyRoom);
      if (CASH <= 100_000) expect(overshoot).toBeGreaterThan(0);
      expect(overshoot).toBeLessThanOrEqual(FUND_SMALL_WEIGHT_TOLERANCE * toleranceDollars + 0.01);
    }
  });
});
