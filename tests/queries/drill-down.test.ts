import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getHoldingsInBucket } from "@/lib/queries/drill-down";

// Migration 002 seeds: 1=Vanguard Taxable, 2=Vanguard Roth IRA, 3=IBKR.

function seedBasicPortfolio(db: Database.Database) {
  // Securities — span 2 sectors + 2 factor levels + a non-factor row.
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector) VALUES (1, 'AAPL', 'Apple Inc.', 'Stock', 'Technology')`
  ).run();
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector) VALUES (2, 'MSFT', 'Microsoft Corp.', 'Stock', 'Technology')`
  ).run();
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector) VALUES (3, 'JNJ', 'Johnson & Johnson', 'Stock', 'Healthcare')`
  ).run();
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, sector) VALUES (4, 'XOM', 'Exxon Mobil', 'Stock', 'Energy')`
  ).run();

  // Factor classifications — AAPL/MSFT High AI, JNJ no AI, XOM Low AI.
  db.prepare(
    `INSERT INTO security_factors (security_id, growth_vs_value, ai_exposure) VALUES (1, 'Growth', 'High')`
  ).run();
  db.prepare(
    `INSERT INTO security_factors (security_id, growth_vs_value, ai_exposure) VALUES (2, 'Growth', 'High')`
  ).run();
  db.prepare(
    `INSERT INTO security_factors (security_id, growth_vs_value, ai_exposure) VALUES (3, 'Value', 'No')`
  ).run();
  db.prepare(
    `INSERT INTO security_factors (security_id, growth_vs_value, ai_exposure) VALUES (4, 'Value', 'Low')`
  ).run();

  // Cached betas — at the writer's lookback (BETA_LOOKBACK_DAYS = 60)
  db.prepare(
    `INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (1, 60, 1.2, '2026-05-10')`
  ).run();
  db.prepare(
    `INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (2, 60, 1.1, '2026-05-10')`
  ).run();
  db.prepare(
    `INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (3, 60, 0.6, '2026-05-10')`
  ).run();
  // XOM intentionally has no cached beta — verifies the LEFT JOIN returns null.

  // Latest prices (one per security)
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (1, ?, 200, 'tws')`).run(today);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (2, ?, 400, 'tws')`).run(today);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (3, ?, 150, 'tws')`).run(today);
  db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (4, ?, 100, 'tws')`).run(today);

  // Holdings:
  //   acct 1 (Vanguard Taxable): AAPL 10 shares ($2000), JNJ 20 shares ($3000)
  //   acct 2 (Vanguard Roth):    XOM  50 shares ($5000)
  //   acct 3 (IBKR):             MSFT  5 shares ($2000)
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 1, '2026-04-30', 10, 'vg-aapl')`
  ).run();
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, 3, '2026-04-30', 20, 'vg-jnj')`
  ).run();
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (2, 4, '2026-04-30', 50, 'vg-xom')`
  ).run();
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, 2, ?, 5, 'tws-msft')`
  ).run(today);
}

describe("getHoldingsInBucket", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedBasicPortfolio(db);
  });

  it("classification + sector='Technology' returns only Tech-sector securities", () => {
    const rows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "sector",
      bucket: "Technology",
    });
    const symbols = rows.map((r) => r.symbol).sort();
    expect(symbols).toEqual(["AAPL", "MSFT"]);
    // Sorted by market_value DESC: MSFT ($2000), AAPL ($2000) — either order fine,
    // but both should land in the result.
    expect(rows.every((r) => r.sector === "Technology")).toBe(true);
    // Weight is fraction of SCOPE total ($12k), so AAPL 2000/12000 ≈ 0.1667.
    const aapl = rows.find((r) => r.symbol === "AAPL")!;
    expect(aapl.weight).toBeCloseTo(2000 / 12000, 4);
    // Beta from security_betas cache.
    expect(aapl.beta).toBe(1.2);
    // Factors include the populated columns.
    expect(aapl.factors.ai_exposure).toBe("High");
    expect(aapl.factors.growth_vs_value).toBe("Growth");
  });

  it("factor + factor=ai_exposure + bucket='High' returns only AI=High securities", () => {
    const rows = getHoldingsInBucket(db, "all", {
      kind: "factor",
      factor: "ai_exposure",
      bucket: "High",
    });
    const symbols = rows.map((r) => r.symbol).sort();
    expect(symbols).toEqual(["AAPL", "MSFT"]);
    // JNJ (No) and XOM (Low) excluded.
  });

  it("sector kind (alias for classification.sector)", () => {
    const rows = getHoldingsInBucket(db, "all", {
      kind: "sector",
      sector: "Healthcare",
    });
    expect(rows.map((r) => r.symbol)).toEqual(["JNJ"]);
    expect(rows[0].sector).toBe("Healthcare");
    // JNJ is $3000 of $12k scope total.
    expect(rows[0].weight).toBeCloseTo(3000 / 12000, 4);
  });

  it("risk kind with topN=5 returns at most 5 rows, sorted by risk proxy DESC", () => {
    const rows = getHoldingsInBucket(db, "all", { kind: "risk", topN: 5 });
    expect(rows.length).toBeLessThanOrEqual(5);
    expect(rows.length).toBe(4); // only 4 holdings in seed
    // Risk proxy = marketValue * COALESCE(beta, 1).
    // AAPL  2000 * 1.2 = 2400
    // MSFT  2000 * 1.1 = 2200
    // JNJ   3000 * 0.6 = 1800
    // XOM   5000 * 1.0 = 5000  ← no cached beta, default 1
    // DESC order: XOM, AAPL, MSFT, JNJ
    expect(rows[0].symbol).toBe("XOM");
    expect(rows[1].symbol).toBe("AAPL");
    expect(rows[2].symbol).toBe("MSFT");
    expect(rows[3].symbol).toBe("JNJ");
    // XOM has no cached beta — null surfaces.
    expect(rows[0].beta).toBeNull();
  });

  it("accountIds filter limits results to that account", () => {
    // IBKR scope (account 3) holds only MSFT.
    const rows = getHoldingsInBucket(
      db,
      "ibkr",
      { kind: "classification", dimension: "sector", bucket: "Technology" },
      [3]
    );
    expect(rows.map((r) => r.symbol)).toEqual(["MSFT"]);
    // MSFT weight relative to IBKR-scope total ($2000) is 1.0.
    expect(rows[0].weight).toBeCloseTo(1.0, 4);
  });

  it("unknown bucket returns empty array (no crash)", () => {
    const rows = getHoldingsInBucket(db, "all", {
      kind: "classification",
      dimension: "sector",
      bucket: "NonexistentSector",
    });
    expect(rows).toEqual([]);
  });
});

// Regression: the beta join must use the same lookback the refresh script
// writes (60 days) — with only 60-day rows in the table (production shape)
// a 252-day join renders every Beta cell null.
// [qa:analysis-whatif--portfolio-beta-always-one-lookback-mismatch]
describe("beta lookback matches the production beta writer", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seedBasicPortfolio(db);
    db.prepare(`DELETE FROM security_betas`).run();
    db.prepare(`INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (1, 60, 1.2, '2026-08-01')`).run();
  });

  it("risk drawer rows surface betas cached at the writer's lookback", () => {
    const rows = getHoldingsInBucket(db, "all", { kind: "risk", topN: 5 });
    const aapl = rows.find((r) => r.symbol === "AAPL");
    expect(aapl).toBeDefined();
    expect(aapl!.beta).toBe(1.2);
  });
});
