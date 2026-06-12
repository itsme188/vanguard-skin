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

  describe("multi-account scopes (never collapse to accountIds[0])", () => {
    // resolveScope(db, "all") returns undefined — the whole-portfolio
    // sentinel. The 2026-06-10 fix fell back to the FIRST account by id,
    // presenting one account's attribution as "All accounts" (deep-QA
    // finding 2026-06-11). undefined must now mean: aggregate everything.

    it("undefined scope aggregates contributions from every account", () => {
      expect(resolveScope(db, "all")).toBeUndefined();

      // A symbol held ONLY in account 2 — invisible under first-id collapse.
      db.prepare(
        `INSERT INTO securities (id, symbol, security_type, sector) VALUES (20, 'ACCT2ONLY', 'Stock', 'Industrials')`,
      ).run();
      db.prepare(
        `INSERT INTO prices (security_id, date, close_price, source) VALUES (20, '2026-01-01', 100, 'tws')`,
      ).run();
      db.prepare(
        `INSERT INTO prices (security_id, date, close_price, source) VALUES (20, '2026-04-30', 150, 'tws')`,
      ).run();
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (2, 20, '2026-01-01', 100, 'a2-s')`,
      ).run();

      const r = computePeriodAttribution(db, undefined, "2026-01-01", "2026-04-30");
      expect(r.topContributors.map((c) => c.symbol)).toContain("ACCT2ONLY");
      // Account 1's positions are still in the mix
      expect(r.topContributors.map((c) => c.symbol)).toContain("AAPL");
    });

    it("merges the same security across accounts into ONE row with combined weight", () => {
      // AAPL also held in account 2: 100 more shares at the same prices.
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (2, 10, '2026-01-01', 100, 'a2-aapl')`,
      ).run();

      const r = computePeriodAttribution(db, [1, 2], "2026-01-01", "2026-04-30");
      const aaplRows = r.topContributors.filter((c) => c.symbol === "AAPL");
      expect(aaplRows).toHaveLength(1);
      // Combined: 200 sh × $100 = $20,000 of a $49,000 scope, +20% return.
      expect(aaplRows[0].contribution).toBeCloseTo((20000 / 49000) * 0.2, 8);
    });

    it("runs the beta regression on the SUMMED valuation series, not account[0]'s", () => {
      const day = (i: number) => `2026-05-${String(1 + i).padStart(2, "0")}`;
      const benchReturns = [0.01, -0.005, 0.008, 0.002, -0.003, 0.006, 0.001, -0.004, 0.009];
      const portReturns = benchReturns.map((b) => 1.2 * b + 0.002);

      // Account 2: the active series. Account 3: constant $100k ballast —
      // the combined portfolio has roughly HALF the beta of account 2 alone.
      let bench = 400;
      let port = 100000;
      db.prepare(
        `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'tws')`,
      ).run(day(0), bench);
      db.prepare(
        `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (2, ?, 0, ?, ?)`,
      ).run(day(0), port, port);
      db.prepare(
        `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (3, ?, 100000, 0, 100000)`,
      ).run(day(0));
      for (let i = 0; i < benchReturns.length; i++) {
        bench *= 1 + benchReturns[i];
        port *= 1 + portReturns[i];
        db.prepare(
          `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'tws')`,
        ).run(day(i + 1), bench);
        db.prepare(
          `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (2, ?, 0, ?, ?)`,
        ).run(day(i + 1), port, port);
        db.prepare(
          `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (3, ?, 100000, 0, 100000)`,
        ).run(day(i + 1));
      }

      const combined = computePeriodAttribution(db, [2, 3], day(0), day(9), "SPY");
      const alone = computePeriodAttribution(db, 2, day(0), day(9), "SPY");

      // The decomposition must tie out to the COMBINED period return
      // (port2End + ballast) / (port2Start + ballast) − 1 — under first-id
      // collapse it would tie to account 2's (≈2× larger) return instead.
      const expectedCombinedReturn = (port + 100000) / 200000 - 1;
      expect(
        combined.betaVsAlpha.betaContribution + combined.betaVsAlpha.alphaContribution,
      ).toBeCloseTo(expectedCombinedReturn, 8);

      // And the ballast must dampen beta exposure vs the active account alone.
      expect(combined.betaVsAlpha.betaContribution).toBeLessThan(
        alone.betaVsAlpha.betaContribution * 0.7,
      );
    });

    it("drops partial-coverage dates — an account's series starting mid-window is not a return", () => {
      const day = (i: number) => `2026-05-${String(1 + i).padStart(2, "0")}`;
      const benchReturns = [0.01, -0.005, 0.008, 0.002, -0.003, 0.006, 0.001, -0.004, 0.009];
      const portReturns = benchReturns.map((b) => 1.2 * b + 0.002);

      // Account 2 has rows for the whole window; account 3's coverage only
      // BEGINS on day 4 (live-DB shape: IBKR daily valuations start 3/27,
      // Vanguard+Roth on 4/06). The day3→day4 summed pair is 1 calendar day
      // — inside the gap guard — but jumps by account 3's entire $100k.
      // That jump is coverage, not return, and must be excluded.
      let bench = 400;
      let port = 100000;
      const port2Values: number[] = [port];
      db.prepare(
        `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'tws')`,
      ).run(day(0), bench);
      db.prepare(
        `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (2, ?, 0, ?, ?)`,
      ).run(day(0), port, port);
      for (let i = 0; i < benchReturns.length; i++) {
        bench *= 1 + benchReturns[i];
        port *= 1 + portReturns[i];
        port2Values.push(port);
        db.prepare(
          `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'tws')`,
        ).run(day(i + 1), bench);
        db.prepare(
          `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (2, ?, 0, ?, ?)`,
        ).run(day(i + 1), port, port);
        if (i + 1 >= 4) {
          db.prepare(
            `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (3, ?, 100000, 0, 100000)`,
          ).run(day(i + 1));
        }
      }

      const r = computePeriodAttribution(db, [2, 3], day(0), day(9), "SPY");
      // Decomposition must tie to the FULL-COVERAGE return only: day4→day9
      // on the summed series (port2 + constant ballast). The coverage jump
      // would otherwise read as a ~+90% "return".
      const expectedReturn = (port2Values[9] + 100000) / (port2Values[4] + 100000) - 1;
      expect(
        r.betaVsAlpha.betaContribution + r.betaVsAlpha.alphaContribution,
      ).toBeCloseTo(expectedReturn, 8);
    });

    it("keeps single-account positional calls working (back-compat)", () => {
      const single = computePeriodAttribution(db, 1, "2026-01-01", "2026-04-30");
      const asArray = computePeriodAttribution(db, [1], "2026-01-01", "2026-04-30");
      expect(asArray).toEqual(single);
    });
  });
});
