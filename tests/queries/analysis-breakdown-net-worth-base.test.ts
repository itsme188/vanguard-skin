// tests/queries/analysis-breakdown-net-worth-base.test.ts
//
// BUG 2 — Breakdown percentages flipped sign on a net-short scope (Tech
// +50,000 and Financials -100,000 read Tech -100% and Financials +200%), and
// the two allocation readers counted a leveraged or inverse fund as a plain
// long.
//
// Now: "Net exp %" is each bucket's exposure over NET WORTH, the same base
// and the same helpers as the Diagnostics badge (getPortfolioExposureSummary),
// so a bucket's sign is its exposure's sign. A leveraged fund counts at its
// signed factor; a flagged fund with no usable factor is left out of the
// bucket's exposure and counted (`leveraged_unmodelled_count`), while its
// market value stays in Value and "%" (the Fixed Income card's parity with
// the Breakdown's signed holdings total, E3). "%" has no figure when the
// signed holdings total is zero or negative. A cash-equivalent fund carries
// no exposure.
//
// Net worth is seeded through daily_valuations. Synthetic symbols, round
// figures only.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAllocationByDimension } from "@/lib/queries/analysis";
import { getPortfolioExposureSummary } from "@/lib/compute/exposure";
import { todayET } from "@/lib/calendar/date-utils";

let db: Database.Database;
let A: number;
let B: number;
const TODAY = todayET();

function account(name: string): number {
  return db.prepare("INSERT INTO accounts (name) VALUES (?)").run(name).lastInsertRowid as number;
}

function security(
  symbol: string,
  f: { type?: string; name?: string; sector?: string; fund_category?: string; leverage?: number | null } = {}
): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, sector, fund_category, leverage_factor, currency, multiplier)
       VALUES (?, ?, ?, ?, ?, ?, 'USD', 1)`
    )
    .run(symbol, f.name ?? `${symbol} Corp`, f.type ?? "Stock", f.sector ?? null, f.fund_category ?? null, f.leverage ?? null)
    .lastInsertRowid as number;
}

function hold(accountId: number, securityId: number, quantity: number, price: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, ?, ?)"
  ).run(accountId, securityId, quantity, TODAY, `t:${accountId}:${securityId}`);
  db.prepare("INSERT OR IGNORE INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')").run(
    securityId,
    TODAY,
    price
  );
}

function netWorth(accountId: number, total: number) {
  db.prepare(
    `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
     VALUES (?, ?, 0, ?, ?)`
  ).run(accountId, TODAY, total, total);
}

function bucket(rows: ReturnType<typeof getAllocationByDimension>, name: string) {
  const row = rows.find((r) => r.group_name === name);
  if (!row) throw new Error(`no bucket ${name}`);
  return row;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  A = account("ZZ One");
  B = account("ZZ Two");
});

describe("BUG 2: Breakdown exposure shares of net worth", () => {
  it("a net-short scope: each bucket's sign is its exposure's sign", () => {
    hold(A, security("ZZT", { sector: "Technology" }), 500, 100); // +50,000
    hold(A, security("ZZF", { sector: "Financials" }), -1_000, 100); // -100,000
    netWorth(A, 200_000); // short proceeds and cash at the broker

    for (const dim of ["sector", "asset_class"] as const) {
      const rows = getAllocationByDimension(db, dim, [A]);
      if (dim === "sector") {
        expect(bucket(rows, "Technology").exposure_pct).toBeCloseTo(25, 9);
        expect(bucket(rows, "Financials").exposure_pct).toBeCloseTo(-50, 9);
        // Holdings net is -50,000: "%" of it has no figure (it would flip).
        expect(bucket(rows, "Technology").percentage).toBeNull();
        expect(bucket(rows, "Financials").percentage).toBeNull();
      } else {
        expect(bucket(rows, "Stock").exposure_pct).toBeCloseTo(-25, 9);
      }
    }
  });

  it("the Breakdown's Net exp % sums to the badge's net ratio (one base, one rule)", () => {
    hold(A, security("ZZT", { sector: "Technology" }), 500, 100);
    hold(A, security("ZZF", { sector: "Financials" }), -200, 100);
    hold(A, security("ZZMM", { type: "Mutual Fund", name: "ZZ Money Market", fund_category: "Money Market" }), 10_000, 1);
    netWorth(A, 100_000);
    const rows = getAllocationByDimension(db, "sector", [A]);
    const summary = getPortfolioExposureSummary(db, [A]);
    const sum = rows.reduce((s, r) => s + (r.exposure_pct ?? 0), 0);
    expect(sum).toBeCloseTo(summary.net_ratio! * 100, 9);
    expect(sum).toBeCloseTo(30, 9);
  });

  it("a cash-equivalent fund is a line with value and no exposure", () => {
    hold(A, security("ZZT", { sector: "Technology" }), 500, 100); // 50,000
    hold(A, security("ZZMM", { type: "Mutual Fund", name: "ZZ Money Market", fund_category: "Money Market" }), 50_000, 1);
    netWorth(A, 100_000);
    const rows = getAllocationByDimension(db, "fund_category", [A]);
    const mm = bucket(rows, "Money Market");
    expect(mm.total_market_value).toBeCloseTo(50_000, 6);
    expect(mm.percentage).toBeCloseTo(50, 9);
    expect(mm.net_exposure).toBe(0);
    expect(mm.exposure_pct).toBe(0);
  });

  it("a leveraged fund counts at its signed factor, in the plain reader and the sector look-through", () => {
    hold(A, security("ZZT", { sector: "Technology" }), 500, 100); // +50,000
    hold(A, security("ZZSQ", { type: "ETF", name: "ZZ UltraPro Short Fund", sector: "Technology", leverage: -3 }), 50, 100); // 5,000 x -3
    netWorth(A, 100_000);

    const sector = bucket(getAllocationByDimension(db, "sector", [A]), "Technology");
    expect(sector.total_market_value).toBeCloseTo(55_000, 6);
    expect(sector.net_exposure).toBeCloseTo(35_000, 6);
    expect(sector.exposure_pct).toBeCloseTo(35, 9);

    const etf = bucket(getAllocationByDimension(db, "asset_class", [A]), "ETF");
    expect(etf.net_exposure).toBeCloseTo(-15_000, 6);
    expect(etf.exposure_pct).toBeCloseTo(-15, 9);
  });

  it("a flagged fund with no factor: out of the bucket's exposure, counted, value kept", () => {
    hold(A, security("ZZT", { sector: "Technology" }), 500, 100);
    hold(A, security("ZZUP", { type: "ETF", name: "ZZ UltraPro Fund", sector: "Technology" }), 100, 100); // 10,000
    netWorth(A, 100_000);

    for (const dim of ["sector", "fund_category"] as const) {
      const rows = getAllocationByDimension(db, dim, [A]);
      const total = rows.reduce((s, r) => s + r.total_market_value, 0);
      expect(total).toBeCloseTo(60_000, 6);
      const counted = rows.reduce((s, r) => s + (r.leveraged_unmodelled_count ?? 0), 0);
      expect(counted).toBe(1);
      const exposure = rows.reduce((s, r) => s + r.net_exposure, 0);
      expect(exposure).toBeCloseTo(50_000, 6);
    }
    const tech = bucket(getAllocationByDimension(db, "sector", [A]), "Technology");
    expect(tech.leveraged_unmodelled_count).toBe(1);
    expect(tech.exposure_pct).toBeCloseTo(50, 9);
  });

  it("no usable net worth: no exposure share", () => {
    hold(A, security("ZZT", { sector: "Technology" }), 500, 100);
    const rows = getAllocationByDimension(db, "sector", [A]);
    expect(bucket(rows, "Technology").exposure_pct).toBeNull();
    expect(bucket(rows, "Technology").percentage).toBeCloseTo(100, 9);
  });

  it("a multi-account scope is summed, not the first account", () => {
    hold(A, security("ZZT", { sector: "Technology" }), 200, 100); // 20,000
    netWorth(A, 50_000);
    hold(B, security("ZZE", { sector: "Energy" }), 100, 100); // 10,000
    netWorth(B, 50_000);
    const rows = getAllocationByDimension(db, "sector", [A, B]);
    expect(bucket(rows, "Technology").exposure_pct).toBeCloseTo(20, 9);
    expect(bucket(rows, "Energy").exposure_pct).toBeCloseTo(10, 9);
  });

  it("[] reads nothing", () => {
    hold(A, security("ZZT", { sector: "Technology" }), 200, 100);
    netWorth(A, 50_000);
    expect(getAllocationByDimension(db, "sector", [])).toEqual([]);
    expect(getAllocationByDimension(db, "asset_class", [])).toEqual([]);
  });
});
