// tests/compute/exposure-expiry-day-close.test.ts
//
// FIX 13 (2026-11-24) — after 16:00 ET on its expiry day an option fell to
// the ±2.5× market-value fallback.
//
// computePortfolioGreeks marks a contract expired at the 16:00 ET close of
// its expiry day (Greeks null), while liveOptionExpirationSql keeps the row
// held through the whole Eastern day. Between the close and midnight the
// exposure readers therefore read DEFAULT_OPTION_ELASTICITY x market value:
// an in-the-money call worth 2,000 on a 120 stock, strike 100, read 12,000 at
// 15:00 and 5,000 at 16:30. Now a contract expired only by that same-day
// close, with a priced underlying, takes its end-of-life delta (call: 1 if
// spot > strike else 0; put: -1 if spot < strike else 0) through ONE helper
// both the Diagnostics map and Defense read. Greeks stay null and the
// contract stays "expired" on the Greeks card.
//
// The clock is faked the way tests/compute/exposure-et-expiry.test.ts does.
// Synthetic symbols, round figures.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getPortfolioExposureSummary, getOptionExposureMap } from "@/lib/compute/exposure";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";
import { computePortfolioGreeks } from "@/lib/compute/options-greeks";

const EXPIRY = "2031-06-20";
const DAY_AFTER = "2031-06-21";
const AT_1500_ET = new Date(`${EXPIRY}T19:00:00Z`); // 15:00 EDT
const AT_1630_ET = new Date(`${EXPIRY}T20:30:00Z`); // 16:30 EDT
const NEXT_DAY_1000_ET = new Date(`${DAY_AFTER}T14:00:00Z`);

let db: Database.Database;
let A: number;

function security(symbol: string, f: { type?: string; underlying?: string; optionType?: string; strike?: number } = {}) {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price,
                               expiration_date, currency, multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?)`
    )
    .run(
      symbol,
      symbol,
      f.type ?? "Stock",
      f.underlying ?? null,
      f.optionType ?? null,
      f.strike ?? null,
      f.optionType ? EXPIRY : null,
      f.optionType ? 100 : 1
    ).lastInsertRowid as number;
}

function price(securityId: number, close: number) {
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2031-06-19', ?, 'test')").run(
    securityId,
    close
  );
}

function hold(securityId: number, quantity: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, '2031-06-19', ?)"
  ).run(A, securityId, quantity, `h:${securityId}`);
}

/** A held contract on ZZUN (spot 120, not itself held). */
function contract(optionType: "CALL" | "PUT", strike: number, close: number, quantity = 1): number {
  const id = security(`ZZUN  ${optionType[0]}${strike}`, { type: "Option", underlying: "ZZUN", optionType, strike });
  price(id, close);
  hold(id, quantity);
  return id;
}

function at(now: Date) {
  vi.setSystemTime(now);
  const summary = getPortfolioExposureSummary(db, [A]);
  const defense = computeDefenseAnalysis(db, [A]);
  return { summary, defense };
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  A = db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Trading')").run().lastInsertRowid as number;
  price(security("ZZUN"), 120);
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("FIX 13: an option expired only by the same-day close takes its end-of-life delta", () => {
  it("an in-the-money call reads 12,000 at 15:00 and at 16:30 ET, in Diagnostics and Defense", () => {
    contract("CALL", 100, 20); // market value 2,000

    const before = at(AT_1500_ET);
    expect(before.summary.total_market_value).toBeCloseTo(2_000, 6);
    expect(before.summary.net_exposure).toBeCloseTo(12_000, 0);
    expect(before.defense.summary.grossExposure).toBeCloseTo(12_000, 0);

    const after = at(AT_1630_ET);
    expect(after.summary.net_exposure).toBeCloseTo(12_000, 6);
    expect(after.summary.gross_exposure).toBeCloseTo(12_000, 6);
    expect(after.defense.summary.netExposure).toBeCloseTo(12_000, 6);
    expect(after.defense.summary.grossExposure).toBeCloseTo(12_000, 6);
    // No ±2.5× fallback diagnostic for it.
    expect(after.defense.diagnostics.filter((d) => d.kind === "greeks_fallback")).toEqual([]);
  });

  it("the Greeks card still calls it expired with no Greeks", () => {
    contract("CALL", 100, 20);
    vi.setSystemTime(AT_1630_ET);
    const greeks = computePortfolioGreeks(db, { accountIds: [A] });
    expect(greeks.positions).toHaveLength(1);
    expect(greeks.positions[0].expired).toBe(true);
    expect(greeks.positions[0].greeks).toBeNull();
    expect(greeks.expiredPositions).toBe(1);
  });

  it("the per-dollar ratio reads the end-of-life delta too", () => {
    const id = contract("CALL", 100, 20);
    vi.setSystemTime(AT_1630_ET);
    const map = getOptionExposureMap(db, [A]);
    expect(map.get(id)).toBeCloseTo(12_000, 6);
    // Δ × spot ÷ option close = 1 × 120 ÷ 20.
    expect(map.perValueDollar.get(id)).toBeCloseTo(6, 9);
  });

  it("an out-of-the-money call after the close is 0, not 2.5× its value", () => {
    contract("CALL", 130, 0.05);
    const { summary, defense } = at(AT_1630_ET);
    expect(summary.net_exposure).toBe(0);
    expect(summary.gross_exposure).toBe(0);
    expect(defense.summary.netExposure).toBe(0);
  });

  it("an in-the-money put after the close is short its full notional", () => {
    contract("PUT", 130, 10); // spot 120 < strike 130
    const { summary, defense } = at(AT_1630_ET);
    expect(summary.net_exposure).toBeCloseTo(-12_000, 6);
    expect(defense.summary.netExposure).toBeCloseTo(-12_000, 6);
  });

  it("a written in-the-money put after the close is long its full notional", () => {
    contract("PUT", 130, 10, -1);
    const { summary } = at(AT_1630_ET);
    expect(summary.net_exposure).toBeCloseTo(12_000, 6);
  });

  it("with no underlying price the ±2.5× fallback stays", () => {
    db.prepare("DELETE FROM prices WHERE security_id = (SELECT id FROM securities WHERE symbol = 'ZZUN')").run();
    contract("CALL", 100, 20);
    const { summary, defense } = at(AT_1630_ET);
    expect(summary.net_exposure).toBeCloseTo(2.5 * 2_000, 6);
    expect(defense.summary.netExposure).toBeCloseTo(2.5 * 2_000, 6);
  });

  it("the day after expiry is unchanged: the contract is not held", () => {
    contract("CALL", 100, 20);
    const { summary, defense } = at(NEXT_DAY_1000_ET);
    expect(summary.total_market_value).toBe(0);
    expect(summary.net_exposure).toBe(0);
    expect(defense.summary.netExposure).toBe(0);
    expect(getOptionExposureMap(db, [A]).size).toBe(0);
  });
});
