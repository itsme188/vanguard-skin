/**
 * Cash-Deploy — review fix FX4 (2026-11-16).
 *
 * Item 1: a multi-sector fund is a candidate only for the sectors that BIND
 *   it (where it holds more than FUND_SMALL_WEIGHT_TOLERANCE). A sliver of
 *   2% or less only rides along under ruling 24; the fund is never filed
 *   under, nor offered for, a sector it barely holds. It is filed under the
 *   binding underweight sector that takes the largest share of its dollars,
 *   and its rationale names every binding sector it fills.
 * Item 2: the nothing-placed reason agrees with the short-held sector lines:
 *   a sector with no fillable room because of hedges or shorts is said so,
 *   and "no single name" is said only of sectors that still have room.
 *
 * Synthetic symbols and round figures only. Vanguard scope = account 1,
 * benchmark VTI (Technology 31%, Healthcare 11.5%, Industrials 9%, Energy 3.5%).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  shortHeldSectorLine,
  suggestAllocation,
  type CashDeploySuggestion,
} from "@/lib/compute/cash-deploy";

const PRICE_DATE = "2026-10-07";

let db: Database.Database;
let nextId = 1;

function seed(symbol: string, type: string, sector: string | null, price: number, quantity: number | null): number {
  const id = nextId++;
  db.prepare(`INSERT INTO securities (id, symbol, security_type, sector) VALUES (?, ?, ?, ?)`).run(id, symbol, type, sector);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')`).run(id, PRICE_DATE, price);
  if (quantity !== null) {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, ?, ?)`,
    ).run(id, PRICE_DATE, quantity, `h-${symbol}`);
  }
  return id;
}

function watch(id: number) {
  db.prepare(
    `INSERT INTO watchlist (security_id, group_name, is_active, thesis) VALUES (?, 'vanguard_buy', 1, 'test')`,
  ).run(id);
}

function fund(symbol: string, weights: Array<[string, number]>, quantity: number | null = null, onWatchlist = true): number {
  const id = seed(symbol, "ETF", weights[0][0], 100, quantity);
  for (const [sector, pct] of weights) {
    db.prepare(
      `INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES (?, ?, ?, ?, 'manual')`,
    ).run(symbol, sector, pct, PRICE_DATE);
  }
  if (onWatchlist) watch(id);
  return id;
}

const cents = (x: number) => Math.round(x * 100);

function expectConserved(r: CashDeploySuggestion, cash: number) {
  const picked = r.picks.reduce((s, p) => s + cents(p.allocationDollars), 0);
  expect(picked).toBe(cents(r.totalAllocated));
  expect(picked + cents(r.cashRemaining)).toBe(cents(cash));
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

describe("FX4 item 1: a fund is never a candidate for a sector it barely holds", () => {
  it("a 96% A / 2% B fund is filed under A, and its rationale never names B", () => {
    seed("ZZT", "Stock", "Technology", 100, 1_000); // 100,000: A and B both underweight
    fund("ZZR", [["Healthcare", 96], ["Energy", 2], ["Industrials", 2]]);
    const r = suggestAllocation(db, "vanguard", [1], 10_000);
    const pick = r.picks.find((p) => p.symbol === "ZZR");
    expect(pick).toBeDefined();
    expect(pick!.sectorTarget).toBe("Healthcare");
    expect(pick!.rationale).toMatch(/underweight Healthcare by/);
    expect(pick!.rationale).not.toMatch(/Energy|Industrials/);
    expectConserved(r, 10_000);
  });

  it("when A is not an underweight gap (just under target), the fund is not picked for B", () => {
    // Basis 100,000: Healthcare 11% vs 11.5% (under the 2pp line), Energy 0%
    // vs 3.5% (a shown gap). Before the fix the fund was filed under Energy
    // and sized by its Healthcare room.
    seed("ZZT", "Stock", "Technology", 100, 880);
    seed("ZZH", "Stock", "Healthcare", 100, 110);
    fund("ZZR", [["Healthcare", 96], ["Energy", 2], ["Industrials", 2]]);
    const r = suggestAllocation(db, "vanguard", [1], 1_000);
    expect(r.gaps.find((g) => g.sector === "Energy")!.gapPp).toBeLessThan(0);
    expect(r.picks.map((p) => p.symbol)).not.toContain("ZZR");
    for (const p of r.picks) expect(p.sectorTarget).not.toBe("Energy");
    expectConserved(r, 1_000);
  });

  it("when A has no room (overweight), the fund is not picked at all", () => {
    seed("ZZH", "Stock", "Healthcare", 100, 1_000); // Healthcare far past 11.5%
    fund("ZZR", [["Healthcare", 96], ["Energy", 2], ["Industrials", 2]]);
    for (const CASH of [1_000, 10_000, 250_000]) {
      const r = suggestAllocation(db, "vanguard", [1], CASH);
      expect(r.picks.map((p) => p.symbol)).not.toContain("ZZR");
      expectConserved(r, CASH);
    }
  });

  it("a fund with two binding underweight sectors names both", () => {
    seed("ZZT", "Stock", "Technology", 100, 1_000);
    fund("ZZM", [["Healthcare", 60], ["Industrials", 38.5], ["Energy", 1.5]]);
    const r = suggestAllocation(db, "vanguard", [1], 10_000);
    const pick = r.picks.find((p) => p.symbol === "ZZM")!;
    expect(pick.sectorTarget).toBe("Healthcare");
    expect(pick.rationale).toMatch(/underweight Healthcare by .*; also fills Industrials;/);
    expect(pick.rationale).not.toMatch(/Energy/);
    expectConserved(r, 10_000);
  });

  it("conservation holds across amounts with sliver-carrying funds", () => {
    seed("ZZT", "Stock", "Technology", 100, 500);
    seed("ZZE", "Stock", "Energy", 100, 100);
    fund("ZZR", [["Healthcare", 96], ["Energy", 2], ["Industrials", 2]]);
    fund("ZZM", [["Industrials", 70], ["Technology", 28.5], ["Energy", 1.5]]);
    for (const CASH of [1, 99.99, 1_234.57, 33_333.33, 1_000_000.01]) {
      const r = suggestAllocation(db, "vanguard", [1], CASH);
      expectConserved(r, CASH);
      for (const p of r.picks) {
        const binding = p.sectorExposure.find((e) => e.sector === p.sectorTarget);
        expect(binding!.weight).toBeGreaterThan(0.02);
      }
    }
  });
});

describe("FX4 item 2: the nothing-placed reason agrees with the short-held lines", () => {
  it("a sector with room left on the long positions but no name: 'no single name' and an open line", () => {
    fund("ZZF", [["Technology", 50], ["Healthcare", 50]], 200, false); // held 20,000
    seed("ZZH", "Stock", "Healthcare", 100, 300); // 30,000: Healthcare overweight
    seed("ZZS", "Stock", "Technology", 100, -50); // -5,000 short
    const r = suggestAllocation(db, "vanguard", [1], 10_000);
    expect(r.picks).toEqual([]);
    const tech = r.shortHeldSectors.find((s) => s.sector === "Technology")!;
    expect(tech.kind).toBe("open_not_filled");
    const line = shortHeldSectorLine(tech);
    expect(line).toMatch(/only the gap your long positions leave can be filled/);
    expect(line).not.toMatch(/; not filled\.$/);
    const reason = r.unallocatedReason ?? "";
    expect(reason).toContain("Technology");
    expect(reason).toMatch(/even on your long positions alone/);
    expect(reason).toMatch(/no single name on the watchlist or held sits in them/);
    expect(reason).not.toMatch(/only because of the hedges/);
    expect(reason).not.toMatch(/\d/);
  });

  it("a sector with no fillable room because of a short: said so, never among 'no single name'", () => {
    seed("ZZA", "Stock", "Technology", 100, 300); // +30,000
    seed("ZZS", "Stock", "Technology", 100, -200); // -20,000 short
    seed("ZZH", "Stock", "Healthcare", 100, 300); // +30,000, overweight
    const r = suggestAllocation(db, "vanguard", [1], 10_000);
    expect(r.picks).toEqual([]);
    expect(r.gaps.find((g) => g.sector === "Technology")!.gapPp).toBeLessThan(0);
    const tech = r.shortHeldSectors.find((s) => s.sector === "Technology")!;
    expect(tech.kind).toBe("not_filled");
    expect(shortHeldSectorLine(tech)).toBe("Technology: you hold short positions here; not filled.");
    const reason = r.unallocatedReason ?? "";
    expect(reason).toMatch(/Technology is underweight only because of the hedges or short positions you hold there, so it is not filled/);
    // The "no single name" clause names only sectors that still have room.
    const head = reason.slice(0, reason.indexOf("Technology is underweight only"));
    expect(head).toMatch(/no single name on the watchlist or held/);
    expect(head).not.toContain("Technology");
    expect(reason).not.toMatch(/\d/);
  });
});
