import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { classifySecurities } from "@/lib/compute/classify-securities";
import {
  getAllocationByDimension,
  getConcentrationMetrics,
  getClassificationCoverage,
} from "@/lib/queries/analysis";

let db: Database.Database;

// ─── Seed helpers ─────────────────────────────────────────────────

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts: {
    name?: string;
    security_type?: string;
    asset_class?: string;
    multiplier?: number;
  } = {}
): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, ?, ?, ?)"
    )
    .run(symbol, opts.name ?? `${symbol} Corp`, opts.security_type ?? "stock", opts.asset_class ?? null, opts.multiplier ?? 1);
  return result.lastInsertRowid as number;
}

function seedAccount(db: Database.Database, name: string): number {
  // Use INSERT OR IGNORE since migration 002 seeds some accounts
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  const row = db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number };
  return row.id;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  costBasis: number,
  asOfDate: string = "2026-03-01"
) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, ?)"
  ).run(accountId, securityId, quantity, costBasis, asOfDate);
}

function seedPrice(db: Database.Database, securityId: number, price: number, date: string = "2026-03-01") {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, close_price, date, source) VALUES (?, ?, ?, 'test')"
  ).run(securityId, price, date);
}

// ─── Test setup ───────────────────────────────────────────────────

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// ─── Allocation tests ─────────────────────────────────────────────

describe("getAllocationByDimension", () => {
  it("groups by fund_category", () => {
    const acctId = seedAccount(db, "Test Account");
    const vtiId = seedSecurity(db, "VTI", { security_type: "etf" });
    const aaplId = seedSecurity(db, "AAPL");

    // Classify
    classifySecurities(db);

    // Add holdings and prices
    seedHolding(db, acctId, vtiId, 100, 20000);
    seedPrice(db, vtiId, 250);
    seedHolding(db, acctId, aaplId, 50, 8000);
    seedPrice(db, aaplId, 200);

    const allocation = getAllocationByDimension(db, "fund_category");
    expect(allocation.length).toBeGreaterThan(0);

    const totalMV = allocation.reduce((sum, a) => sum + a.total_market_value, 0);
    expect(totalMV).toBeGreaterThan(0);

    // Check percentage sums to ~100
    const totalPct = allocation.reduce((sum, a) => sum + (a.percentage ?? 0), 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });

  it("groups by geography", () => {
    const acctId = seedAccount(db, "Test Account");
    const vtiId = seedSecurity(db, "VTI", { security_type: "etf" });
    const veuId = seedSecurity(db, "VEU", { security_type: "etf" });

    classifySecurities(db);

    seedHolding(db, acctId, vtiId, 100, 20000);
    seedPrice(db, vtiId, 250);
    seedHolding(db, acctId, veuId, 50, 3000);
    seedPrice(db, veuId, 65);

    const allocation = getAllocationByDimension(db, "geography");
    expect(allocation.length).toBeGreaterThanOrEqual(2);

    const usEntry = allocation.find(a => a.group_name === "US");
    expect(usEntry).toBeTruthy();
    expect(usEntry!.total_market_value).toBe(25000); // 100 * 250

    const intlEntry = allocation.find(a => a.group_name === "International Developed");
    expect(intlEntry).toBeTruthy();
    expect(intlEntry!.total_market_value).toBe(3250); // 50 * 65
  });

  it("groups by style", () => {
    const acctId = seedAccount(db, "Test Account");
    const vviaxId = seedSecurity(db, "VVIAX", { security_type: "mutual_fund" });
    const qqq = seedSecurity(db, "QQQ", { security_type: "etf" });

    classifySecurities(db);

    seedHolding(db, acctId, vviaxId, 100, 10000);
    seedPrice(db, vviaxId, 110);
    seedHolding(db, acctId, qqq, 20, 8000);
    seedPrice(db, qqq, 500);

    const allocation = getAllocationByDimension(db, "style");
    const valueEntry = allocation.find(a => a.group_name === "Value");
    const growthEntry = allocation.find(a => a.group_name === "Growth");

    expect(valueEntry).toBeTruthy();
    expect(growthEntry).toBeTruthy();
  });

  it("handles empty portfolio", () => {
    const allocation = getAllocationByDimension(db, "fund_category");
    expect(allocation.length).toBe(0);
  });

  it("filters by account", () => {
    const acct1 = seedAccount(db, "Account A");
    const acct2 = seedAccount(db, "Account B");
    const secId = seedSecurity(db, "VTI", { security_type: "etf" });

    classifySecurities(db);

    seedHolding(db, acct1, secId, 100, 20000);
    seedHolding(db, acct2, secId, 50, 10000);
    seedPrice(db, secId, 250);

    const allAlloc = getAllocationByDimension(db, "fund_category");
    const acct1Alloc = getAllocationByDimension(db, "fund_category", [acct1]);

    // Account-filtered should have less total value
    const allTotal = allAlloc.reduce((s, a) => s + a.total_market_value, 0);
    const acct1Total = acct1Alloc.reduce((s, a) => s + a.total_market_value, 0);
    expect(acct1Total).toBeLessThan(allTotal);
    expect(acct1Total).toBe(25000); // 100 * 250
  });
});

// ─── Concentration tests ──────────────────────────────────────────

describe("getConcentrationMetrics", () => {
  it("computes HHI for equally weighted positions", () => {
    const acctId = seedAccount(db, "Test Account");

    // 4 equal positions → HHI = 4 * (0.25)^2 = 0.25
    const secs = ["AAAA", "BBBB", "CCCC", "DDDD"];
    for (const sym of secs) {
      const id = seedSecurity(db, sym);
      seedHolding(db, acctId, id, 100, 10000);
      seedPrice(db, id, 100);
    }

    const metrics = getConcentrationMetrics(db);
    expect(metrics.hhi).toBeCloseTo(0.25, 2);
    expect(metrics.effective_positions).toBeCloseTo(4, 0);
    expect(metrics.top_positions.length).toBe(4);
  });

  it("detects high concentration", () => {
    const acctId = seedAccount(db, "Test Account");

    // One position dominates (90% of portfolio)
    const bigId = seedSecurity(db, "BIG");
    seedHolding(db, acctId, bigId, 900, 90000);
    seedPrice(db, bigId, 100);

    const smallId = seedSecurity(db, "SMALL");
    seedHolding(db, acctId, smallId, 100, 10000);
    seedPrice(db, smallId, 100);

    const metrics = getConcentrationMetrics(db);
    expect(metrics.hhi).toBeGreaterThan(0.25);
    expect(metrics.warnings.length).toBeGreaterThan(0);
    expect(metrics.warnings.some(w => w.includes("BIG"))).toBe(true);
  });

  it("handles empty portfolio", () => {
    const metrics = getConcentrationMetrics(db);
    expect(metrics.hhi).toBe(0);
    expect(metrics.effective_positions).toBe(0);
    expect(metrics.top_positions.length).toBe(0);
  });

  // qa: analysis-diagnostics--four-different-spy-weights-one-page-regression-2
  // A security held in two accounts must enter the HHI/warnings/top_positions
  // math as ONE whole position (combined market value), not as two partial
  // per-account rows under the bare ticker.
  it("aggregates a security held across two accounts into one whole position", () => {
    const acctA = seedAccount(db, "Account A");
    const acctB = seedAccount(db, "Account B");

    // DUAL: 100 sh in acctA + 25 sh in acctB @ $40 = $4,000 + $1,000 = $5,000 combined.
    const dualId = seedSecurity(db, "DUAL");
    seedHolding(db, acctA, dualId, 100, 4000);
    seedHolding(db, acctB, dualId, 25, 1000);
    seedPrice(db, dualId, 40);

    // OTHER: single account, 50 sh @ $40 = $2,000.
    const otherId = seedSecurity(db, "OTHER");
    seedHolding(db, acctA, otherId, 50, 2000);
    seedPrice(db, otherId, 40);

    const metrics = getConcentrationMetrics(db);

    // The shared symbol appears exactly once, valued at the combined MV.
    const dualPositions = metrics.top_positions.filter((p) => p.symbol === "DUAL");
    expect(dualPositions.length).toBe(1);
    expect(dualPositions[0].market_value).toBe(5000);
    // weight_pct on the combined value: 5000 / 7000 = 71.4286%.
    expect(dualPositions[0].weight_pct).toBeCloseTo((5000 / 7000) * 100, 4);

    // Exactly one >5% warning naming DUAL (not one per account slice).
    const dualWarnings = metrics.warnings.filter((w) => w.includes("DUAL"));
    expect(dualWarnings.length).toBe(1);

    // HHI must match the value produced when the SAME combined quantity
    // sits in a single account (i.e., position-level, not partial-slice).
    const singleAccountDb = new Database(":memory:");
    singleAccountDb.pragma("journal_mode = WAL");
    singleAccountDb.pragma("foreign_keys = ON");
    runMigrations(singleAccountDb);
    const acctC = seedAccount(singleAccountDb, "Account C");
    const dualIdC = seedSecurity(singleAccountDb, "DUAL");
    seedHolding(singleAccountDb, acctC, dualIdC, 125, 5000);
    seedPrice(singleAccountDb, dualIdC, 40);
    const otherIdC = seedSecurity(singleAccountDb, "OTHER");
    seedHolding(singleAccountDb, acctC, otherIdC, 50, 2000);
    seedPrice(singleAccountDb, otherIdC, 40);

    const singleAccountMetrics = getConcentrationMetrics(singleAccountDb);
    expect(metrics.hhi).toBeCloseTo(singleAccountMetrics.hhi, 4);
    singleAccountDb.close();
  });

  it("accountIds filter still scopes to that account's slice before aggregation", () => {
    const acctA = seedAccount(db, "Account A");
    const acctB = seedAccount(db, "Account B");

    const dualId = seedSecurity(db, "DUAL");
    seedHolding(db, acctA, dualId, 100, 4000);
    seedHolding(db, acctB, dualId, 25, 1000);
    seedPrice(db, dualId, 40);

    const otherId = seedSecurity(db, "OTHER");
    seedHolding(db, acctA, otherId, 50, 2000);
    seedPrice(db, otherId, 40);

    const metrics = getConcentrationMetrics(db, [acctA]);

    // Only acctA's slice of DUAL ($4,000), not the cross-account combined value.
    const dualPosition = metrics.top_positions.find((p) => p.symbol === "DUAL");
    expect(dualPosition).toBeTruthy();
    expect(dualPosition!.market_value).toBe(4000);

    const otherPosition = metrics.top_positions.find((p) => p.symbol === "OTHER");
    expect(otherPosition).toBeTruthy();
    expect(otherPosition!.market_value).toBe(2000);

    // acctA-only total is 6000, not the 7000 full-universe total.
    const total = metrics.top_positions.reduce((sum, p) => sum + p.market_value, 0);
    expect(total).toBe(6000);
  });
});

// ─── Coverage tests ──────────────────────────────────────────────

describe("getClassificationCoverage", () => {
  it("reports coverage correctly (scoped to active holdings)", () => {
    const acctId = seedAccount(db, "Test Account");
    const vtiId = seedSecurity(db, "VTI", { security_type: "etf" });
    const unkId = seedSecurity(db, "UNKNOWN_STOCK");
    const bondId = seedSecurity(db, "912797NL7", { security_type: "bond" });

    // Add holdings so they appear in the scoped query
    seedHolding(db, acctId, vtiId, 100, 10000);
    seedHolding(db, acctId, unkId, 50, 5000);
    seedHolding(db, acctId, bondId, 10000, 9800);

    // Before classification
    const before = getClassificationCoverage(db);
    expect(before.classified).toBe(0);
    expect(before.unclassified).toBe(3);

    // After classification
    classifySecurities(db);

    const after = getClassificationCoverage(db);
    expect(after.classified).toBe(2); // VTI + bond
    expect(after.unclassified).toBe(1); // UNKNOWN_STOCK
    expect(after.coverage_pct).toBeCloseTo(66.7, 0);
    expect(after.unclassified_securities.length).toBe(1);
    expect(after.unclassified_securities[0].symbol).toBe("UNKNOWN_STOCK");
  });

  it("tracks classification sources", () => {
    const acctId = seedAccount(db, "Test Account");
    const vtiId = seedSecurity(db, "VTI", { security_type: "etf" });
    const bondId = seedSecurity(db, "912797NL7", { security_type: "bond" });

    seedHolding(db, acctId, vtiId, 100, 10000);
    seedHolding(db, acctId, bondId, 10000, 9800);

    classifySecurities(db);

    const coverage = getClassificationCoverage(db);
    const sources = coverage.by_source.map(s => s.source);
    expect(sources).toContain("static_lookup");
    expect(sources).toContain("auto");
  });

  it("filters by account scope", () => {
    const acctA = seedAccount(db, "Vanguard Taxable");
    const acctB = seedAccount(db, "IBKR");
    const vtiId = seedSecurity(db, "VTI", { security_type: "etf" });
    const spyId = seedSecurity(db, "SPY", { security_type: "etf" });

    seedHolding(db, acctA, vtiId, 100, 10000);
    seedHolding(db, acctB, spyId, 50, 5000);

    // Scoped to Vanguard only
    const vanguardCoverage = getClassificationCoverage(db, [acctA]);
    expect(vanguardCoverage.total).toBe(1); // only VTI

    // Scoped to all
    const allCoverage = getClassificationCoverage(db);
    expect(allCoverage.total).toBe(2); // VTI + SPY
  });

  it("counts a statement-only security whose as_of_date lags a newer holding in the same account", () => {
    const acctId = seedAccount(db, "Test Account");
    const staleId = seedSecurity(db, "STALE_BOND", { security_type: "bond" });
    const freshId = seedSecurity(db, "VTI", { security_type: "etf" });

    // STALE_BOND only restates on the monthly statement; VTI has a newer
    // daily-sync row in the same account. A per-account MAX(as_of_date)
    // would drop STALE_BOND entirely — per-(account, security) latest must
    // keep it.
    seedHolding(db, acctId, staleId, 10000, 9800, "2025-01-31");
    seedHolding(db, acctId, freshId, 100, 10000, "2025-02-28");

    classifySecurities(db);

    const coverage = getClassificationCoverage(db);
    expect(coverage.total).toBe(2);
    expect(coverage.classified).toBe(2);
  });

  it("counts a short-position security in coverage", () => {
    const acctId = seedAccount(db, "Test Account");
    const shortId = seedSecurity(db, "SHORTED_STOCK");

    seedHolding(db, acctId, shortId, -50, -5000);

    const coverage = getClassificationCoverage(db);
    expect(coverage.total).toBe(1);
    expect(coverage.unclassified_securities[0].symbol).toBe("SHORTED_STOCK");
  });
});
