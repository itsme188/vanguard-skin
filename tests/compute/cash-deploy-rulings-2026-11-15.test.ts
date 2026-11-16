/**
 * Cash-Deploy — owner rulings of 2026-11-15 (unit K1).
 *
 * K1a  Stop at each sector's gap; the rest is shown as unallocated
 *      (docs/DECISIONS.md 2026-10-12, confirmed 2026-11-15). Supersedes the
 *      2026-10-07 "proposals add up to the cash asked for" top-up.
 * K1b  Shorts count: sector weights are NET of short positions, over the
 *      same signed denominator the What-if engine uses.
 * K1c  A multi-sector fund is credited by its look-through weights and sized
 *      so it pushes no sector past its benchmark weight.
 *
 * Synthetic symbols and round figures only. Vanguard scope = account 1,
 * benchmark VTI (migration 050: Technology 31%, Healthcare 11.5%,
 * Industrials 9%, Energy 3.5%).
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { suggestAllocation, type CashDeploySuggestion } from "@/lib/compute/cash-deploy";

const PRICE_DATE = "2026-10-07";

let nextId = 1;
function seedSecurity(
  db: Database.Database,
  symbol: string,
  type: string,
  sector: string | null,
  price: number,
  quantity: number | null
): number {
  const id = nextId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector) VALUES (?, ?, ?, ?)`
  ).run(id, symbol, type, sector);
  db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')`
  ).run(id, PRICE_DATE, price);
  if (quantity !== null) {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
       VALUES (1, ?, ?, ?, ?)`
    ).run(id, PRICE_DATE, quantity, `h-${symbol}`);
  }
  return id;
}

function uncapNames(db: Database.Database) {
  db.prepare("UPDATE settings SET value = ? WHERE key = 'construction_caps_vanguard'").run(
    JSON.stringify({ top1_max: 1 })
  );
}

function cents(x: number) {
  return Math.round(x * 100);
}

/** Money conservation: picks + unallocated = cash asked, to the cent. */
function expectConserved(result: CashDeploySuggestion, cash: number) {
  const picked = result.picks.reduce((s, p) => s + cents(p.allocationDollars), 0);
  expect(picked).toBe(cents(result.totalAllocated));
  expect(picked + cents(result.cashRemaining)).toBe(cents(cash));
}

/** No gap the table shows ends past its benchmark weight because of a pick. */
function expectNoOvershoot(result: CashDeploySuggestion) {
  for (const g of result.gaps) {
    if (g.gapPp < 0) expect(g.residualGapPp).toBeLessThanOrEqual(1e-9);
  }
}

describe("K1a: picks stop at the sector gap; the remainder is unallocated", () => {
  let db: Database.Database;
  beforeEach(() => {
    nextId = 1;
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("DELETE FROM watchlist").run();
    uncapNames(db);
  });

  it("does not pour leftover cash into a held name past its sector's benchmark weight", () => {
    seedSecurity(db, "ZZA", "Stock", "Technology", 100, 900); // $90,000
    seedSecurity(db, "ZZB", "Stock", "Healthcare", 100, 10); // $1,000
    const CASH = 100_000;
    const result = suggestAllocation(db, "vanguard", [1], CASH);

    // Basis 191,000; Healthcare room = 191,000 × 11.5% − 1,000 = 20,965.
    const room = 191_000 * 0.115 - 1_000;
    expect(result.picks.map((p) => p.symbol)).toEqual(["ZZB"]);
    expect(result.picks[0].allocationDollars).toBeLessThanOrEqual(room + 0.005);
    expect(result.picks[0].allocationDollars).toBeGreaterThan(room - 0.02);

    // Independent after-picks weight: never above the benchmark weight.
    const after = (1_000 + result.picks[0].allocationDollars) / 191_000;
    expect(after).toBeLessThanOrEqual(0.115 + 1e-12);

    expectConserved(result, CASH);
    expectNoOvershoot(result);
    expect(result.cashRemaining).toBeGreaterThan(70_000);
    expect(result.unallocatedReason).toBeTruthy();
    // The reason is a sentence with no figure: the amount renders through <Money>.
    expect(result.unallocatedReason).not.toMatch(/\d/);
  });

  it("conserves an awkward cash amount to the cent when everything fits", () => {
    seedSecurity(db, "ZZA", "Stock", "Technology", 100, 900);
    seedSecurity(db, "ZZB", "Stock", "Healthcare", 100, 10);
    const result = suggestAllocation(db, "vanguard", [1], 1_234.57);
    expectConserved(result, 1_234.57);
    expectNoOvershoot(result);
    expect(cents(result.totalAllocated)).toBe(123_457);
    expect(result.unallocatedReason).toBeNull();
  });
});

describe("held-name fallback picks are stocks and funds held long", () => {
  let db: Database.Database;
  beforeEach(() => {
    nextId = 1;
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("DELETE FROM watchlist").run();
    uncapNames(db);
  });

  it("never proposes buying more of a held option to fill its sector", () => {
    seedSecurity(db, "ZZA", "Stock", "Industrials", 100, 500); // overweight
    // A long put on a sector fund: positive market value, short exposure.
    seedSecurity(db, "ZZP 261218P00100000", "Option", "Technology", 5, 10);
    const result = suggestAllocation(db, "vanguard", [1], 10_000);
    expect(result.picks.map((p) => p.symbol)).not.toContain("ZZP 261218P00100000");
    expectConserved(result, 10_000);
  });
});

describe("no fragment picks", () => {
  let db: Database.Database;
  beforeEach(() => {
    nextId = 1;
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("DELETE FROM watchlist").run();
    uncapNames(db);
  });

  it("a fund whose sector a single name already filled gets no cents-sized pick", () => {
    seedSecurity(db, "ZZI", "Stock", "Industrials", 100, 500); // $50,000
    // Watchlist single name ranks first and fills Healthcare to the cent,
    // leaving a sub-cent fragment of room (basis is not a round figure).
    const hc = seedSecurity(db, "ZZH", "Stock", "Healthcare", 100, 0.0001); // $0.01
    db.prepare(
      `INSERT INTO watchlist (security_id, group_name, is_active, thesis) VALUES (?, 'vanguard_buy', 1, 'test')`
    ).run(hc);
    // A HELD fund (ranked after the watchlist) with 1% in Healthcare: the
    // fragment divided by 1% would be a pick of a few cents.
    seedSecurity(db, "ZZF", "ETF", "Technology", 50, 2); // $100
    for (const [sector, pct] of [["Industrials", 0], ["Healthcare", 1], ["Technology", 99]] as const) {
      if (pct === 0) continue;
      db.prepare(
        `INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source)
         VALUES ('ZZF', ?, ?, ?, 'manual')`
      ).run(sector, pct, PRICE_DATE);
    }
    const result = suggestAllocation(db, "vanguard", [1], 10_000);
    expect(result.picks.map((p) => p.symbol)).toContain("ZZH");
    for (const p of result.picks) expect(p.allocationDollars).toBeGreaterThanOrEqual(1);
    // Owner ruling 24 = B (2026-11-16) supersedes the strict fund rule here:
    // the fund's 1% Healthcare sliver no longer blocks it, so it is bought up
    // to its Technology gap and takes Healthcare past target by at most 1%
    // of its own size. The pick says so.
    const fund = result.picks.find((p) => p.symbol === "ZZF");
    expect(fund).toBeDefined();
    expect(fund!.toleranceSectors).toEqual(["Healthcare"]);
    const hcGap = result.gaps.find((g) => g.sector === "Healthcare")!;
    const basis = 50_000 + 100 + 0.01 + 10_000;
    expect(hcGap.residualGapPp).toBeLessThanOrEqual((fund!.allocationDollars * 0.01 / basis) * 100 + 1e-9);
    const tech = result.gaps.find((g) => g.sector === "Technology")!;
    expect(tech.residualGapPp).toBeLessThanOrEqual(1e-9);
    expectConserved(result, 10_000);
  });
});

describe("K1b: sector weights are net of short positions", () => {
  let db: Database.Database;
  beforeEach(() => {
    nextId = 1;
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("DELETE FROM watchlist").run();
    uncapNames(db);
  });

  it("nets a short against its sector and keeps it in the denominator", () => {
    seedSecurity(db, "ZZA", "Stock", "Technology", 100, 600); // +60,000
    seedSecurity(db, "ZZS", "Stock", "Technology", 100, -500); // −50,000
    seedSecurity(db, "ZZB", "Stock", "Healthcare", 100, 100); // +10,000
    seedSecurity(db, "ZZE", "Stock", "Energy", 100, -20); // −2,000
    const CASH = 1_000;
    const result = suggestAllocation(db, "vanguard", [1], CASH);

    // Net book 18,000 + cash 1,000 = 19,000 (What-if engine: signed sum).
    const basis = 19_000;
    const tech = result.gaps.find((g) => g.sector === "Technology")!;
    expect(tech.currentWeight).toBeCloseTo(10_000 / basis, 9);
    const hc = result.gaps.find((g) => g.sector === "Healthcare")!;
    expect(hc.currentWeight).toBeCloseTo(10_000 / basis, 9);

    // A net-short sector shows as a negative weight.
    const energy = result.gaps.find((g) => g.sector === "Energy")!;
    expect(energy.currentWeight).toBeCloseTo(-2_000 / basis, 9);
    expect(energy.gapPp).toBeLessThan(0);

    // A name held short is never proposed as a "held name" buy.
    expect(result.picks.map((p) => p.symbol)).not.toContain("ZZE");
    expect(result.picks.map((p) => p.symbol)).not.toContain("ZZS");
    expectConserved(result, CASH);
  });

  it("measures nothing when the scope is net short (zero or negative net value)", () => {
    seedSecurity(db, "ZZA", "Stock", "Technology", 100, 10); // +1,000
    seedSecurity(db, "ZZS", "Stock", "Healthcare", 100, -200); // −20,000
    const CASH = 5_000;
    const result = suggestAllocation(db, "vanguard", [1], CASH);
    expect(result.gaps).toEqual([]);
    expect(result.picks).toEqual([]);
    expectConserved(result, CASH);
    expect(result.cashRemaining).toBe(CASH);
    expect(result.unallocatedReason).toMatch(/net value/i);
  });
});

describe("K1c: a multi-sector fund is credited by its look-through weights", () => {
  let db: Database.Database;
  beforeEach(() => {
    nextId = 1;
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("DELETE FROM watchlist").run();
    uncapNames(db);
  });

  function seedFund(symbol: string, weights: Array<[string, number]>, vendorSector: string) {
    const id = seedSecurity(db, symbol, "ETF", vendorSector, 50, null);
    for (const [sector, pct] of weights) {
      db.prepare(
        `INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source)
         VALUES (?, ?, ?, ?, 'manual')`
      ).run(symbol, sector, pct, PRICE_DATE);
    }
    db.prepare(
      `INSERT INTO watchlist (security_id, group_name, is_active, thesis) VALUES (?, 'vanguard_buy', 1, 'test')`
    ).run(id);
  }

  it("spreads the pick over every sector and sizes it to the tightest gap", () => {
    seedSecurity(db, "ZZI", "Stock", "Industrials", 100, 500); // $50,000, overweight
    seedFund("ZZF", [["Healthcare", 50], ["Technology", 50]], "Healthcare");
    const CASH = 30_000;
    const result = suggestAllocation(db, "vanguard", [1], CASH);

    // Basis 80,000: Healthcare room 9,200, Technology room 24,800.
    // Healthcare binds: 9,200 / 0.5 = 18,400.
    const pick = result.picks.find((p) => p.symbol === "ZZF")!;
    expect(pick).toBeDefined();
    expect(pick.allocationDollars).toBeCloseTo(18_400, 1);
    expect(pick.allocationDollars).toBeLessThanOrEqual(18_400 + 0.005);
    expect(pick.rationale).toMatch(/multi-sector fund/i);

    const hc = result.gaps.find((g) => g.sector === "Healthcare")!;
    const tech = result.gaps.find((g) => g.sector === "Technology")!;
    // After picks reflects the spread: Technology moved by its half too.
    expect(tech.residualGapPp - tech.gapPp).toBeCloseTo((9_200 / 80_000) * 100, 6);
    expect(hc.residualGapPp).toBeCloseTo(0, 6);
    expectNoOvershoot(result);
    expectConserved(result, CASH);
  });

  it("does not buy a fund that would add to a sector already past its benchmark weight", () => {
    seedSecurity(db, "ZZI", "Stock", "Industrials", 100, 500); // overweight Industrials
    seedFund("ZZG", [["Healthcare", 50], ["Industrials", 50]], "Healthcare");
    const CASH = 10_000;
    const result = suggestAllocation(db, "vanguard", [1], CASH);
    expect(result.picks.map((p) => p.symbol)).not.toContain("ZZG");
    const ind = result.gaps.find((g) => g.sector === "Industrials")!;
    expect(ind.residualGapPp).toBeCloseTo(ind.gapPp, 9);
    expectConserved(result, CASH);
  });
});
