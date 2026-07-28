import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getAllocationByDimension,
  getConcentrationMetrics,
  getFactorCoverage,
} from "@/lib/queries/analysis";
import { getPortfolioExposureSummary } from "@/lib/compute/exposure";

/**
 * qa: analysis-ibkr-allocation--drops-options-and-shorts-false-100pct-coverage
 *
 * The allocation/concentration/heatmap/coverage universe used
 * latestHoldingsPredicate({ keyBy: "account", includeShorts: false }):
 *  - keyBy "account" dropped any security whose newest holdings row predates
 *    the account's newest row (live: 4 option positions at 07-16..22 vs the
 *    account max 07-27 — 4 of 14 positions silently gone), and
 *  - includeShorts: false dropped real short positions (EWY -100, SMH -30),
 * yet Factor Coverage still printed "8 of 8 (100%)" and the exposure headline
 * printed "net 100% · gross 100%" — impossible for a book holding shorts.
 *
 * User decision 2026-07-28: allocation surfaces use the SAME per-(account,
 * security) universe (incl. shorts) as the exposure/Greeks surfaces.
 */
describe("analysis surfaces cover the full per-(account,security) universe", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1; // seeded by migration 002

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    const seedSecurity = db.prepare(
      `INSERT INTO securities (symbol, name, security_type, multiplier, underlying_symbol)
       VALUES (?, ?, ?, ?, ?)`
    );
    const spy = seedSecurity.run("SPY", "SPDR S&P 500", "Stock", null, null)
      .lastInsertRowid as number;
    const ewy = seedSecurity.run("EWY", "iShares Korea", "ETF", null, null)
      .lastInsertRowid as number;
    const call = seedSecurity.run(
      "SPY   260320C00600000",
      "SPY Mar 2026 600 Call",
      "Option",
      100,
      "SPY"
    ).lastInsertRowid as number;

    const seedHolding = db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, ?, ?, ?)`
    );
    // Long stock + short ETF share the account's newest as_of_date...
    seedHolding.run(ACCOUNT_ID, spy, 100, "2026-07-27", "tws-spy-0727");
    seedHolding.run(ACCOUNT_ID, ewy, -100, "2026-07-27", "tws-ewy-0727");
    // ...while the option's newest row is 5 days older (the live shape).
    seedHolding.run(ACCOUNT_ID, call, 2, "2026-07-22", "tws-call-0722");

    const seedPrice = db.prepare(
      `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`
    );
    seedPrice.run(spy, "2026-07-27", 600);
    seedPrice.run(ewy, "2026-07-27", 60);
    seedPrice.run(call, "2026-07-27", 5);
  });

  it("allocation includes stale-dated option rows and short positions", () => {
    const entries = getAllocationByDimension(db, "security_type");
    const options = entries.find((e) => e.group_name.toLowerCase() === "option");
    expect(options).toBeTruthy();
    expect(options!.position_count).toBe(1);
    expect(options!.total_market_value).toBe(2 * 5 * 100);

    // Shorts net against longs inside their buckets: 100×600 − 100×60.
    const stock = entries.find((e) => e.group_name.toLowerCase() === "stock");
    const etf = entries.find((e) => e.group_name.toLowerCase() === "etf");
    expect(stock!.total_market_value).toBe(60000);
    expect(etf!.total_market_value).toBe(-6000);
  });

  it("concentration metrics see all three positions", () => {
    const metrics = getConcentrationMetrics(db);
    const symbols = metrics.top_positions.map((p) => p.symbol);
    expect(symbols).toContain("SPY   260320C00600000");
    expect(symbols).toContain("EWY");
  });

  it("factor coverage counts the full universe, never a false 100%", () => {
    const coverage = getFactorCoverage(db);
    expect(coverage.totalHoldings).toBe(3);
  });

  it("exposure headline: net < gross when the book holds a short", () => {
    const summary = getPortfolioExposureSummary(db);
    expect(summary.net_exposure).toBeLessThan(summary.gross_exposure);
    // The short's MV must be inside total MV (60000 − 6000 + option MV).
    expect(summary.total_market_value).toBe(60000 - 6000 + 1000);
  });
});
