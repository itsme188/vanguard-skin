/**
 * Bug 8 (2026-11-24): a custom sector scenario reads an option on a fund
 * through its underlying, so it moves with the fund (owner ruling
 * 2026-11-15/16: "an option on a fund is read through its underlying, so it
 * moves with the fund"). Before the fix the custom engine exploded the
 * OPTION's own symbol and type, so the fund's look-through weights were
 * skipped and the option landed in one bucket (its own sector label, or
 * "Unknown" which takes the market move).
 *
 * Synthetic symbols; round invented numbers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeScenario, type ScenarioResult } from "@/lib/compute/scenarios";
import { addDays, todayET } from "@/lib/calendar/date-utils";

let db: Database.Database;
let nextId = 900;

function seedSecurity(opts: {
  symbol: string;
  type: string;
  sector: string | null;
  price: number;
  quantity: number;
  lookThrough?: Array<[string, number]>;
}): void {
  const id = nextId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector, currency) VALUES (?, ?, ?, ?, ?, 'USD')`,
  ).run(id, opts.symbol, `${opts.symbol} Synthetic`, opts.type, opts.sector);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`).run(id, todayET(), opts.price);
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, ?, ?)`,
  ).run(id, todayET(), opts.quantity, `zz-${opts.symbol}`);
  for (const [sector, weight] of opts.lookThrough ?? []) {
    db.prepare(
      `INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES (?, ?, ?, ?, 'manual')`,
    ).run(opts.symbol, sector, weight, todayET());
  }
}

/** One long put, stored as the broker sync stores it (sector copied from the underlying). */
function seedPut(underlying: string, strike: number, ownSector: string | null, held = true): string {
  const id = nextId++;
  const symbol = `${underlying.padEnd(6)}270115P${String(strike * 1000).padStart(8, "0")}`;
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector, fund_category, underlying_symbol, strike_price, expiration_date, option_type, multiplier, currency)
     VALUES (?, ?, 'Option', ?, 'Options', ?, ?, ?, 'PUT', 100, 'USD')`,
  ).run(id, symbol, ownSector, underlying, strike, addDays(todayET(), 180));
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 3, 'tws')`).run(id, todayET());
  if (held) {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, 1, ?)`,
    ).run(id, todayET(), `zz-opt-${id}`);
  }
  return symbol;
}

const FUND_WEIGHTS: Array<[string, number]> = [
  ["Technology", 60],
  ["Consumer Staples", 40],
];

function run(sectorMoves: Record<string, number>, marketMove = 0): ScenarioResult {
  return computeScenario(db, { id: "custom", name: "c", description: "", category: "custom", marketMove, sectorMoves });
}
const row = (r: ScenarioResult, symbol: string) => r.positionImpacts.find((p) => p.symbol === symbol)!;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(`INSERT OR IGNORE INTO accounts (id, name) VALUES (1, 'Test')`).run();
  nextId = 900;
});

describe("custom sector scenario: an option on a fund looks through the fund", () => {
  it("fund with no sector label of its own: the put moves with the fund (-18%) and gains", () => {
    seedSecurity({ symbol: "ZZFD", type: "ETF", sector: null, price: 100, quantity: 100, lookThrough: FUND_WEIGHTS });
    const put = seedPut("ZZFD", 100, null);
    const r = run({ Technology: -0.3 });
    const fundMove = row(r, "ZZFD").changePercent;
    expect(fundMove).toBeCloseTo(-0.18, 6);
    expect(row(r, put).underlyingMove).toBeCloseTo(fundMove, 12);
    expect(row(r, put).estimatedChange).toBeGreaterThan(0);
  });

  it("fund labelled Technology: the put's underlying move equals the fund's own move (-20.7%)", () => {
    seedSecurity({ symbol: "ZZFD", type: "ETF", sector: "Technology", price: 100, quantity: 100, lookThrough: FUND_WEIGHTS });
    const put = seedPut("ZZFD", 100, "Technology");
    const r = run({ Technology: -0.3 });
    const fundMove = row(r, "ZZFD").changePercent;
    expect(fundMove).toBeCloseTo(-0.207, 6);
    expect(row(r, put).underlyingMove).toBeCloseTo(fundMove, 12);
    expect(row(r, put).estimatedChange).toBeGreaterThan(0);
  });

  it("a stale option sector label does not override the fund's identity", () => {
    seedSecurity({ symbol: "ZZFD", type: "ETF", sector: "Technology", price: 100, quantity: 100, lookThrough: FUND_WEIGHTS });
    const put = seedPut("ZZFD", 100, "Energy");
    const r = run({ Technology: -0.3, Energy: -0.5 });
    expect(row(r, put).underlyingMove).toBeCloseTo(row(r, "ZZFD").changePercent, 12);
  });

  it("a put on a plain single-sector stock is unchanged: it moves with the stock", () => {
    seedSecurity({ symbol: "ZZSTK", type: "Stock", sector: "Technology", price: 100, quantity: 100 });
    const put = seedPut("ZZSTK", 100, "Technology");
    const r = run({ Technology: -0.3 });
    const stockMove = row(r, "ZZSTK").changePercent;
    // Pinned value (same before and after the fix): beta 1.15 on a stock in
    // Technology, -30% sector shock, one bucket.
    expect(stockMove).toBeCloseTo(-0.345, 6);
    expect(row(r, put).underlyingMove).toBeCloseTo(-0.345, 12);
    expect(row(r, put).estimatedChange).toBeGreaterThan(0);
  });

  it("an option whose underlying row is not on file keeps its own fields", () => {
    const put = seedPut("ZZGONE", 100, "Technology");
    const r = run({ Technology: -0.3 });
    // Not priceable without the underlying, so it adds nothing; it must not throw.
    expect(row(r, put)).toBeDefined();
    expect(r.fundsWithoutSectorWeights).toEqual([]);
  });
});

describe("custom sector scenario: disclosure reads an option through its fund", () => {
  it("names a fund held only through an option, when the fund has no weights", () => {
    // The fund row is on file (a price), but only the option is held.
    const id = nextId++;
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, sector, currency) VALUES (?, 'ZZNW', 'ZZNW Synthetic', 'ETF', NULL, 'USD')`,
    ).run(id);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 100, 'tws')`).run(id, todayET());
    seedPut("ZZNW", 100, null);
    seedPut("ZZNW", 90, null);
    const r = run({ Technology: -0.3 });
    expect(r.fundsWithoutSectorWeights).toEqual(["ZZNW"]);
  });

  it("names the fund once when both the fund and an option on it are held", () => {
    seedSecurity({ symbol: "ZZNW", type: "ETF", sector: null, price: 100, quantity: 10 });
    seedPut("ZZNW", 100, null);
    const r = run({ Technology: -0.3 });
    expect(r.fundsWithoutSectorWeights).toEqual(["ZZNW"]);
  });

  it("does not name a fund with weights held only through an option", () => {
    const id = nextId++;
    db.prepare(
      `INSERT INTO securities (id, symbol, name, security_type, sector, currency) VALUES (?, 'ZZFD', 'ZZFD Synthetic', 'ETF', NULL, 'USD')`,
    ).run(id);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 100, 'tws')`).run(id, todayET());
    for (const [sector, weight] of FUND_WEIGHTS) {
      db.prepare(
        `INSERT INTO etf_sector_weights (etf_symbol, sector, weight_pct, as_of_date, source) VALUES ('ZZFD', ?, ?, ?, 'manual')`,
      ).run(sector, weight, todayET());
    }
    seedPut("ZZFD", 100, null);
    expect(run({ Technology: -0.3 }).fundsWithoutSectorWeights).toEqual([]);
  });
});
