/**
 * Cash deploy and leveraged / inverse funds (bug 4, owner ruling 2026-11-24:
 * "for cash deploy, never suggest an inverse or leveraged fund").
 *
 * Mirrors the What-if (lib/compute/exposure-delta.ts `snapshot`):
 *  - a flagged fund WITH a usable factor counts in its sector at market value
 *    times the signed factor (times the delta ratio for an option on it); the
 *    total keeps plain market value;
 *  - a flagged fund with NO usable factor is left out of the sector weights
 *    and the total, and listed (`leveragedFundsNotModelled`);
 *  - a long inverse fund never adds to the long-only book and is named as
 *    its own cause ("inverse funds");
 *  - no flagged fund is ever a pick, held or watchlist.
 *
 * Synthetic symbols and round figures only. Vanguard scope = account 1,
 * benchmark VTI (Technology 31%, Healthcare 11.5%).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { todayET } from "@/lib/calendar/date-utils";
import {
  measureLongOnlyBook,
  shortHeldSectorLine,
  suggestAllocation,
  type CashDeploySuggestion,
} from "@/lib/compute/cash-deploy";
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
    name?: string;
    sector?: string | null;
    price: number;
    qty?: number;
    factor?: number | null;
    underlying?: string;
    optionType?: string;
    strike?: number;
    expiration?: string;
    multiplier?: number;
  },
): number {
  const id = nextId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector, currency, multiplier, leverage_factor,
       underlying_symbol, option_type, strike_price, expiration_date)
     VALUES (?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    symbol,
    o.name ?? null,
    o.type,
    o.sector ?? null,
    o.multiplier ?? null,
    o.factor ?? null,
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
    ).run(id, today, o.qty, `lf-${symbol}`);
  }
  return id;
}

function watch(id: number) {
  db.prepare(
    `INSERT INTO watchlist (security_id, group_name, is_active, thesis) VALUES (?, 'vanguard_buy', 1, 'test')`,
  ).run(id);
}

const cents = (x: number) => Math.round(x * 100);

function expectConserved(r: CashDeploySuggestion, cash: number) {
  const picked = r.picks.reduce((s, p) => s + cents(p.allocationDollars), 0);
  expect(picked).toBe(cents(r.totalAllocated));
  expect(picked + cents(r.cashRemaining)).toBe(cents(cash));
  expect(cents(r.unallocatedShortDollars)).toBeLessThanOrEqual(cents(r.cashRemaining));
}

/** A sector's NET dollars as Cash deploy measures them, from its gap row. */
function sectorDollars(r: CashDeploySuggestion, sector: string, basis: number): number {
  const gap = r.gaps.find((g) => g.sector === sector);
  if (!gap) throw new Error(`no gap row for ${sector}`);
  return gap.currentWeight * basis;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("DELETE FROM watchlist").run();
  db.prepare("UPDATE settings SET value = ? WHERE key = 'construction_caps_vanguard'").run(
    JSON.stringify({ top1_max: 1 }),
  );
  nextId = 1;
});

const CASH = 10_000;

describe("bug 4: a held long inverse fund", () => {
  beforeEach(() => {
    add("ZZH", { type: "Stock", sector: "Healthcare", price: 100, qty: 500 }); // 50,000
    add("ZZSQ", { type: "ETF", name: "ZZ UltraPro Short QQQ", sector: "Technology", price: 50, qty: 100, factor: -3 }); // 5,000
  });

  it("counts Technology at -3 times its money, the same dollars and total as the What-if", () => {
    const r = suggestAllocation(db, "vanguard", [1], CASH);
    const book = measureLongOnlyBook(db, "vanguard", [1], CASH);
    const wi = computeExposureDelta(db, "vanguard", [1], []);
    // Total keeps plain market value: 55,000 (+ the cash being deployed).
    expect(wi.before.totalValue).toBeCloseTo(55_000, 6);
    expect(book.gapBasisTotal).toBeCloseTo(55_000 + CASH, 6);
    const tech = sectorDollars(r, "Technology", book.gapBasisTotal);
    expect(tech).toBeCloseTo(-15_000, 6);
    expect(tech).toBeCloseTo(wi.before.sectorWeights.Technology * wi.before.totalValue, 6);
    expect(r.gaps.find((g) => g.sector === "Technology")!.currentWeight).toBeLessThan(0);
    expect(r.leveragedFundsNotModelled).toEqual([]);
    expectConserved(r, CASH);
  });

  it("is never a pick", () => {
    const r = suggestAllocation(db, "vanguard", [1], CASH);
    expect(r.picks.map((p) => p.symbol)).not.toContain("ZZSQ");
    expectConserved(r, CASH);
  });

  it("never adds to the long-only book and is named as an inverse fund", () => {
    const book = measureLongOnlyBook(db, "vanguard", [1], CASH);
    // Long-only basis = cash + the Healthcare stock only.
    expect(book.longBasisTotal).toBeCloseTo(CASH + 50_000, 6);
    const tech = book.sectors.find((s) => s.sector === "Technology")!;
    expect(tech.longDollars).toBe(0);
    expect(tech.netDollars).toBeCloseTo(-15_000, 6);
    expect(tech.causes).toEqual(["inverse_funds"]);
    const r = suggestAllocation(db, "vanguard", [1], CASH);
    const held = r.shortHeldSectors.find((s) => s.sector === "Technology")!;
    expect(held.causes).toEqual(["inverse_funds"]);
    const line = shortHeldSectorLine(held);
    expect(line).toContain("inverse funds");
    expect(line).not.toContain("short positions");
  });
});

describe("bug 4: a held +3x fund", () => {
  beforeEach(() => {
    add("ZZH", { type: "Stock", sector: "Healthcare", price: 100, qty: 500 }); // 50,000
    add("ZZUQ", { type: "ETF", name: "ZZ UltraPro QQQ", sector: "Technology", price: 50, qty: 100, factor: 3 }); // 5,000
  });

  it("counts at 3x, matches the What-if, and is never picked", () => {
    const r = suggestAllocation(db, "vanguard", [1], CASH);
    const book = measureLongOnlyBook(db, "vanguard", [1], CASH);
    const wi = computeExposureDelta(db, "vanguard", [1], []);
    const tech = sectorDollars(r, "Technology", book.gapBasisTotal);
    expect(tech).toBeCloseTo(15_000, 6);
    expect(tech).toBeCloseTo(wi.before.sectorWeights.Technology * wi.before.totalValue, 6);
    expect(book.sectors.find((s) => s.sector === "Technology")!.longDollars).toBeCloseTo(15_000, 6);
    expect(r.picks.map((p) => p.symbol)).not.toContain("ZZUQ");
    expectConserved(r, CASH);
  });

  it("a plain watchlist name fills only the room left after the 3x exposure", () => {
    watch(add("ZZT", { type: "Stock", sector: "Technology", price: 100 }));
    const r = suggestAllocation(db, "vanguard", [1], CASH);
    // Room = 65,000 x 31% - 15,000 = 5,150.
    const pick = r.picks.find((p) => p.symbol === "ZZT")!;
    expect(pick.allocationDollars).toBeCloseTo(5_150, 2);
    expect(r.picks.map((p) => p.symbol)).not.toContain("ZZUQ");
    expectConserved(r, CASH);
  });
});

describe("bug 4: a flagged fund with no usable factor", () => {
  beforeEach(() => {
    add("ZZH", { type: "Stock", sector: "Healthcare", price: 100, qty: 500 }); // 50,000
    add("ZZNF", { type: "ETF", name: "ZZ UltraPro QQQ", sector: "Technology", price: 50, qty: 100, factor: null }); // 5,000
  });

  it("is left out of the weights and the total, listed, and never picked", () => {
    const r = suggestAllocation(db, "vanguard", [1], CASH);
    const book = measureLongOnlyBook(db, "vanguard", [1], CASH);
    const wi = computeExposureDelta(db, "vanguard", [1], []);
    expect(wi.before.totalValue).toBeCloseTo(50_000, 6);
    expect(book.gapBasisTotal).toBeCloseTo(50_000 + CASH, 6);
    expect(book.longBasisTotal).toBeCloseTo(50_000 + CASH, 6);
    expect(sectorDollars(r, "Technology", book.gapBasisTotal)).toBeCloseTo(0, 6);
    expect(r.leveragedFundsNotModelled).toEqual(["ZZNF"]);
    expect(r.leveragedFundsNotModelled).toEqual(wi.leveragedFundsNotModelled);
    expect(r.picks.map((p) => p.symbol)).not.toContain("ZZNF");
    expectConserved(r, CASH);
  });
});

describe("bug 4: flagged watchlist funds", () => {
  it("are never picked, with or without a factor, long or inverse", () => {
    add("ZZH", { type: "Stock", sector: "Healthcare", price: 100, qty: 500 }); // 50,000
    watch(add("ZZW3", { type: "ETF", name: "ZZ UltraPro QQQ", sector: "Technology", price: 50, factor: 3 }));
    watch(add("ZZW2", { type: "ETF", name: "ZZ Tech 2X", sector: "Technology", price: 50, factor: 2 }));
    watch(add("ZZWI", { type: "ETF", name: "ZZ UltraShort QQQ", sector: "Technology", price: 50, factor: -2 }));
    watch(add("ZZWN", { type: "ETF", name: "ZZ Ultra Tech", sector: "Technology", price: 50, factor: null }));
    watch(add("ZZIN", { type: "Stock", sector: "Industrials", price: 100 }));
    const r = suggestAllocation(db, "vanguard", [1], CASH);
    const symbols = r.picks.map((p) => p.symbol);
    for (const s of ["ZZW3", "ZZW2", "ZZWI", "ZZWN"]) expect(symbols).not.toContain(s);
    expect(symbols).toContain("ZZIN");
    // A watchlist fund is not held, so it is not "not modelled" in the book.
    expect(r.leveragedFundsNotModelled).toEqual([]);
    expectConserved(r, CASH);
  });
});

describe("bug 4: an option on a flagged fund", () => {
  it("a long call on an inverse fund counts at delta times the factor, negative, as the What-if does", () => {
    add("ZZH", { type: "Stock", sector: "Healthcare", price: 100, qty: 500 }); // 50,000
    add("ZZSQ", { type: "ETF", name: "ZZ UltraPro Short QQQ", sector: "Technology", price: 50, factor: -3 });
    const callId = add("ZZSQ  CALL50", {
      type: "Option",
      price: 5,
      qty: 10,
      multiplier: 100,
      underlying: "ZZSQ",
      optionType: "CALL",
      strike: 50,
      expiration: nextYear,
    }); // 5,000
    const perValue = getOptionExposureMap(db, [1]).perValueDollar.get(callId);
    expect(perValue).toBeDefined();
    expect(perValue!).toBeGreaterThan(0);
    const r = suggestAllocation(db, "vanguard", [1], CASH);
    const book = measureLongOnlyBook(db, "vanguard", [1], CASH);
    const wi = computeExposureDelta(db, "vanguard", [1], []);
    const tech = sectorDollars(r, "Technology", book.gapBasisTotal);
    expect(tech).toBeCloseTo(5_000 * perValue! * -3, 6);
    expect(tech).toBeCloseTo(wi.before.sectorWeights.Technology * wi.before.totalValue, 6);
    expect(book.gapBasisTotal).toBeCloseTo(wi.before.totalValue + CASH, 6);
    const techBook = book.sectors.find((s) => s.sector === "Technology")!;
    expect(techBook.longDollars).toBe(0);
    expect(techBook.causes).toEqual(["inverse_funds"]);
    expect(r.optionsAtMarketValue).toBe(0);
    expect(r.picks.map((p) => p.symbol)).not.toContain("ZZSQ");
    expectConserved(r, CASH);
  });

  it("an option on a flagged fund with no factor is left out and listed, as the What-if does", () => {
    add("ZZH", { type: "Stock", sector: "Healthcare", price: 100, qty: 500 }); // 50,000
    add("ZZNF", { type: "ETF", name: "ZZ UltraPro QQQ", sector: "Technology", price: 50, factor: null });
    add("ZZNF  CALL50", {
      type: "Option",
      price: 5,
      qty: 10,
      multiplier: 100,
      underlying: "ZZNF",
      optionType: "CALL",
      strike: 50,
      expiration: nextYear,
    });
    const r = suggestAllocation(db, "vanguard", [1], CASH);
    const book = measureLongOnlyBook(db, "vanguard", [1], CASH);
    const wi = computeExposureDelta(db, "vanguard", [1], []);
    expect(book.gapBasisTotal).toBeCloseTo(50_000 + CASH, 6);
    expect(r.leveragedFundsNotModelled).toEqual(["ZZNF  CALL50"]);
    expect(r.leveragedFundsNotModelled).toEqual(wi.leveragedFundsNotModelled);
    expectConserved(r, CASH);
  });
});
