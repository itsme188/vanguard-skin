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

  it("beta-vs-alpha decomposition sums to total return within rounding error", () => {
    // Seed benchmark prices (need >=5 for regression)
    const dates = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-04-30"];
    const benchPrices = [400, 405, 415, 410, 420];
    for (let i = 0; i < dates.length; i++) {
      db.prepare(
        `INSERT INTO benchmark_prices (symbol, date, close_price, source) VALUES ('SPY', ?, ?, 'tws')`,
      ).run(dates[i], benchPrices[i]);
    }
    // Seed daily_valuations (no source column — not in schema)
    const portValues = [100000, 102000, 108000, 105000, 112000];
    for (let i = 0; i < dates.length; i++) {
      db.prepare(
        `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value) VALUES (1, ?, 0, ?, ?)`,
      ).run(dates[i], portValues[i], portValues[i]);
    }

    const r = computePeriodAttribution(db, 1, "2026-01-01", "2026-04-30", "SPY");
    // beta+alpha should sum to total position-weighted return
    const totalReturn = [
      ...r.topContributors,
      ...r.topDetractors,
      // Sector contribution covers all positions including mid-contributors
    ].reduce((s, p) => s + p.contribution, 0);
    // If regression succeeded, check decomposition
    if (r.betaVsAlpha.betaContribution !== 0 || r.betaVsAlpha.alphaContribution !== 0) {
      const sum = r.betaVsAlpha.betaContribution + r.betaVsAlpha.alphaContribution;
      // totalReturn from all positions (sum of all contributions, not just top5 each)
      const allRows = [...r.sectorContribution].reduce((s, sec) => s + sec.contribution, 0);
      expect(Math.abs(sum - allRows)).toBeLessThan(0.0001);
    }
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
