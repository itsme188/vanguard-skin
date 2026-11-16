/**
 * Cash-Deploy — owner rulings of 2026-11-16.
 *
 * Ruling 24 = B, small-weight tolerance: a multi-sector fund's sectors that
 *   hold FUND_SMALL_WEIGHT_TOLERANCE (2%) or less of the fund may go past
 *   their benchmark weight; a sector holding more still may not. Single
 *   stocks and single-sector funds are unchanged.
 * Ruling 25 = A, short by choice: only the gap that exists on a LONG-ONLY
 *   basis is filled (gap to fill = max(0, target - long-only weight)); the
 *   part that would only offset shorts is reported apart.
 *
 * Synthetic symbols and round figures only. Vanguard scope = account 1,
 * benchmark VTI (migration 050: Technology 31%, Healthcare 11.5%,
 * Industrials 9%, Energy 3.5%).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  FUND_SMALL_WEIGHT_TOLERANCE,
  SHORT_UNALLOCATED_REASON,
  shortHeldSectorLine,
  smallWeightToleranceLine,
  suggestAllocation,
  type CashDeploySuggestion,
} from "@/lib/compute/cash-deploy";

const PRICE_DATE = "2026-10-07";
const TARGET: Record<string, number> = { Technology: 0.31, Healthcare: 0.115, Industrials: 0.09, Energy: 0.035 };

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

function fund(symbol: string, weights: Array<[string, number]>): number {
  const id = seed(symbol, "ETF", weights[0][0], 50, null);
  for (const [sector, pct] of weights) {
    db.prepare(
      `INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES (?, ?, ?, ?, 'manual')`,
    ).run(symbol, sector, pct, PRICE_DATE);
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

describe("ruling 24 = B: small-weight tolerance for multi-sector funds", () => {
  it("the tolerance is one named constant of 2%", () => {
    expect(FUND_SMALL_WEIGHT_TOLERANCE).toBe(0.02);
  });

  it("buys a fund whose only sector past target holds 2% or less of it, and says so", () => {
    seed("ZZE", "Stock", "Energy", 100, 100); // 10,000: Energy far past 3.5%
    seed("ZZI", "Stock", "Industrials", 100, 300); // 30,000, overweight
    fund("ZZF", [["Healthcare", 60], ["Technology", 38.5], ["Energy", 1.5]]);
    const r = suggestAllocation(db, "vanguard", [1], 10_000);
    const pick = r.picks.find((p) => p.symbol === "ZZF");
    expect(pick).toBeDefined();
    expect(pick!.toleranceSectors).toEqual(["Energy"]);
    expect(pick!.rationale).toMatch(/holds more than 2% passes its benchmark weight/);
    const line = smallWeightToleranceLine(pick!.toleranceSectors);
    expect(line).toMatch(/small-weight tolerance/);
    expect(line).toContain("Energy");
    expect(line).toContain("2%");
    expectConserved(r, 10_000);
  });

  it("exactly 2% is inside the tolerance", () => {
    seed("ZZE", "Stock", "Energy", 100, 100);
    fund("ZZF", [["Healthcare", 98], ["Energy", 2]]);
    const r = suggestAllocation(db, "vanguard", [1], 1_000);
    expect(r.picks.map((p) => p.symbol)).toContain("ZZF");
  });

  it("a sector with fund weight above 2% is still never pushed past target", () => {
    seed("ZZE", "Stock", "Energy", 100, 100); // Energy overweight
    seed("ZZI", "Stock", "Industrials", 100, 300); // Industrials overweight
    fund("ZZG", [["Healthcare", 97], ["Industrials", 3]]); // 3% > 2%: refused
    fund("ZZK", [["Healthcare", 97.5], ["Energy", 2.5]]); // 2.5% > 2%: refused
    const r = suggestAllocation(db, "vanguard", [1], 10_000);
    expect(r.picks.map((p) => p.symbol)).not.toContain("ZZG");
    expect(r.picks.map((p) => p.symbol)).not.toContain("ZZK");
    expectConserved(r, 10_000);
  });

  it("a fund's above-2% sectors stop at their gap while its sliver passes (independent check)", () => {
    seed("ZZE", "Stock", "Energy", 100, 100); // 10,000
    seed("ZZI", "Stock", "Industrials", 100, 300); // 30,000
    fund("ZZF", [["Healthcare", 50], ["Technology", 48.5], ["Energy", 1.5]]);
    for (const CASH of [5_000, 20_000, 77_777.77, 250_000]) {
      const r = suggestAllocation(db, "vanguard", [1], CASH);
      const basis = 40_000 + CASH;
      const pick = r.picks.find((p) => p.symbol === "ZZF");
      expect(pick).toBeDefined();
      // Healthcare and Technology (above 2%) end at or under target.
      const hcAfter = (pick!.allocationDollars * 0.5) / basis;
      const techAfter = (pick!.allocationDollars * 0.485) / basis;
      expect(hcAfter).toBeLessThanOrEqual(TARGET.Healthcare + 1e-9);
      expect(techAfter).toBeLessThanOrEqual(TARGET.Technology + 1e-9);
      for (const g of r.gaps) {
        if (g.sector !== "Energy" && g.gapPp < 0) expect(g.residualGapPp).toBeLessThanOrEqual(1e-9);
      }
      expectConserved(r, CASH);
    }
  });

  it("conservation under the small-weight tolerance: picks + unallocated == cash, to the cent", () => {
    seed("ZZE", "Stock", "Energy", 100, 100);
    seed("ZZT", "Stock", "Technology", 100, 50);
    const hc = seed("ZZH", "Stock", "Healthcare", 100, 0);
    watch(hc);
    fund("ZZF", [["Healthcare", 40], ["Technology", 58.2], ["Energy", 1.8]]);
    fund("ZZD", [["Industrials", 70], ["Technology", 29], ["Energy", 1]]);
    let tolerancePicks = 0;
    for (const CASH of [1, 99.99, 1_234.57, 33_333.33, 1_000_000.01]) {
      const r = suggestAllocation(db, "vanguard", [1], CASH);
      expectConserved(r, CASH);
      for (const p of r.picks) expect(p.allocationDollars).toBeGreaterThanOrEqual(1);
      tolerancePicks += r.picks.filter((p) => p.toleranceSectors.length > 0).length;
    }
    // The tolerance was actually exercised.
    expect(tolerancePicks).toBeGreaterThan(0);
  });

  it("single stocks and single-sector funds are unchanged", () => {
    seed("ZZE", "Stock", "Energy", 100, 100); // Energy overweight
    const s = seed("ZZX", "Stock", "Energy", 100, null);
    watch(s);
    fund("ZZS", [["Energy", 100]]);
    const r = suggestAllocation(db, "vanguard", [1], 10_000);
    expect(r.picks.map((p) => p.symbol)).not.toContain("ZZX");
    expect(r.picks.map((p) => p.symbol)).not.toContain("ZZS");
    for (const p of r.picks) expect(p.toleranceSectors).toEqual([]);
  });
});

describe("ruling 25 = A: a gap that comes from short positions is not filled", () => {
  it("a net-short-by-choice sector gets no pick and its cash is reported apart", () => {
    seed("ZZA", "Stock", "Technology", 100, 400); // +40,000 long
    seed("ZZS", "Stock", "Technology", 100, -200); // -20,000 short
    seed("ZZH", "Stock", "Healthcare", 100, 100); // +10,000
    seed("ZZI", "Stock", "Industrials", 100, 300); // +30,000
    const t = seed("ZZT", "Stock", "Technology", 100, null);
    watch(t);
    const CASH = 10_000;
    const r = suggestAllocation(db, "vanguard", [1], CASH);
    // Net basis 60,000 + 10,000 = 70,000; Technology net target 21,700.
    // Long-only book (FX3 A1): 80,000 long + 10,000 cash = 90,000, target
    // 27,900. Net 20,000 (under target), long-only 40,000 (over): short by
    // choice.
    const tech = r.gaps.find((g) => g.sector === "Technology")!;
    expect(tech.gapPp).toBeLessThan(0);
    expect(r.picks.map((p) => p.symbol)).not.toContain("ZZT");
    expect(r.picks.map((p) => p.symbol)).not.toContain("ZZA");
    expect(r.shortHeldSectors).toEqual([{ sector: "Technology", kind: "not_filled", causes: ["short_stock"] }]);
    expect(shortHeldSectorLine(r.shortHeldSectors[0])).toBe(
      "Technology: you hold short positions here; not filled.",
    );
    // The net gap ZZT would have filled: 21,700 - 20,000.
    expect(r.unallocatedShortDollars).toBeCloseTo(1_700, 2);
    expect(r.unallocatedShortReason).toBe(SHORT_UNALLOCATED_REASON);
    expect(r.unallocatedShortReason).not.toMatch(/\d/);
    expect(r.unallocatedReason).toBeTruthy();
    expectConserved(r, CASH);
  });

  it("a sector underweight on both bases is filled only up to the long-only gap", () => {
    seed("ZZA", "Stock", "Technology", 100, 100); // +10,000 long
    seed("ZZS", "Stock", "Technology", 100, -50); // -5,000 short
    seed("ZZI", "Stock", "Industrials", 100, 450); // +45,000, overweight
    const t = seed("ZZT", "Stock", "Technology", 100, null);
    watch(t);
    const CASH = 20_000;
    const r = suggestAllocation(db, "vanguard", [1], CASH);
    // Net basis 50,000 + 20,000 = 70,000; net target 21,700; net gap 16,700.
    // Long-only book (FX3 A1): 55,000 long + 20,000 cash = 75,000; target
    // 23,250; long-only gap 23,250 - 10,000 = 13,250 (under the net gap).
    const zzt = r.picks.find((p) => p.symbol === "ZZT")!;
    expect(zzt).toBeDefined();
    expect(zzt.allocationDollars).toBeCloseTo(13_250, 2);
    expect(zzt.allocationDollars).toBeLessThanOrEqual(13_250 + 0.005);
    // Independent: long-only Technology after the pick sits at target on the
    // long-only book, and the net weight stays under target.
    expect((10_000 + zzt.allocationDollars) / 75_000).toBeLessThanOrEqual(TARGET.Technology + 1e-12);
    expect((5_000 + zzt.allocationDollars) / 70_000).toBeLessThanOrEqual(TARGET.Technology + 1e-12);
    expect(r.picks.reduce((s, p) => s + p.allocationDollars, 0)).toBeCloseTo(13_250, 2);
    expect(r.shortHeldSectors).toEqual([{ sector: "Technology", kind: "partly_filled", causes: ["short_stock"] }]);
    expect(r.unallocatedShortDollars).toBeCloseTo(3_450, 2);
    expectConserved(r, CASH);
  });

  it("a book with no shorts has no short-held sectors and nothing reported apart", () => {
    seed("ZZA", "Stock", "Technology", 100, 100);
    seed("ZZI", "Stock", "Industrials", 100, 450);
    const r = suggestAllocation(db, "vanguard", [1], 20_000);
    expect(r.shortHeldSectors).toEqual([]);
    expect(r.unallocatedShortDollars).toBe(0);
    expect(r.unallocatedShortReason).toBeNull();
  });
});
