/**
 * query_performance_vs_benchmark (Portfolio Assistant plan, Task 6).
 *
 * Protects: "am I beating SPY" and "what drove it" are answered from the
 * Performance view's own engines (equity curve, period attribution, month
 * view) over the page's one window and the chat's scope. Bound, on a book
 * whose daily return is exactly twice SPY's: the curve ends at
 * 100 x prod(1 + 2b) against 100 x prod(1 + b); the beta part is
 * 2 x (prod(1 + b) - 1); beta + alpha equals the decomposed return; a
 * +20% name at 25% weight contributes 0.05 and a -10% name at 75% weight
 * -0.075; a 1,000 -> 1,100 statement month with no flows returns 0.10.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/compute/period-attribution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compute/period-attribution")>();
  return { ...actual, computePeriodAttribution: vi.fn(actual.computePeriodAttribution) };
});
vi.mock("@/lib/compute/monthly-performance", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compute/monthly-performance")>();
  return { ...actual, computeMonthlyPerformance: vi.fn(actual.computeMonthlyPerformance) };
});

import { computePeriodAttribution } from "@/lib/compute/period-attribution";
import { computeMonthlyPerformance } from "@/lib/compute/monthly-performance";
import { buildEquityCurveData } from "@/lib/compute/equity-curve";
import { getDailyValuationsForAccounts } from "@/lib/queries/daily-valuations";
import { queryPerformanceVsBenchmarkTool } from "@/lib/chat/composite/performance-vs-benchmark";
import { COMPOSITE_MAX_JSON_CHARS } from "@/lib/chat/composite/shared";

const TODAY = "2026-03-03";
const START = "2026-01-01";
/** SPY's daily returns over ten sessions; the portfolio's are exactly twice these. */
const B = [0.004, 0.006, -0.002, 0.005, 0.003, -0.004, 0.006, 0.002, 0.004, -0.001];
let db: Database.Database;

function febDay(i: number): string {
  return `2026-02-${String(2 + i).padStart(2, "0")}`;
}

function stockAt(symbol: string, sector: string, accountId: number, qty: number, startPrice: number, endPrice: number): void {
  const id = db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency, sector) VALUES (?, ?, 'Stock', 'USD', ?)")
    .run(symbol, `${symbol} Co`, sector).lastInsertRowid as number;
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, 1, ?, ?)",
  ).run(accountId, id, qty, START, `h-${symbol}`);
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(id, START, startPrice);
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(id, TODAY, endPrice);
}

function snapshot(accountId: number, date: string, value: number): void {
  db.prepare(
    "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (?, ?, ?, 'ibkr-activity')",
  ).run(accountId, date, value);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  vi.mocked(computePeriodAttribution).mockClear();
  vi.mocked(computeMonthlyPerformance).mockClear();

  // IBKR (3): eleven daily values in February, each day's return 2 x SPY's.
  let p = 1000;
  let s = 500;
  for (let i = 0; i <= B.length; i++) {
    if (i > 0) {
      p *= 1 + 2 * B[i - 1];
      s *= 1 + B[i - 1];
    }
    db.prepare(
      "INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (3, ?, 0, ?, ?)",
    ).run(febDay(i), p, p);
    db.prepare("INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'test')").run(febDay(i), s);
  }
  // Statements: January 1,000, February 1,100, no flows.
  snapshot(3, "2026-01-31", 1000);
  snapshot(3, "2026-02-28", 1100);
  // Attribution book at the window start: 100 of AAA (+20%), 300 of BBB (-10%).
  stockAt("AAA", "Technology", 3, 10, 10, 12);
  stockAt("BBB", "Energy", 3, 10, 30, 27);
  // Another account the IBKR answer must never name.
  stockAt("VVV", "Health Care", 1, 10, 50, 60);
});

type Out = {
  error?: string;
  window: { start: string | null; end: string; period: string };
  vs_benchmark: { portfolio_index_end: number; benchmark_index_end: number; portfolio_return: number; benchmark_return: number; first_date: string };
  attribution: {
    top_contributors: { symbol: string; contribution: number }[];
    top_detractors: { symbol: string; contribution: number }[];
    top_sectors: { sector: string; contribution: number }[];
    beta_contribution: number | null;
    alpha_contribution: number | null;
    decomposed_return: { portfolio_return: number; daily_pairs: number } | null;
  };
  month: {
    month_end: string;
    note?: string;
    blended: { return_fraction: number | null; gain_loss_usd: number | null };
    accounts: { account: string; return_fraction: number | null }[];
  };
};

const ctx3 = { accountIds: [3], today: TODAY };

describe("query_performance_vs_benchmark", () => {
  it("returns the engines' figures for the page's window and scope (parity)", () => {
    const out = queryPerformanceVsBenchmarkTool.run(db, {}, ctx3) as Out;
    expect(out.window).toMatchObject({ period: "ytd", start: START, end: TODAY });
    const attribution = computePeriodAttribution(db, [3], START, TODAY, "SPY");
    expect(out.attribution.top_contributors).toEqual(attribution.topContributors);
    expect(out.attribution.top_detractors).toEqual(attribution.topDetractors);
    expect(out.attribution.beta_contribution).toBe(attribution.betaVsAlpha.betaContribution);
    expect(out.attribution.alpha_contribution).toBe(attribution.betaVsAlpha.alphaContribution);
    const monthly = computeMonthlyPerformance(db, [3], "2026-02-28");
    expect(out.month.blended.return_fraction).toBe(monthly.blended.returnFraction);
    const daily = getDailyValuationsForAccounts(db, [3], { startDate: "2026-01-31", endDate: TODAY, fullCoverageOnly: true });
    const bench = db
      .prepare("SELECT date, close_price FROM benchmark_prices WHERE symbol = 'SPY' AND date BETWEEN ? AND ? ORDER BY date")
      .all(START, TODAY) as { date: string; close_price: number }[];
    const curve = buildEquityCurveData(daily, bench, [], [], "2026-01-31");
    expect(out.vs_benchmark.portfolio_index_end).toBe(curve[curve.length - 1].portfolio);
    expect(out.vs_benchmark.benchmark_index_end).toBe(curve[curve.length - 1].benchmark);
  });

  it("matches the hand-worked curve, attribution and month", () => {
    const out = queryPerformanceVsBenchmarkTool.run(db, {}, ctx3) as Out;
    const benchGrowth = B.reduce((g, b) => g * (1 + b), 1);
    const portGrowth = B.reduce((g, b) => g * (1 + 2 * b), 1);
    expect(out.vs_benchmark.first_date).toBe("2026-02-02");
    expect(out.vs_benchmark.portfolio_index_end).toBeCloseTo(100 * portGrowth, 9);
    expect(out.vs_benchmark.benchmark_index_end).toBeCloseTo(100 * benchGrowth, 9);
    expect(out.vs_benchmark.portfolio_return).toBeCloseTo(portGrowth - 1, 9);
    // Beta is exactly 2, so the beta part is 2 x SPY's compounded return.
    expect(out.attribution.beta_contribution).toBeCloseTo(2 * (benchGrowth - 1), 9);
    expect(out.attribution.decomposed_return?.portfolio_return).toBeCloseTo(portGrowth - 1, 9);
    // Conservation: beta + alpha = the decomposed return.
    expect((out.attribution.beta_contribution ?? 0) + (out.attribution.alpha_contribution ?? 0)).toBeCloseTo(
      out.attribution.decomposed_return?.portfolio_return ?? NaN,
      12,
    );
    expect(out.attribution.top_contributors).toEqual([{ symbol: "AAA", contribution: expect.closeTo(0.05, 12) }]);
    expect(out.attribution.top_detractors).toEqual([{ symbol: "BBB", contribution: expect.closeTo(-0.075, 12) }]);
    // Conservation: the sectors sum to the position contributions (all fit in the top 5 here).
    const sectorSum = out.attribution.top_sectors.reduce((t, s) => t + s.contribution, 0);
    expect(sectorSum).toBeCloseTo(0.05 - 0.075, 12);
    expect(out.month.month_end).toBe("2026-02-28");
    expect(out.month.blended.return_fraction).toBeCloseTo(0.1, 12);
    expect(out.month.blended.gain_loss_usd).toBeCloseTo(100, 9);
    expect(out.month.accounts.map((a) => a.account)).toEqual(["IBKR"]);
    const text = JSON.stringify(out);
    expect(text).not.toContain("VVV");
    expect(text).not.toContain("Vanguard");
  });

  it("falls back to the newest statement month and says so", () => {
    const out = queryPerformanceVsBenchmarkTool.run(db, { month: "2025-06-30" }, ctx3) as Out;
    expect(out.month.month_end).toBe("2026-02-28");
    expect(out.month.note).toBe("No statement in scope for 2025-06-30; showing 2026-02-28.");
  });

  it("an empty scope answers without calling an engine", () => {
    const out = queryPerformanceVsBenchmarkTool.run(db, {}, { accountIds: [], today: TODAY });
    expect(out).toEqual({ error: "No account is in this chat's scope." });
    expect(computePeriodAttribution).not.toHaveBeenCalled();
    expect(computeMonthlyPerformance).not.toHaveBeenCalled();
  });

  it("writes nothing and stays under the size cap with 60 positions", () => {
    for (let i = 0; i < 60; i++) stockAt(`Z${i}`, `Sector${i % 11}`, 3, 1 + i, 10, 9 + (i % 4));
    const before = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const out = queryPerformanceVsBenchmarkTool.run(db, { period: "all" }, { accountIds: undefined, today: TODAY });
    const after = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    expect(after).toBe(before);
    expect(JSON.stringify(out).length).toBeLessThan(COMPOSITE_MAX_JSON_CHARS);
  });
});
