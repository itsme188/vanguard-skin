import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computePeriodAttribution } from "@/lib/compute/period-attribution";
import { resolveScope } from "@/lib/queries/accounts";

describe("computePeriodAttribution", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    // accounts 1/2/3 are pre-seeded by migrations

    const seed = (
      id: number,
      sym: string,
      sector: string | null,
      startPrice: number,
      endPrice: number,
      qty: number,
    ) => {
      db.prepare(
        `INSERT INTO securities (id, symbol, security_type, sector) VALUES (?, ?, 'Stock', ?)`,
      ).run(id, sym, sector);
      db.prepare(
        `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-01-01', ?, 'tws')`,
      ).run(id, startPrice);
      db.prepare(
        `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-04-30', ?, 'tws')`,
      ).run(id, endPrice);
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, '2026-01-01', ?, ?)`,
      ).run(id, qty, `seed-start-${id}`);
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, '2026-04-30', ?, ?)`,
      ).run(id, qty, `seed-end-${id}`);
    };

    seed(10, "AAPL", "Technology", 100, 120, 100); // +20%
    seed(11, "MSFT", "Technology", 200, 220, 50); // +10%
    seed(12, "GOOG", "Communication Services", 150, 135, 60); // -10%
    seed(13, "JPM", "Financials", 100, 105, 50); // +5%
    seed(14, "XOM", "Energy", 50, 55, 100); // +10%
  });

  it("returns top contributors sorted desc by contribution", () => {
    const r = computePeriodAttribution(db, 1, "2026-01-01", "2026-04-30");
    expect(r.topContributors.length).toBeGreaterThan(0);
    expect(r.topContributors[0].symbol).toBe("AAPL");
    expect(r.topContributors[0].contribution).toBeGreaterThan(0);
    // Verify descending order
    for (let i = 1; i < r.topContributors.length; i++) {
      expect(r.topContributors[i - 1].contribution).toBeGreaterThanOrEqual(
        r.topContributors[i].contribution,
      );
    }
  });

  it("returns top detractors (most-negative first)", () => {
    const r = computePeriodAttribution(db, 1, "2026-01-01", "2026-04-30");
    expect(r.topDetractors.length).toBeGreaterThan(0);
    expect(r.topDetractors[0].symbol).toBe("GOOG");
    expect(r.topDetractors[0].contribution).toBeLessThan(0);
  });

  it("aggregates sector contribution correctly (Technology = AAPL + MSFT)", () => {
    const r = computePeriodAttribution(db, 1, "2026-01-01", "2026-04-30");
    const tech = r.sectorContribution.find((s) => s.sector === "Technology");
    expect(tech).toBeDefined();
    const aaplContrib = r.topContributors.find((c) => c.symbol === "AAPL")!.contribution;
    const msftContrib = r.topContributors.find((c) => c.symbol === "MSFT")!.contribution;
    expect(tech!.contribution).toBeCloseTo(aaplContrib + msftContrib, 6);
  });

  it("groups unclassified positions into 'Unclassified' sector", () => {
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, sector) VALUES (15, 'NOCLASS', 'Stock', NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO prices (security_id, date, close_price, source) VALUES (15, '2026-01-01', 50, 'tws')`,
    ).run();
    db.prepare(
      `INSERT INTO prices (security_id, date, close_price, source) VALUES (15, '2026-04-30', 60, 'tws')`,
    ).run();
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 15, '2026-01-01', 10, 'unc-s')`,
    ).run();
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 15, '2026-04-30', 10, 'unc-e')`,
    ).run();

    const r = computePeriodAttribution(db, 1, "2026-01-01", "2026-04-30");
    expect(r.sectorContribution.find((s) => s.sector === "Unclassified")).toBeDefined();
  });

  describe("beta vs alpha decomposition", () => {
    // Build daily dates "2026-05-01" + i (May has 31 days; we stay within it)
    const day = (i: number) => `2026-05-${String(1 + i).padStart(2, "0")}`;

    /** Seed a daily benchmark + valuation series from per-day returns.
     *  portValues[i] is derived from flow-adjusted returns plus any external
     *  flow amounts landing that day (flows[i]). Returns the seeded values. */
    const seedSeries = (opts: {
      accountId: number;
      benchReturns: number[]; // daily benchmark returns (length n)
      portReturns: number[]; // daily flow-adjusted portfolio returns (length n)
      flows?: Record<number, number>; // dayIndex (1-based pair end) → external flow amount
    }) => {
      const n = opts.benchReturns.length;
      let bench = 400;
      let port = 100000;
      db.prepare(
        `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'tws')`,
      ).run(day(0), bench);
      db.prepare(
        `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (?, ?, 0, ?, ?)`,
      ).run(opts.accountId, day(0), port, port);
      for (let i = 0; i < n; i++) {
        bench *= 1 + opts.benchReturns[i];
        const flow = opts.flows?.[i + 1] ?? 0;
        port = port * (1 + opts.portReturns[i]) + flow;
        db.prepare(
          `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'tws')`,
        ).run(day(i + 1), bench);
        db.prepare(
          `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (?, ?, 0, ?, ?)`,
        ).run(opts.accountId, day(i + 1), port, port);
        if (flow !== 0) {
          db.prepare(
            `INSERT INTO transactions (account_id, trade_date, type, amount, is_external_flow, source_key) VALUES (?, ?, 'WITHDRAWAL', ?, 1, ?)`,
          ).run(opts.accountId, day(i + 1), flow, `flow-${opts.accountId}-${i}`);
        }
      }
    };

    const compound = (rets: number[]) => rets.reduce((p, r) => p * (1 + r), 1) - 1;

    // Hand-computable: port = 1.2 × bench + 0.002 each day → regression beta is
    // exactly 1.2; betaContribution = 1.2 × compounded benchmark return; alpha =
    // compounded portfolio return − betaContribution.
    const benchReturns = [0.01, -0.005, 0.008, 0.002, -0.003, 0.006, 0.001, -0.004, 0.009];
    const portReturns = benchReturns.map((b) => 1.2 * b + 0.002);

    it("alpha is portfolio return minus beta×benchmark — never the negation of beta", () => {
      // Live-DB condition for the 2026-06-10 bug: NO holdings/prices rows exist
      // at the period start (account 2 has none seeded), so per-position
      // contributions are empty. Pre-fix, alpha = 0 − betaContribution ≡ −beta.
      seedSeries({ accountId: 2, benchReturns, portReturns });

      const r = computePeriodAttribution(db, 2, day(0), day(9), "SPY");
      const { betaContribution, alphaContribution } = r.betaVsAlpha;

      expect(betaContribution).not.toBe(0);
      // The bug signature: alpha ≡ −beta (sums to exactly 0)
      expect(Math.abs(betaContribution + alphaContribution)).toBeGreaterThan(0.0001);

      const expectedPortReturn = compound(portReturns);
      const expectedBenchReturn = compound(benchReturns);
      expect(betaContribution).toBeCloseTo(1.2 * expectedBenchReturn, 8);
      expect(alphaContribution).toBeCloseTo(expectedPortReturn - 1.2 * expectedBenchReturn, 8);
      // And the decomposition ties out to the portfolio's period return
      expect(betaContribution + alphaContribution).toBeCloseTo(expectedPortReturn, 8);
    });

    it("excludes external cash flows from both the regression and the period return", () => {
      // Same return series, but a -10,000 withdrawal lands on day 5. The
      // valuation drops by the flow; the decomposition must be unchanged.
      seedSeries({ accountId: 2, benchReturns, portReturns, flows: { 5: -10000 } });

      const r = computePeriodAttribution(db, 2, day(0), day(9), "SPY");
      const expectedPortReturn = compound(portReturns);
      const expectedBenchReturn = compound(benchReturns);
      expect(r.betaVsAlpha.betaContribution).toBeCloseTo(1.2 * expectedBenchReturn, 8);
      expect(r.betaVsAlpha.alphaContribution).toBeCloseTo(
        expectedPortReturn - 1.2 * expectedBenchReturn,
        8,
      );
    });

    it("drops return pairs spanning >7 calendar days (prices gap guard)", () => {
      // Dense daily series in May, then a single far-future pair across a
      // multi-week gap with an absurd jump — the gap pair must not poison
      // beta or the period return.
      seedSeries({ accountId: 2, benchReturns, portReturns });
      db.prepare(
        `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', '2026-06-30', 500, 'tws')`,
      ).run();
      db.prepare(
        `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (2, '2026-06-30', 0, 500000, 500000)`,
      ).run();

      const r = computePeriodAttribution(db, 2, day(0), "2026-06-30", "SPY");
      const expectedPortReturn = compound(portReturns);
      const expectedBenchReturn = compound(benchReturns);
      expect(r.betaVsAlpha.betaContribution).toBeCloseTo(1.2 * expectedBenchReturn, 8);
      expect(r.betaVsAlpha.alphaContribution).toBeCloseTo(
        expectedPortReturn - 1.2 * expectedBenchReturn,
        8,
      );
    });
  });

  it("returns empty/zero results safely when start or end snapshot is missing", () => {
    const r = computePeriodAttribution(db, 1, "2025-01-01", "2025-04-30");
    expect(r.topContributors).toEqual([]);
    expect(r.topDetractors).toEqual([]);
    expect(r.sectorContribution).toEqual([]);
    expect(r.betaVsAlpha).toEqual({ betaContribution: 0, alphaContribution: 0 });
  });

  it("attribution renders when scope is 'all' — direct first-account query succeeds where resolveScope returns undefined", () => {
    // Regression: resolveScope(db, "all") returns undefined (no-filter sentinel),
    // so ids?.[0] is always undefined and attribution silently never ran on the
    // default scope. The fix queries for the first account directly.
    //
    // Simulate what PerformanceView does after the fix:
    const scopeIds = resolveScope(db, "all");
    // Confirm the old behaviour: resolveScope returns undefined for "all"
    expect(scopeIds).toBeUndefined();

    // The fix: fall back to a direct query when resolveScope returns undefined
    const row = db
      .prepare("SELECT id FROM accounts ORDER BY id LIMIT 1")
      .get() as { id: number } | undefined;
    const attrAccountId = row?.id;

    // There must be at least one account (seeded by migration 002)
    expect(attrAccountId).toBeDefined();

    // Attribution must succeed (return non-empty results) for that account
    const r = computePeriodAttribution(db, attrAccountId!, "2026-01-01", "2026-04-30");
    expect(r.topContributors.length).toBeGreaterThan(0);
  });
});
