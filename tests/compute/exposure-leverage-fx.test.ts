// tests/compute/exposure-leverage-fx.test.ts
//
// Two exposure bugs in lib/compute/exposure.ts:
//
// BUG 3 — a leveraged or inverse fund counted as a plain long. Exposure is
//   market value times the fund's SIGNED leverage factor (owner ruling
//   2026-11-07, `resolveLeveragedExposure`); an option on such a fund is its
//   delta exposure times the UNDERLYING's factor; a flagged fund with no
//   usable factor is left out of net and gross and counted (the What-if's
//   stopgap rule in lib/compute/exposure-delta.ts). Total market value stays
//   the plain dollars in the book.
//
// BUG 7 — option delta exposure was left in the option's NATIVE currency, and
//   the per-value ratio divided by FX. The exposure is converted at the
//   underlying's usd_per_unit; the ratio is delta x spot / option close.
//
// Synthetic symbols and round figures only.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import {
  getOptionExposureMap,
  getPortfolioExposureSummary,
  getNetExposureForSymbolFamilies,
} from "@/lib/compute/exposure";
import { computePortfolioGreeks } from "@/lib/compute/options-greeks";
import { todayET } from "@/lib/calendar/date-utils";

let db: Database.Database;
let acct: number;

function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function seedSecurity(fields: {
  symbol: string;
  name: string;
  type: string;
  currency?: string;
  leverageFactor?: number | null;
  underlying?: string;
  optionType?: "CALL" | "PUT";
  strike?: number;
  expiration?: string;
  multiplier?: number;
}): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, currency, leverage_factor,
         underlying_symbol, option_type, strike_price, expiration_date, multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      fields.symbol,
      fields.name,
      fields.type,
      fields.currency ?? "USD",
      fields.leverageFactor ?? null,
      fields.underlying ?? null,
      fields.optionType ?? null,
      fields.strike ?? null,
      fields.expiration ?? null,
      fields.multiplier ?? 1
    ).lastInsertRowid as number;
}

function seedHolding(securityId: number, quantity: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, ?, 'test:' || ?)"
  ).run(acct, securityId, quantity, todayET(), securityId);
}

function seedPrice(securityId: number, price: number) {
  db.prepare(
    "INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, ?, 'test')"
  ).run(securityId, price, todayET());
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT INTO accounts (name) VALUES ('Test')").run();
  acct = (db.prepare("SELECT id FROM accounts WHERE name = 'Test'").get() as { id: number }).id;
});

describe("BUG 3: leveraged and inverse funds in the exposure summary", () => {
  it("an inverse 3x fund is short three times its money: net -$20k, gross $40k", () => {
    const fund = seedSecurity({ symbol: "ZZZS", name: "ZZZ UltraPro Short Fund", type: "ETF", leverageFactor: -3 });
    seedHolding(fund, 100);
    seedPrice(fund, 100); // $10,000
    const stock = seedSecurity({ symbol: "ZZZA", name: "ZZZA Inc", type: "Stock" });
    seedHolding(stock, 100);
    seedPrice(stock, 100); // $10,000

    const s = getPortfolioExposureSummary(db);
    expect(s.total_market_value).toBeCloseTo(20_000, 6);
    expect(s.net_exposure).toBeCloseTo(-20_000, 6);
    expect(s.gross_exposure).toBeCloseTo(40_000, 6);
    expect(s.leveraged_unmodelled_count).toBe(0);
  });

  it("a flagged fund with no factor is left out of net and gross, and counted", () => {
    const fund = seedSecurity({ symbol: "ZZZU", name: "ZZZ UltraPro Fund", type: "ETF", leverageFactor: null });
    seedHolding(fund, 100);
    seedPrice(fund, 100); // $10,000, no sign or multiple known
    const stock = seedSecurity({ symbol: "ZZZA", name: "ZZZA Inc", type: "Stock" });
    seedHolding(stock, 100);
    seedPrice(stock, 100); // $10,000

    const s = getPortfolioExposureSummary(db);
    expect(s.total_market_value).toBeCloseTo(20_000, 6);
    expect(s.net_exposure).toBeCloseTo(10_000, 6);
    expect(s.gross_exposure).toBeCloseTo(10_000, 6);
    expect(s.leveraged_unmodelled_count).toBe(1);
    expect(s.leveraged_unmodelled_market_value).toBeCloseTo(10_000, 6);
  });

  it("an option on a factored fund carries its delta exposure times the underlying's factor", () => {
    const fund = seedSecurity({ symbol: "ZZZL", name: "ZZZ 3X Bull Fund", type: "ETF", leverageFactor: 3 });
    seedPrice(fund, 100); // underlying priced, not held
    const call = seedSecurity({
      symbol: "ZZZL C100",
      name: "ZZZL C100",
      type: "Option",
      underlying: "ZZZL",
      optionType: "CALL",
      strike: 100,
      expiration: addDays(todayET(), 365),
      multiplier: 100,
    });
    seedHolding(call, 1);
    seedPrice(call, 20);

    const delta = getOptionExposureMap(db).get(call)!;
    expect(delta).toBeGreaterThan(0);
    const s = getPortfolioExposureSummary(db);
    expect(s.net_exposure).toBeCloseTo(3 * delta, 6);
    expect(s.total_market_value).toBeCloseTo(2_000, 6);
  });

  it("the earnings cockpit family reader applies the factor too", () => {
    const fund = seedSecurity({ symbol: "ZZZS", name: "ZZZ UltraPro Short Fund", type: "ETF", leverageFactor: -3 });
    seedHolding(fund, 100);
    seedPrice(fund, 100);
    const out = getNetExposureForSymbolFamilies(db, ["ZZZS"]);
    expect(out.ZZZS).toBeCloseTo(-30_000, 6);
  });
});

describe("BUG 7: option delta exposure in US dollars", () => {
  it("a yen call's exposure is converted at the underlying's rate; the ratio has no FX", () => {
    upsertFxRate(db, { currency: "JPY", usdPerUnit: 0.0067, asOf: todayET(), source: "test" });
    const stock = seedSecurity({ symbol: "9999", name: "ZZZ KK", type: "Stock", currency: "JPY" });
    seedPrice(stock, 3_000);
    const call = seedSecurity({
      symbol: "9999 C3000",
      name: "9999 C3000",
      type: "Option",
      currency: "JPY",
      underlying: "9999",
      optionType: "CALL",
      strike: 3_000,
      expiration: addDays(todayET(), 180),
      multiplier: 100,
    });
    seedHolding(call, 1);
    seedPrice(call, 150);

    const pos = computePortfolioGreeks(db).positions.find((p) => p.securityId === call)!;
    const delta = pos.greeks!.delta;
    const native = delta * 3_000 * 100 * 1;

    const map = getOptionExposureMap(db);
    expect(map.get(call)!).toBeCloseTo(native * 0.0067, 6);
    expect(map.byHolding.get(`${acct}:${call}`)!).toBeCloseTo(native * 0.0067, 6);
    expect(map.perValueDollar.get(call)!).toBeCloseTo((delta * 3_000) / 150, 9);

    // The option's USD value (1 x 150 x 100 x 0.0067 = $100.50) times the
    // ratio equals its USD exposure.
    const usdValue = 1 * 150 * 100 * 0.0067;
    expect(usdValue * map.perValueDollar.get(call)!).toBeCloseTo(native * 0.0067, 6);

    const s = getPortfolioExposureSummary(db);
    expect(s.net_exposure).toBeCloseTo(native * 0.0067, 6);
  });
});
