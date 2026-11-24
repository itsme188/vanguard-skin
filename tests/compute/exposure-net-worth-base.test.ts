// tests/compute/exposure-net-worth-base.test.ts
//
// BUG 1 — the net/gross exposure badge divided by the signed market value of
// holdings. Broker cash is not in that figure, so a mostly-cash account read
// near 100% net, and a net-short scope flipped sign (net 1.0, gross -2.0).
//
// Ruling (2026-11-23, reversible): exposure percentages divide by NET WORTH,
// the Portfolio strip's figure (getPortfolioCurrentValues(...).totalValue).
// A missing, zero, negative or tiny base (at or under NEAR_NEUTRAL_NET_SHARE
// of gross exposure) prints no ratio. A cash-equivalent fund carries zero
// exposure: it is in the base only. Long and short exposure are reported
// apart (net = long + short, gross = long - short).
//
// Net worth is seeded through daily_valuations (the reader's middle source).
// Synthetic symbols and round figures only.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getPortfolioExposureSummary } from "@/lib/compute/exposure";
import { NEAR_NEUTRAL_NET_SHARE } from "@/lib/compute/exposure-delta";
import { todayET } from "@/lib/calendar/date-utils";

let db: Database.Database;
let A: number;
let B: number;
const TODAY = todayET();

function account(name: string): number {
  return db.prepare("INSERT INTO accounts (name) VALUES (?)").run(name).lastInsertRowid as number;
}

function security(symbol: string, fields: Partial<Record<"type" | "name" | "fund_category", string>> & { leverage?: number | null } = {}): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, fund_category, leverage_factor, currency, multiplier)
       VALUES (?, ?, ?, ?, ?, 'USD', 1)`
    )
    .run(symbol, fields.name ?? `${symbol} Corp`, fields.type ?? "Stock", fields.fund_category ?? null, fields.leverage ?? null)
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

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  A = account("ZZ One");
  B = account("ZZ Two");
});

describe("BUG 1: exposure ratios are shares of net worth", () => {
  it("a mostly-cash account reads a small ratio, not ~100%", () => {
    hold(A, security("ZZA"), 100, 100); // 10,000 long
    netWorth(A, 100_000); // 90,000 of it is cash at the broker

    const s = getPortfolioExposureSummary(db, [A]);
    expect(s.total_market_value).toBeCloseTo(10_000, 6);
    expect(s.net_worth).toBeCloseTo(100_000, 6);
    expect(s.net_exposure).toBeCloseTo(10_000, 6);
    expect(s.net_ratio).toBeCloseTo(0.1, 9);
    expect(s.gross_ratio).toBeCloseTo(0.1, 9);
    expect(s.long_exposure).toBeCloseTo(10_000, 6);
    expect(s.short_exposure).toBe(0);
  });

  it("a net-short scope keeps its signs (net negative, gross positive)", () => {
    hold(A, security("ZZA"), 100, 100); // +10,000
    hold(A, security("ZZS"), -300, 100); // -30,000
    netWorth(A, 50_000);

    const s = getPortfolioExposureSummary(db, [A]);
    expect(s.net_exposure).toBeCloseTo(-20_000, 6);
    expect(s.gross_exposure).toBeCloseTo(40_000, 6);
    expect(s.long_exposure).toBeCloseTo(10_000, 6);
    expect(s.short_exposure).toBeCloseTo(-30_000, 6);
    expect(s.long_exposure + s.short_exposure).toBeCloseTo(s.net_exposure, 9);
    expect(s.long_exposure - s.short_exposure).toBeCloseTo(s.gross_exposure, 9);
    expect(s.net_ratio).toBeCloseTo(-0.4, 9);
    expect(s.gross_ratio).toBeCloseTo(0.8, 9);
  });

  it("no net worth on file: no ratio", () => {
    hold(A, security("ZZA"), 100, 100);
    const s = getPortfolioExposureSummary(db, [A]);
    expect(s.net_worth).toBeNull();
    expect(s.net_ratio).toBeNull();
    expect(s.gross_ratio).toBeNull();
    expect(s.net_exposure).toBeCloseTo(10_000, 6);
  });

  it("a zero or negative net worth: no ratio", () => {
    hold(A, security("ZZA"), 100, 100);
    netWorth(A, 0);
    expect(getPortfolioExposureSummary(db, [A]).net_ratio).toBeNull();
    db.prepare("UPDATE daily_valuations SET total_value = -5000").run();
    const s = getPortfolioExposureSummary(db, [A]);
    expect(s.net_worth).toBeCloseTo(-5_000, 6);
    expect(s.net_ratio).toBeNull();
    expect(s.gross_ratio).toBeNull();
  });

  it("a net worth tiny against gross exposure: no ratio (the What-if's near-neutral share)", () => {
    expect(NEAR_NEUTRAL_NET_SHARE).toBe(0.05);
    hold(A, security("ZZA"), 1_000, 100); // +100,000
    hold(A, security("ZZS"), -990, 100); // -99,000
    netWorth(A, 1_000); // gross 199,000; 1,000 is under 5% of it
    let s = getPortfolioExposureSummary(db, [A]);
    expect(s.gross_exposure).toBeCloseTo(199_000, 6);
    expect(s.net_ratio).toBeNull();
    expect(s.gross_ratio).toBeNull();

    // Just over the line (10,000 > 0.05 x 199,000 = 9,950): ratios print.
    db.prepare("UPDATE daily_valuations SET total_value = 10000").run();
    s = getPortfolioExposureSummary(db, [A]);
    expect(s.net_ratio).toBeCloseTo(0.1, 9);
    expect(s.gross_ratio).toBeCloseTo(19.9, 9);
  });

  it("a cash-equivalent fund carries no exposure; it is in the base only", () => {
    hold(A, security("ZZA"), 500, 100); // 50,000
    hold(A, security("ZZMM", { type: "Mutual Fund", name: "ZZ Money Market", fund_category: "Money Market" }), 50_000, 1);
    netWorth(A, 100_000);

    const s = getPortfolioExposureSummary(db, [A]);
    expect(s.total_market_value).toBeCloseTo(100_000, 6);
    expect(s.net_exposure).toBeCloseTo(50_000, 6);
    expect(s.gross_exposure).toBeCloseTo(50_000, 6);
    expect(s.net_ratio).toBeCloseTo(0.5, 9);
  });

  it("a leveraged fund with no factor stays out of exposure and inside the base", () => {
    hold(A, security("ZZA"), 100, 100); // 10,000
    hold(A, security("ZZUP", { type: "ETF", name: "ZZ UltraPro Fund" }), 100, 100); // 10,000, no factor
    netWorth(A, 40_000);

    const s = getPortfolioExposureSummary(db, [A]);
    expect(s.leveraged_unmodelled_count).toBe(1);
    expect(s.net_exposure).toBeCloseTo(10_000, 6);
    expect(s.net_ratio).toBeCloseTo(0.25, 9);
  });

  it("a multi-account scope sums both accounts, never the first", () => {
    hold(A, security("ZZA"), 200, 100); // 20,000
    netWorth(A, 50_000);
    hold(B, security("ZZB"), 100, 100); // 10,000
    netWorth(B, 50_000);

    const both = getPortfolioExposureSummary(db, [A, B]);
    expect(both.net_worth).toBeCloseTo(100_000, 6);
    expect(both.net_ratio).toBeCloseTo(0.3, 9); // first account alone: 0.4
    expect(getPortfolioExposureSummary(db).net_ratio).toBeCloseTo(0.3, 9);
  });

  it("an account holding positions with no value on file makes the base missing", () => {
    hold(A, security("ZZA"), 200, 100);
    netWorth(A, 50_000);
    hold(B, security("ZZB"), 100, 100); // B has no value row
    const s = getPortfolioExposureSummary(db, [A, B]);
    expect(s.net_worth).toBeNull();
    expect(s.net_ratio).toBeNull();
  });

  it("[] reads nothing; undefined is every account", () => {
    hold(A, security("ZZA"), 100, 100);
    netWorth(A, 20_000);
    expect(getPortfolioExposureSummary(db, [])).toEqual({
      total_market_value: 0,
      net_exposure: 0,
      gross_exposure: 0,
      long_exposure: 0,
      short_exposure: 0,
      net_worth: null,
      net_ratio: null,
      gross_ratio: null,
      leveraged_unmodelled_count: 0,
      leveraged_unmodelled_market_value: 0,
    });
    expect(getPortfolioExposureSummary(db).net_ratio).toBeCloseTo(0.5, 9);
  });
});
