import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getAllocationByDimension,
  getFactorHeatmap,
  getFactorCoverage,
} from "@/lib/queries/analysis";

let db: Database.Database;

// ─── Seed helpers ─────────────────────────────────────────────────

function seedAccount(db: Database.Database, name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts: {
    name?: string;
    security_type?: string;
    underlying_symbol?: string;
    multiplier?: number;
  } = {}
): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, underlying_symbol, multiplier) VALUES (?, ?, ?, ?, ?)"
    )
    .run(
      symbol,
      opts.name ?? `${symbol} Corp`,
      opts.security_type ?? "stock",
      opts.underlying_symbol ?? null,
      opts.multiplier ?? 1
    );
  return result.lastInsertRowid as number;
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

function seedFactors(
  db: Database.Database,
  securityId: number,
  factors: Record<string, string | null>,
  source: string = "csv_import"
) {
  db.prepare(
    `INSERT INTO security_factors
      (security_id, interest_rate_sensitive, growth_vs_value, cyclical,
       international_exposure, geopolitical_onshoring, tariff_exposure,
       ai_exposure, crypto_adjacent, regulatory_risk, factor_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    securityId,
    factors.interest_rate_sensitive ?? null,
    factors.growth_vs_value ?? null,
    factors.cyclical ?? null,
    factors.international_exposure ?? null,
    factors.geopolitical_onshoring ?? null,
    factors.tariff_exposure ?? null,
    factors.ai_exposure ?? null,
    factors.crypto_adjacent ?? null,
    factors.regulatory_risk ?? null,
    source
  );
}

// ─── Setup ────────────────────────────────────────────────────────

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

// ─── Allocation by factor dimension ──────────────────────────────

describe("getAllocationByDimension — factor dimensions", () => {
  it("groups by tariff_exposure", () => {
    const acctId = seedAccount(db, "Test");
    const aaplId = seedSecurity(db, "AAPL");
    const msftId = seedSecurity(db, "MSFT");
    const unknownId = seedSecurity(db, "UNKNOWN");

    seedHolding(db, acctId, aaplId, 100, 15000);
    seedPrice(db, aaplId, 200);
    seedHolding(db, acctId, msftId, 50, 10000);
    seedPrice(db, msftId, 400);
    seedHolding(db, acctId, unknownId, 10, 500);
    seedPrice(db, unknownId, 50);

    seedFactors(db, aaplId, { tariff_exposure: "Moderate", ai_exposure: "High" });
    seedFactors(db, msftId, { tariff_exposure: "Low", ai_exposure: "Very High" });
    // unknownId has no factors → "Unknown"

    const alloc = getAllocationByDimension(db, "tariff_exposure");

    expect(alloc.length).toBe(3); // Moderate, Low, Unknown

    const moderate = alloc.find((a) => a.group_name === "Moderate");
    expect(moderate).toBeTruthy();
    expect(moderate!.total_market_value).toBe(20000); // 100 * 200

    const low = alloc.find((a) => a.group_name === "Low");
    expect(low).toBeTruthy();
    expect(low!.total_market_value).toBe(20000); // 50 * 400

    const unknown = alloc.find((a) => a.group_name === "Unknown");
    expect(unknown).toBeTruthy();
    expect(unknown!.total_market_value).toBe(500); // 10 * 50

    // Percentages sum to ~100
    const totalPct = alloc.reduce((s, a) => s + (a.percentage ?? 0), 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });

  it("groups by ai_exposure", () => {
    const acctId = seedAccount(db, "Test");
    const aaplId = seedSecurity(db, "AAPL");
    const msftId = seedSecurity(db, "MSFT");

    seedHolding(db, acctId, aaplId, 100, 15000);
    seedPrice(db, aaplId, 200);
    seedHolding(db, acctId, msftId, 50, 10000);
    seedPrice(db, msftId, 400);

    seedFactors(db, aaplId, { ai_exposure: "High" });
    seedFactors(db, msftId, { ai_exposure: "Very High" });

    const alloc = getAllocationByDimension(db, "ai_exposure");
    expect(alloc.length).toBe(2);

    const high = alloc.find((a) => a.group_name === "High");
    expect(high).toBeTruthy();

    const veryHigh = alloc.find((a) => a.group_name === "Very High");
    expect(veryHigh).toBeTruthy();
  });

  it("option inherits factors from underlying security", () => {
    const acctId = seedAccount(db, "Test");

    // Underlying stock
    const aaplId = seedSecurity(db, "AAPL");
    seedFactors(db, aaplId, {
      tariff_exposure: "Moderate",
      ai_exposure: "High",
    });

    // Option with underlying_symbol = AAPL
    const optId = seedSecurity(db, "AAPL  260320C00200000", {
      security_type: "option",
      underlying_symbol: "AAPL",
      multiplier: 100,
    });

    seedHolding(db, acctId, aaplId, 100, 15000);
    seedPrice(db, aaplId, 200);
    seedHolding(db, acctId, optId, 5, 2500);
    seedPrice(db, optId, 10); // 5 * 10 * 100 = 5000

    const alloc = getAllocationByDimension(db, "tariff_exposure");

    // Both AAPL stock + AAPL option should be "Moderate"
    const moderate = alloc.find((a) => a.group_name === "Moderate");
    expect(moderate).toBeTruthy();
    expect(moderate!.position_count).toBe(2);
    // stock: 100*200 = 20000, option: 5*10*100 = 5000
    expect(moderate!.total_market_value).toBe(25000);
  });

  it("filters by account for factor dimensions", () => {
    const acct1 = seedAccount(db, "Account A");
    const acct2 = seedAccount(db, "Account B");

    const secId = seedSecurity(db, "AAPL");
    seedFactors(db, secId, { tariff_exposure: "High" });

    seedHolding(db, acct1, secId, 100, 10000);
    seedHolding(db, acct2, secId, 50, 5000);
    seedPrice(db, secId, 200);

    const allAccounts = getAllocationByDimension(db, "tariff_exposure");
    const acct1Only = getAllocationByDimension(db, "tariff_exposure", [acct1]);

    expect(allAccounts[0].total_market_value).toBe(30000); // 150 * 200
    expect(acct1Only[0].total_market_value).toBe(20000); // 100 * 200
  });
});

// ─── Factor heatmap ─────────────────────────────────────────────

describe("getFactorHeatmap", () => {
  it("returns all positions with factor values", () => {
    const acctId = seedAccount(db, "Test");
    const aaplId = seedSecurity(db, "AAPL");
    const msftId = seedSecurity(db, "MSFT");

    seedHolding(db, acctId, aaplId, 100, 15000);
    seedPrice(db, aaplId, 200);
    seedHolding(db, acctId, msftId, 50, 10000);
    seedPrice(db, msftId, 400);

    seedFactors(db, aaplId, {
      tariff_exposure: "Moderate",
      ai_exposure: "High",
      cyclical: "Moderate",
    });
    seedFactors(db, msftId, {
      tariff_exposure: "Low",
      ai_exposure: "Very High",
      cyclical: "Low",
    });

    const rows = getFactorHeatmap(db);

    expect(rows).toHaveLength(2);

    // Sorted by market value desc: MSFT (20000) then AAPL (20000) — both equal, either order
    const aapl = rows.find((r) => r.symbol === "AAPL")!;
    const msft = rows.find((r) => r.symbol === "MSFT")!;

    expect(aapl.market_value).toBe(20000);
    expect(aapl.tariff_exposure).toBe("Moderate");
    expect(aapl.ai_exposure).toBe("High");
    expect(aapl.is_option).toBe(false);

    expect(msft.market_value).toBe(20000);
    expect(msft.ai_exposure).toBe("Very High");
    expect(msft.is_option).toBe(false);

    // Weights should sum to 100
    const totalWeight = rows.reduce((s, r) => s + r.weight_pct, 0);
    expect(totalWeight).toBeCloseTo(100, 0);
  });

  it("option inherits factors from underlying", () => {
    const acctId = seedAccount(db, "Test");
    const aaplId = seedSecurity(db, "AAPL");
    const optId = seedSecurity(db, "AAPL  260320C00200000", {
      security_type: "option",
      underlying_symbol: "AAPL",
      multiplier: 100,
    });

    seedHolding(db, acctId, aaplId, 100, 15000);
    seedPrice(db, aaplId, 200);
    seedHolding(db, acctId, optId, 5, 2500);
    seedPrice(db, optId, 10);

    seedFactors(db, aaplId, {
      tariff_exposure: "Moderate",
      ai_exposure: "High",
    });
    // No factors on option itself

    const rows = getFactorHeatmap(db);
    const optRow = rows.find((r) => r.symbol === "AAPL  260320C00200000")!;

    expect(optRow).toBeTruthy();
    expect(optRow.is_option).toBe(true);
    expect(optRow.tariff_exposure).toBe("Moderate"); // inherited
    expect(optRow.ai_exposure).toBe("High"); // inherited
    expect(optRow.market_value).toBe(5000); // 5 * 10 * 100
  });

  it("positions without factors have null values", () => {
    const acctId = seedAccount(db, "Test");
    const secId = seedSecurity(db, "UNKNOWN");

    seedHolding(db, acctId, secId, 100, 5000);
    seedPrice(db, secId, 50);

    const rows = getFactorHeatmap(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].tariff_exposure).toBeNull();
    expect(rows[0].ai_exposure).toBeNull();
    expect(rows[0].factor_source).toBeNull();
  });

  it("filters by account", () => {
    const acct1 = seedAccount(db, "Account A");
    const acct2 = seedAccount(db, "Account B");
    const secId = seedSecurity(db, "AAPL");

    seedHolding(db, acct1, secId, 100, 10000);
    seedHolding(db, acct2, secId, 50, 5000);
    seedPrice(db, secId, 200);

    const all = getFactorHeatmap(db);
    const acct1Only = getFactorHeatmap(db, [acct1]);

    // Same symbol across accounts is aggregated into one row
    expect(all).toHaveLength(1);
    expect(all[0].market_value).toBe(30000); // 100×200 + 50×200
    expect(acct1Only).toHaveLength(1);
    expect(acct1Only[0].market_value).toBe(20000);
  });
});

// ─── Factor coverage ────────────────────────────────────────────

describe("getFactorCoverage", () => {
  it("counts holdings with and without factors", () => {
    const acctId = seedAccount(db, "Test");
    const aaplId = seedSecurity(db, "AAPL");
    const msftId = seedSecurity(db, "MSFT");
    const unknownId = seedSecurity(db, "UNKNOWN");

    seedHolding(db, acctId, aaplId, 100, 15000);
    seedHolding(db, acctId, msftId, 50, 10000);
    seedHolding(db, acctId, unknownId, 10, 500);

    // Add prices so they show up in latest_holdings
    seedPrice(db, aaplId, 200);
    seedPrice(db, msftId, 400);
    seedPrice(db, unknownId, 50);

    seedFactors(db, aaplId, { tariff_exposure: "Moderate" });
    seedFactors(db, msftId, { ai_exposure: "High" }, "auto");

    const coverage = getFactorCoverage(db);

    expect(coverage.totalHoldings).toBe(3);
    expect(coverage.withFactors).toBe(2);
    expect(coverage.coveragePct).toBeCloseTo(66.7, 0);
    expect(coverage.bySource).toHaveLength(2); // csv_import + auto
  });

  it("option inherits coverage from underlying", () => {
    const acctId = seedAccount(db, "Test");
    const aaplId = seedSecurity(db, "AAPL");
    const optId = seedSecurity(db, "AAPL  260320C00200000", {
      security_type: "option",
      underlying_symbol: "AAPL",
      multiplier: 100,
    });

    seedHolding(db, acctId, aaplId, 100, 15000);
    seedHolding(db, acctId, optId, 5, 2500);
    seedPrice(db, aaplId, 200);
    seedPrice(db, optId, 10);

    seedFactors(db, aaplId, { tariff_exposure: "Moderate" });
    // No factors on option itself — inherits via underlying

    const coverage = getFactorCoverage(db);
    expect(coverage.totalHoldings).toBe(2);
    expect(coverage.withFactors).toBe(2); // both covered
    expect(coverage.coveragePct).toBe(100);
  });

  it("returns 0% coverage when no factors exist", () => {
    const acctId = seedAccount(db, "Test");
    const secId = seedSecurity(db, "AAPL");
    seedHolding(db, acctId, secId, 100, 15000);
    seedPrice(db, secId, 200);

    const coverage = getFactorCoverage(db);
    expect(coverage.totalHoldings).toBe(1);
    expect(coverage.withFactors).toBe(0);
    expect(coverage.coveragePct).toBe(0);
  });

  it("handles empty portfolio", () => {
    const coverage = getFactorCoverage(db);
    expect(coverage.totalHoldings).toBe(0);
    expect(coverage.withFactors).toBe(0);
    expect(coverage.coveragePct).toBe(0);
  });
});
