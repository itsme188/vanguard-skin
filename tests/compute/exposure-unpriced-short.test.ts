// tests/compute/exposure-unpriced-short.test.ts
//
// FIX 12 (2026-11-24) — an unpriced short was valued at $0.
//
// A holding with no close is carried at its cost basis. Every copy of that
// fallback tested `cost_basis > 0`, but a short stores a NEGATIVE basis
// (CLAUDE.md "A short's holdings basis is negative"), so every unpriced short
// fell to ELSE 0: the Diagnostics badge, the Breakdown and the concentration
// universe left the short out while Defense (which already tested `!= 0`)
// counted it. Now one value rule (`HOLDING_VALUE_USD_SQL`, `!= 0`) is read by
// every exposure reader, and the sector Breakdown splits a row's exposure
// across sectors even when the row's value is zero, so its net-exposure
// column always sums to the badge's net.
//
// Book (an IBKR-like scope): long Healthcare 10,000; long Energy stock 1,000;
// an unpriced short stock (basis -5,000); an unpriced short put on the Energy
// stock (basis -1,200; the underlying is priced, so its delta computes).
// Synthetic symbols, round figures.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getPortfolioExposureSummary } from "@/lib/compute/exposure";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";
import { getAllocationByDimension } from "@/lib/queries/analysis";
import { getConcentrationUniverse } from "@/lib/queries/concentration-universe";
import { todayET } from "@/lib/calendar/date-utils";

let db: Database.Database;
let A: number;
const TODAY = todayET();
const EXPIRY = `${Number(TODAY.slice(0, 4)) + 2}-06-20`;

function security(
  symbol: string,
  f: {
    type?: string;
    sector?: string | null;
    underlying?: string;
    optionType?: string;
    strike?: number;
    multiplier?: number;
  } = {}
): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, sector, underlying_symbol, option_type, strike_price,
                               expiration_date, currency, multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?)`
    )
    .run(
      symbol,
      `${symbol} Corp`,
      f.type ?? "Stock",
      f.sector ?? null,
      f.underlying ?? null,
      f.optionType ?? null,
      f.strike ?? null,
      f.optionType ? EXPIRY : null,
      f.multiplier ?? 1
    ).lastInsertRowid as number;
}

function hold(securityId: number, quantity: number, opts: { price?: number; basis?: number } = {}) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(A, securityId, quantity, opts.basis ?? null, TODAY, `t:${A}:${securityId}`);
  if (opts.price !== undefined) {
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')").run(
      securityId,
      TODAY,
      opts.price
    );
  }
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  A = db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Trading')").run().lastInsertRowid as number;
  db.prepare(
    `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
     VALUES (?, ?, 0, 20000, 20000)`
  ).run(A, TODAY);

  hold(security("ZZHC", { sector: "Healthcare" }), 100, { price: 100 }); // 10,000
  hold(security("ZZEN", { sector: "Energy" }), 20, { price: 50 }); // 1,000
  hold(security("ZZSH", { sector: "Technology" }), -100, { basis: -5000 }); // unpriced short
  hold(
    security("ZZEN  P40", {
      type: "Option",
      sector: "Energy",
      underlying: "ZZEN",
      optionType: "PUT",
      strike: 40,
      multiplier: 100,
    }),
    -1,
    { basis: -1200 }
  ); // unpriced short put, underlying priced
});

describe("FIX 12: an unpriced short carries its (negative) cost basis", () => {
  it("the Diagnostics summary counts the short stock at -5,000", () => {
    const s = getPortfolioExposureSummary(db, [A]);
    // 10,000 + 1,000 - 5,000 - 1,200 (the short put's basis is its value).
    expect(s.total_market_value).toBeCloseTo(4_800, 6);
    expect(s.short_exposure).toBeCloseTo(-5_000, 6);
    // The short put's delta exposure is positive (a written put is long delta).
    const putExposure = s.net_exposure - (10_000 + 1_000 - 5_000);
    expect(putExposure).toBeGreaterThan(0);
  });

  it("Diagnostics and Defense agree on net, gross and short for the book", () => {
    const s = getPortfolioExposureSummary(db, [A]);
    const d = computeDefenseAnalysis(db, [A]).summary;
    expect(d.netExposure).toBeCloseTo(s.net_exposure, 6);
    expect(d.grossExposure).toBeCloseTo(s.gross_exposure, 6);
    expect(d.nameShortExposure).toBeCloseTo(s.short_exposure, 6);
    expect(d.nameLongExposure).toBeCloseTo(s.long_exposure, 6);
    // Gross: Healthcare 10,000 + the Energy name (stock and its put, netted)
    // + the short's 5,000.
    expect(s.gross_exposure).toBeCloseTo(s.long_exposure - s.short_exposure, 6);
    expect(s.gross_exposure).toBeCloseTo(s.net_exposure + 10_000, 6);
  });

  it("the sector Breakdown's net-exposure column sums to the summary net", () => {
    const s = getPortfolioExposureSummary(db, [A]);
    const rows = getAllocationByDimension(db, "sector", [A]);
    const sum = rows.reduce((acc, r) => acc + (r.net_exposure ?? 0), 0);
    expect(sum).toBeCloseTo(s.net_exposure, 6);
    expect(rows.find((r) => r.group_name === "Technology")?.net_exposure).toBeCloseTo(-5_000, 6);
    // The Net exp % column sums to the badge's net ratio too.
    const pct = rows.reduce((acc, r) => acc + (r.exposure_pct ?? 0), 0);
    expect(pct / 100).toBeCloseTo(s.net_ratio as number, 9);
  });

  it("a row whose value is zero still splits its exposure into its sector", () => {
    // The short put's basis removed: no price, no basis, value 0, but its
    // delta exposure still computes off the priced underlying.
    db.prepare("UPDATE holdings SET cost_basis = NULL WHERE cost_basis = -1200").run();
    const s = getPortfolioExposureSummary(db, [A]);
    const rows = getAllocationByDimension(db, "sector", [A]);
    const sum = rows.reduce((acc, r) => acc + (r.net_exposure ?? 0), 0);
    expect(sum).toBeCloseTo(s.net_exposure, 6);
    const energy = rows.find((r) => r.group_name === "Energy");
    expect(energy?.net_exposure).toBeGreaterThan(1_000);
  });

  it("the concentration universe carries the unpriced short at its basis, flagged unpriced", () => {
    const universe = getConcentrationUniverse(db, [A]);
    const short = universe.find((p) => p.symbol === "ZZSH");
    expect(short).toBeDefined();
    expect(short?.marketValue).toBeCloseTo(-5_000, 6);
    expect(short?.priced).toBe(false);
    const put = universe.find((p) => p.symbol === "ZZEN  P40");
    expect(put?.marketValue).toBeCloseTo(-1_200, 6);
    expect(put?.priced).toBe(false);
  });
});

// Review follow-up (2026-11-24): the basis fallback is used only when the
// basis's sign matches the quantity's (a long's basis positive, a short's
// negative). A mismatched sign is a data error: the row is valued 0 and stays
// unpriced, as before fix 12, on every reader of the shared rule.
describe("FIX 12 follow-up: a basis whose sign contradicts the quantity values 0", () => {
  let badId: number | null = null;
  function onlyBook(quantity: number, basis: number) {
    db.prepare("DELETE FROM holdings").run();
    badId ??= security("ZZBAD", { sector: "Technology" });
    hold(badId, quantity, { basis });
  }

  function everyReader() {
    const s = getPortfolioExposureSummary(db, [A]);
    const d = computeDefenseAnalysis(db, [A]).summary;
    const tech = getAllocationByDimension(db, "sector", [A]).find((r) => r.group_name === "Technology");
    const conc = getConcentrationUniverse(db, [A]).find((p) => p.symbol === "ZZBAD");
    return { s, d, tech, conc };
  }

  it("a long with a negative basis is valued 0 everywhere", () => {
    badId = null;
    onlyBook(100, -500);
    const { s, d, tech, conc } = everyReader();
    expect(s.total_market_value).toBe(0);
    expect(s.net_exposure).toBe(0);
    expect(s.gross_exposure).toBe(0);
    expect(d.netExposure).toBe(0);
    expect(d.grossExposure).toBe(0);
    expect(tech?.total_market_value ?? 0).toBe(0);
    expect(tech?.net_exposure ?? 0).toBe(0);
    expect(conc).toBeUndefined(); // a zero-value position is dropped
  });

  it("a short with a positive basis is valued 0 everywhere", () => {
    badId = null;
    onlyBook(-100, 500);
    const { s, d, tech, conc } = everyReader();
    expect(s.total_market_value).toBe(0);
    expect(s.net_exposure).toBe(0);
    expect(d.netExposure).toBe(0);
    expect(tech?.total_market_value ?? 0).toBe(0);
    expect(conc).toBeUndefined();
  });

  it("an unpriced long and an unpriced short with matching signs keep their basis", () => {
    badId = null;
    onlyBook(100, 500);
    let r = everyReader();
    expect(r.s.total_market_value).toBeCloseTo(500, 6);
    expect(r.d.netExposure).toBeCloseTo(500, 6);
    expect(r.conc?.marketValue).toBeCloseTo(500, 6);
    expect(r.conc?.priced).toBe(false);
    onlyBook(-100, -500);
    r = everyReader();
    expect(r.s.total_market_value).toBeCloseTo(-500, 6);
    expect(r.d.netExposure).toBeCloseTo(-500, 6);
    expect(r.tech?.net_exposure).toBeCloseTo(-500, 6);
    expect(r.conc?.marketValue).toBeCloseTo(-500, 6);
    expect(r.conc?.priced).toBe(false);
  });
});
