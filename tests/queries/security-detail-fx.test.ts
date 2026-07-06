import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import {
  getHoldingsBySecurity,
  getOpenTaxLotsBySecurity,
  getSecurityDetail,
} from "@/lib/queries/security-detail";

// ─── Seed helpers (mirrors tests/queries/portfolio-summary-fx.test.ts) ────

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts: {
    name?: string;
    security_type?: string;
    multiplier?: number;
    currency?: string;
  } = {}
): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, multiplier, currency) VALUES (?, ?, ?, ?, ?)"
    )
    .run(
      symbol,
      opts.name ?? `${symbol} Corp`,
      opts.security_type ?? "stock",
      opts.multiplier ?? 1,
      opts.currency ?? "USD"
    );
  return result.lastInsertRowid as number;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  costBasis: number,
  asOfDate: string
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    accountId,
    securityId,
    quantity,
    costBasis,
    asOfDate,
    `hold-${accountId}-${securityId}-${asOfDate}`
  );
}

function seedPrice(
  db: Database.Database,
  securityId: number,
  price: number,
  date: string
): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, close_price, date, source) VALUES (?, ?, ?, 'test')"
  ).run(securityId, price, date);
}

function seedTaxLot(
  db: Database.Database,
  accountId: number,
  securityId: number,
  acquisitionDate: string,
  acquisitionPrice: number,
  quantityRemaining: number,
  costBasis: number
): void {
  db.prepare(
    `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    accountId,
    securityId,
    acquisitionDate,
    acquisitionPrice,
    quantityRemaining,
    quantityRemaining,
    costBasis
  );
}

describe("security-detail FX conversion", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1; // seeded by migration 002
  const TODAY = "2026-07-01";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  describe("getHoldingsBySecurity", () => {
    it("converts KRW market value + unrealized gain to USD, not the won phantom", () => {
      // 10 sh @ ₩1,731,000 = ₩17,310,000 notional; cost basis ₩16,329,792.
      // Pre-fix this renders as a $17,310,000 market value (phantom).
      const krw = seedSecurity(db, "402340", { currency: "KRW" });
      seedHolding(db, ACCOUNT_ID, krw, 10, 16_329_792, TODAY);
      seedPrice(db, krw, 1_731_000, TODAY);

      upsertFxRate(db, {
        currency: "KRW",
        usdPerUnit: 0.000734,
        asOf: TODAY,
        source: "test",
      });

      const positions = getHoldingsBySecurity(db, krw);
      expect(positions).toHaveLength(1);

      const expectedMv = 10 * 1_731_000 * 0.000734; // 12,705.54
      const expectedCostUsd = 16_329_792 * 0.000734; // 11,986.07

      expect(positions[0].current_value).toBeCloseTo(expectedMv, 5);
      expect(positions[0].current_value).toBeLessThan(20_000);
      // Must NOT be the won-notional phantom.
      expect(positions[0].current_value).not.toBeCloseTo(17_310_000, 0);

      expect(positions[0].unrealized_gain).toBeCloseTo(
        expectedMv - expectedCostUsd,
        5
      );
      expect(positions[0].unrealized_gain).toBeCloseTo(719.47, 1);

      // Task 5d: the RAW returned cost_basis field must also be USD, not the
      // won notional (₩16,329,792).
      expect(positions[0].cost_basis).toBeCloseTo(expectedCostUsd, 5);
      expect(positions[0].cost_basis).not.toBeCloseTo(16_329_792, 0);
      expect(positions[0].cost_basis).toBeLessThan(20_000);
    });

    it("USD control is unaffected (byte-unchanged behavior)", () => {
      const aapl = seedSecurity(db, "AAPL", { currency: "USD" });
      seedHolding(db, ACCOUNT_ID, aapl, 100, 20_000, TODAY);
      seedPrice(db, aapl, 250, TODAY);

      const positions = getHoldingsBySecurity(db, aapl);
      expect(positions).toHaveLength(1);
      expect(positions[0].current_value).toBe(25_000);
      expect(positions[0].unrealized_gain).toBe(5_000);
      expect(positions[0].cost_basis).toBe(20_000);
    });
  });

  describe("getOpenTaxLotsBySecurity", () => {
    it("converts KRW adjusted cost basis + market value + unrealized gain to USD, not the won phantom", () => {
      const krw = seedSecurity(db, "402340", { currency: "KRW" });
      // acquisition_price ₩1,632,979.2/unit * 10 units => cost_basis ₩16,329,792
      seedTaxLot(db, ACCOUNT_ID, krw, "2025-01-01", 1_632_979.2, 10, 16_329_792);
      seedPrice(db, krw, 1_731_000, TODAY);

      upsertFxRate(db, {
        currency: "KRW",
        usdPerUnit: 0.000734,
        asOf: TODAY,
        source: "test",
      });

      const lots = getOpenTaxLotsBySecurity(db, krw);
      expect(lots).toHaveLength(1);

      const expectedMv = 10 * 1_731_000 * 0.000734; // 12,705.54
      const expectedCostUsd = 10 * 1_632_979.2 * 0.000734; // 11,986.07

      expect(lots[0].current_value).toBeCloseTo(expectedMv, 2);
      expect(lots[0].current_value).toBeLessThan(20_000);
      expect(lots[0].current_value).not.toBeCloseTo(17_310_000, 0);

      expect(lots[0].adjusted_cost_basis).toBeCloseTo(expectedCostUsd, 2);
      expect(lots[0].adjusted_cost_basis).not.toBeCloseTo(16_329_792, 0);

      expect(lots[0].unrealized_gain).toBeCloseTo(expectedMv - expectedCostUsd, 2);
      expect(lots[0].unrealized_gain).toBeCloseTo(719.47, 1);

      // Task 5d: the RAW returned cost_basis field must also be USD, not the
      // won notional (₩16,329,792).
      expect(lots[0].cost_basis).toBeCloseTo(expectedCostUsd, 2);
      expect(lots[0].cost_basis).not.toBeCloseTo(16_329_792, 0);
    });

    it("USD control is unaffected (byte-unchanged behavior)", () => {
      const aapl = seedSecurity(db, "AAPL", { currency: "USD" });
      seedTaxLot(db, ACCOUNT_ID, aapl, "2025-01-01", 200, 100, 20_000);
      seedPrice(db, aapl, 250, TODAY);

      const lots = getOpenTaxLotsBySecurity(db, aapl);
      expect(lots).toHaveLength(1);
      expect(lots[0].current_value).toBe(25_000);
      expect(lots[0].adjusted_cost_basis).toBe(20_000);
      expect(lots[0].unrealized_gain).toBe(5_000);
      expect(lots[0].cost_basis).toBe(20_000);
    });
  });
});

describe("getSecurityDetail usdPerUnit", () => {
  let db: Database.Database;
  const TODAY = "2026-07-03";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("exposes the KRW fx factor; hero price stays NATIVE for chart/ratio consumers", () => {
    const krw = seedSecurity(db, "402340", { currency: "KRW" });
    seedPrice(db, krw, 1_602_000, TODAY);
    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.0006531, asOf: TODAY, source: "test" });

    const detail = getSecurityDetail(db, krw);
    expect(detail).toBeTruthy();
    // Display sites multiply by this; the chart price-line + ATR ratio keep native.
    expect(detail!.usdPerUnit).toBeCloseTo(0.0006531, 9);
    expect(detail!.price?.close_price).toBe(1_602_000);
  });

  it("USD security exposes 1 (byte-identical rendering)", () => {
    const aapl = seedSecurity(db, "AAPL", { currency: "USD" });
    seedPrice(db, aapl, 208, TODAY);
    const detail = getSecurityDetail(db, aapl);
    expect(detail!.usdPerUnit).toBe(1);
  });

  it("missing fx row falls back to 1 (native passthrough, never fabricated)", () => {
    const krw = seedSecurity(db, "402340", { currency: "KRW" });
    seedPrice(db, krw, 1_602_000, TODAY);
    const detail = getSecurityDetail(db, krw);
    expect(detail!.usdPerUnit).toBe(1);
  });
});
