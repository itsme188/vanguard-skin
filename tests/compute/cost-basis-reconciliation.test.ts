import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { reconcileCostBasis } from "@/lib/compute/cost-basis-reconciliation";
import { computeTaxLots } from "@/lib/compute/tax-lots";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  // Use IBKR account (seeded as id=3 by migration 002)
  db.prepare(
    "INSERT INTO securities (id, symbol, name, security_type) VALUES (1, 'AAPL', 'Apple Inc', 'stock')"
  ).run();
  db.prepare(
    "INSERT INTO securities (id, symbol, name, security_type) VALUES (2, 'MSFT', 'Microsoft', 'stock')"
  ).run();

  // Create import batch for holdings FK
  db.prepare(
    "INSERT INTO import_batches (id, filename, source_type, record_count, status) VALUES (1, 'test', 'test', 0, 'completed')"
  ).run();
});

function insertTransaction(secId: number, type: string, date: string, qty: number, price: number) {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, type, trade_date, quantity, price_per_share, amount, fees)
     VALUES (3, ?, ?, ?, ?, ?, ?, 0)`
  ).run(secId, type, date, qty, price, qty * price);
}

function insertHolding(secId: number, qty: number, costBasis: number | null, asOf: string) {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key, import_batch_id)
     VALUES (3, ?, ?, ?, ?, ?, 1)`
  ).run(secId, qty, costBasis, asOf, `test-${secId}-${asOf}`);
}

describe("reconcileCostBasis", () => {
  it("matches when broker and computed cost basis agree", () => {
    // Buy 100 AAPL at $150 = $15,000
    insertTransaction(1, "BUY", "2025-06-01", 100, 150);
    computeTaxLots(db);

    // Holdings with matching broker cost basis
    insertHolding(1, 100, 15000, "2026-03-27");

    const result = reconcileCostBasis(db);
    expect(result.totalPositions).toBe(1);
    expect(result.positionsWithBrokerBasis).toBe(1);
    expect(result.positionsFlagged).toBe(0);
    expect(result.positionsMatching).toBe(1);
  });

  it("flags when broker and computed cost basis differ", () => {
    insertTransaction(1, "BUY", "2025-06-01", 100, 150);
    computeTaxLots(db);

    // Holdings with different broker cost basis ($16,000 vs computed $15,000)
    insertHolding(1, 100, 16000, "2026-03-27");

    const result = reconcileCostBasis(db);
    expect(result.positionsFlagged).toBe(1);
    expect(result.rows[0].costBasisDiff).toBeCloseTo(1000, 0);
    expect(result.rows[0].flagReason).toContain("variance");
  });

  it("flags when broker cost basis is missing", () => {
    insertTransaction(1, "BUY", "2025-06-01", 100, 150);
    computeTaxLots(db);

    // Holdings with null cost basis
    insertHolding(1, 100, null, "2026-03-27");

    const result = reconcileCostBasis(db);
    expect(result.positionsFlagged).toBe(1);
    expect(result.positionsWithoutBrokerBasis).toBe(1);
    expect(result.rows[0].flagReason).toContain("No broker cost basis");
  });

  it("flags quantity mismatches", () => {
    insertTransaction(1, "BUY", "2025-06-01", 100, 150);
    computeTaxLots(db);

    // Holdings say 110 shares but tax lots say 100
    insertHolding(1, 110, 16500, "2026-03-27");

    const result = reconcileCostBasis(db);
    expect(result.positionsFlagged).toBe(1);
    expect(result.rows[0].flagReason).toContain("Quantity mismatch");
  });

  it("handles multiple positions across securities", () => {
    insertTransaction(1, "BUY", "2025-06-01", 100, 150);
    insertTransaction(2, "BUY", "2025-06-01", 50, 400);
    computeTaxLots(db);

    insertHolding(1, 100, 15000, "2026-03-27"); // matches
    insertHolding(2, 50, 20000, "2026-03-27");  // matches

    const result = reconcileCostBasis(db);
    expect(result.totalPositions).toBe(2);
    expect(result.positionsMatching).toBe(2);
    expect(result.positionsFlagged).toBe(0);
  });

  it("ignores small differences within threshold", () => {
    insertTransaction(1, "BUY", "2025-06-01", 100, 150);
    computeTaxLots(db);

    // $50 difference — under the default $100 threshold
    insertHolding(1, 100, 15050, "2026-03-27");

    const result = reconcileCostBasis(db);
    expect(result.positionsFlagged).toBe(0);
  });

  it("returns correct summary totals", () => {
    insertTransaction(1, "BUY", "2025-06-01", 100, 150);
    insertTransaction(2, "BUY", "2025-06-01", 50, 400);
    computeTaxLots(db);

    insertHolding(1, 100, 15000, "2026-03-27");
    insertHolding(2, 50, 20500, "2026-03-27");

    const result = reconcileCostBasis(db);
    expect(result.totalBrokerCostBasis).toBe(35500);
    expect(result.totalComputedCostBasis).toBe(35000);
    expect(result.totalDifference).toBe(500);
  });
});
