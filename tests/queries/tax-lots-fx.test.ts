import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { getOpenTaxLots, getTaxLotSummary } from "@/lib/queries/tax-lots";

// ─── Seed helpers (mirrors tests/queries/security-detail-fx.test.ts) ──────

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

describe("tax-lots FX conversion", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1; // seeded by migration 002
  const TODAY = "2026-07-01";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  describe("getOpenTaxLots", () => {
    it("converts a KRW lot's market value + adjusted cost basis + unrealized gain to USD, not the won phantom", () => {
      const krw = seedSecurity(db, "402340", { currency: "KRW" });
      seedTaxLot(db, ACCOUNT_ID, krw, "2025-01-01", 1_632_979.2, 10, 16_329_792);
      seedPrice(db, krw, 1_731_000, TODAY);

      upsertFxRate(db, {
        currency: "KRW",
        usdPerUnit: 0.000734,
        asOf: TODAY,
        source: "test",
      });

      const lots = getOpenTaxLots(db);
      const krwLot = lots.find((l) => l.symbol === "402340");
      expect(krwLot).toBeTruthy();

      const expectedMv = 10 * 1_731_000 * 0.000734; // 12,705.54
      const expectedCostUsd = 10 * 1_632_979.2 * 0.000734; // 11,986.07

      expect(krwLot!.current_value).toBeCloseTo(expectedMv, 2);
      expect(krwLot!.current_value).toBeLessThan(20_000);
      expect(krwLot!.current_value).not.toBeCloseTo(17_310_000, 0);

      expect(krwLot!.adjusted_cost_basis).toBeCloseTo(expectedCostUsd, 2);
      expect(krwLot!.adjusted_cost_basis).not.toBeCloseTo(16_329_792, 0);

      expect(krwLot!.unrealized_gain).toBeCloseTo(expectedMv - expectedCostUsd, 2);
      expect(krwLot!.unrealized_gain).toBeCloseTo(719.47, 1);
    });

    it("USD control is unaffected (byte-unchanged behavior)", () => {
      const aapl = seedSecurity(db, "AAPL", { currency: "USD" });
      seedTaxLot(db, ACCOUNT_ID, aapl, "2025-01-01", 200, 100, 20_000);
      seedPrice(db, aapl, 250, TODAY);

      const lots = getOpenTaxLots(db);
      const usdLot = lots.find((l) => l.symbol === "AAPL");
      expect(usdLot).toBeTruthy();
      expect(usdLot!.current_value).toBe(25_000);
      expect(usdLot!.adjusted_cost_basis).toBe(20_000);
      expect(usdLot!.unrealized_gain).toBe(5_000);
    });
  });

  describe("getTaxLotSummary", () => {
    it("aggregates a KRW lot's unrealized gain in USD, not the won phantom", () => {
      const aapl = seedSecurity(db, "AAPL", { currency: "USD" });
      seedTaxLot(db, ACCOUNT_ID, aapl, "2025-01-01", 200, 100, 20_000);
      seedPrice(db, aapl, 250, TODAY); // USD gain: (100*250) - 20000 = 5,000

      const krw = seedSecurity(db, "402340", { currency: "KRW" });
      seedTaxLot(db, ACCOUNT_ID, krw, "2025-01-01", 1_632_979.2, 10, 16_329_792);
      seedPrice(db, krw, 1_731_000, TODAY);

      upsertFxRate(db, {
        currency: "KRW",
        usdPerUnit: 0.000734,
        asOf: TODAY,
        source: "test",
      });

      const summary = getTaxLotSummary(db);
      expect(summary.totalOpenLots).toBe(2);

      const usdGain = 100 * 250 - 20_000; // 5,000
      const krwGainUsd =
        10 * 1_731_000 * 0.000734 - 10 * 1_632_979.2 * 0.000734; // ~719.47
      const expectedTotal = usdGain + krwGainUsd;

      expect(summary.totalUnrealizedGain).toBeCloseTo(expectedTotal, 2);
      // Must NOT be dominated by the won-notional phantom gain
      // (would be ~17,290,000 if KRW were treated as raw USD).
      expect(summary.totalUnrealizedGain).toBeLessThan(10_000);
    });
  });
});
