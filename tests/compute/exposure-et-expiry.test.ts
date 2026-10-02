// tests/compute/exposure-et-expiry.test.ts
//
// The exposure reads (earnings-cockpit family exposure + the Analysis
// exposure headline) cut expired options and matured bonds on the ET
// calendar through the shared liveOptionExpirationSql / an ET literal —
// never SQLite's UTC date('now'), which reads as TOMORROW between UTC and ET
// midnight. A contract expiring (or a bond maturing) on ET today still
// counts; the next ET day it drops out.
//
// Dates are synthetic and far-future so the fixture never goes stale.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getNetExposureForSymbolFamilies,
  getPortfolioExposureSummary,
} from "@/lib/compute/exposure";

const EXPIRY = "2031-06-20";
const DAY_AFTER = "2031-06-21";

let db: Database.Database;
let acctId: number;

function seedSecurity(
  symbol: string,
  opts: Partial<{
    type: string;
    underlying: string | null;
    optionType: string | null;
    multiplier: number;
    expiration: string | null;
    maturity: string | null;
  }> = {}
): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, multiplier, currency,
                               expiration_date, maturity_date, source_key)
       VALUES (?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?)`
    )
    .run(
      symbol,
      symbol,
      opts.type ?? "Stock",
      opts.underlying ?? null,
      opts.optionType ?? null,
      opts.multiplier ?? 1,
      opts.expiration ?? null,
      opts.maturity ?? null,
      `t:${symbol}`
    ).lastInsertRowid as number;
}

function seedHolding(secId: number, qty: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, '2026-07-01', ?)"
  ).run(acctId, secId, qty, `h:${secId}:${qty}`);
}

function seedPrice(secId: number, price: number) {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-07-07', ?, 'manual')"
  ).run(secId, price);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  acctId = db.prepare("INSERT INTO accounts (name) VALUES ('t')").run().lastInsertRowid as number;
});

afterEach(() => {
  vi.useRealTimers();
});

function seedPut(): void {
  const put = seedSecurity("QQQ   310620P00400000", {
    type: "Option",
    underlying: "QQQ",
    optionType: "PUT",
    multiplier: 100,
    expiration: EXPIRY,
  });
  seedHolding(put, 1);
  seedPrice(put, 4); // MV = 1 × 4 × 100 = 400
}

describe("getNetExposureForSymbolFamilies — ET expiry cutoff", () => {
  it("an option expiring on ET today still counts", () => {
    seedPut();
    const result = getNetExposureForSymbolFamilies(db, ["QQQ"], EXPIRY);
    expect(result.QQQ).toBeLessThan(0); // a long put is negative exposure
  });

  it("an option whose expiration is before ET today contributes nothing", () => {
    seedPut();
    const result = getNetExposureForSymbolFamilies(db, ["QQQ"], DAY_AFTER);
    expect(result.QQQ).toBe(0);
  });

  it("defaults to the ET calendar: after UTC midnight but before ET midnight the contract is still live", () => {
    seedPut();
    vi.useFakeTimers({ toFake: ["Date"] });
    // 02:30 UTC on the day after expiry = 22:30 EDT on the expiry day.
    vi.setSystemTime(new Date(`${DAY_AFTER}T02:30:00Z`));
    const result = getNetExposureForSymbolFamilies(db, ["QQQ"]);
    expect(result.QQQ).toBeLessThan(0);
  });

  it("a bond counts through its maturity day on the ET calendar, then drops out", () => {
    const bond = seedSecurity("BONDX", { type: "Bond", maturity: EXPIRY });
    seedHolding(bond, 10000);
    seedPrice(bond, 99); // MV = 10,000 × 99 / 100 = 9,900
    expect(getNetExposureForSymbolFamilies(db, ["BONDX"], EXPIRY).BONDX).toBeCloseTo(9900, 0);
    expect(getNetExposureForSymbolFamilies(db, ["BONDX"], DAY_AFTER).BONDX).toBe(0);
  });
});

describe("getPortfolioExposureSummary — ET expiry cutoff", () => {
  function seedStock(): void {
    const stock = seedSecurity("QQQ");
    seedHolding(stock, 10);
    seedPrice(stock, 500); // MV = 5,000
  }

  it("an option expiring on ET today is in the headline; the next ET day it is not", () => {
    seedStock();
    seedPut();
    const live = getPortfolioExposureSummary(db, undefined, EXPIRY);
    expect(live.total_market_value).toBeCloseTo(5400, 0);
    expect(live.net_exposure).toBeLessThan(5000);

    const after = getPortfolioExposureSummary(db, undefined, DAY_AFTER);
    expect(after.total_market_value).toBeCloseTo(5000, 0);
    expect(after.net_exposure).toBeCloseTo(5000, 0);
  });

  it("a matured bond drops out on the ET calendar", () => {
    seedStock();
    const bond = seedSecurity("BONDX", { type: "Bond", maturity: EXPIRY });
    seedHolding(bond, 10000);
    seedPrice(bond, 99);
    expect(getPortfolioExposureSummary(db, undefined, EXPIRY).total_market_value).toBeCloseTo(14900, 0);
    expect(getPortfolioExposureSummary(db, undefined, DAY_AFTER).total_market_value).toBeCloseTo(5000, 0);
  });
});
