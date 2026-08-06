import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import {
  getOpenTaxLots,
  getTaxLotSummary,
  getTaxLotSummaryByAccount,
  getClosedTaxLotSales,
} from "@/lib/queries/tax-lots";

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

    it("converts the raw cost_basis field to USD, not the won phantom", () => {
      const krw = seedSecurity(db, "402340", { currency: "KRW" });
      seedTaxLot(db, ACCOUNT_ID, krw, "2025-01-01", 1_632_979.2, 10, 16_329_792);
      seedPrice(db, krw, 1_731_000, TODAY);

      upsertFxRate(db, {
        currency: "KRW",
        usdPerUnit: 0.000734,
        asOf: TODAY,
        source: "test",
      });

      const aapl = seedSecurity(db, "AAPL", { currency: "USD" });
      seedTaxLot(db, ACCOUNT_ID, aapl, "2025-01-01", 200, 100, 20_000);
      seedPrice(db, aapl, 250, TODAY);

      const lots = getOpenTaxLots(db);
      const krwLot = lots.find((l) => l.symbol === "402340");
      const usdLot = lots.find((l) => l.symbol === "AAPL");
      expect(krwLot).toBeTruthy();
      expect(usdLot).toBeTruthy();

      const expectedCostUsd = 10 * 1_632_979.2 * 0.000734; // 11,986.07
      expect(krwLot!.cost_basis).toBeCloseTo(expectedCostUsd, 2);
      expect(krwLot!.cost_basis).not.toBeCloseTo(16_329_792, 0);

      // USD control: byte-identical (×1)
      expect(usdLot!.cost_basis).toBe(20_000);
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

  // ─── Closed sales: native-currency realized G/L must never sum into USD totals ───

  function seedSale(
    dbi: Database.Database,
    accountId: number,
    securityId: number,
    saleDate: string,
    opts: {
      proceeds: number;
      costBasis: number;
      realized: number;
      isLongTerm?: number;
    }
  ): void {
    const lot = dbi
      .prepare(
        `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
         VALUES (?, ?, '2025-01-01', 1, 10, 0, ?)`
      )
      .run(accountId, securityId, opts.costBasis);
    const txn = dbi
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount)
         VALUES (?, ?, ?, 'SELL', 10, ?)`
      )
      .run(accountId, securityId, saleDate, opts.proceeds);
    dbi
      .prepare(
        `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days, sale_date)
         VALUES (?, ?, 10, ?, ?, ?, ?, ?, 100, ?)`
      )
      .run(
        lot.lastInsertRowid,
        txn.lastInsertRowid,
        opts.proceeds / 10,
        opts.proceeds,
        opts.costBasis,
        opts.realized,
        opts.isLongTerm ?? 0,
        saleDate
      );
  }

  describe("closed-sale realized totals with a non-USD sale", () => {
    const YEAR = 2026;

    beforeEach(() => {
      // USD sale: +5,000 short-term
      const aapl = seedSecurity(db, "AAPL", { currency: "USD" });
      seedSale(db, ACCOUNT_ID, aapl, "2026-07-12", {
        proceeds: 25_000,
        costBasis: 20_000,
        realized: 5_000,
      });
      // KRW sale: native −3,980,000 (≈ −$2,646) — must NOT sum as USD
      const krw = seedSecurity(db, "402340", { currency: "KRW" });
      seedSale(db, ACCOUNT_ID, krw, "2026-07-12", {
        proceeds: 12_340_000,
        costBasis: 16_320_000,
        realized: -3_980_000,
      });
      upsertFxRate(db, {
        currency: "KRW",
        usdPerUnit: 0.0006648,
        asOf: "2026-07-12",
        source: "test",
      });
    });

    it("getTaxLotSummary excludes the non-USD sale from USD realized totals and discloses the exclusion", () => {
      const summary = getTaxLotSummary(db, YEAR);
      // count still covers every sale
      expect(summary.totalClosedSales).toBe(2);
      // USD headline totals: never a native-KRW figure summed as dollars
      expect(summary.totalRealizedGain).toBe(5_000);
      expect(summary.shortTermGain).toBe(5_000);
      expect(summary.longTermGain).toBe(0);
      // the exclusion is disclosed, not silent
      expect(summary.excludedNonUsdSales).toBe(1);
    });

    it("getTaxLotSummaryByAccount excludes the non-USD sale per account and discloses it", () => {
      const rows = getTaxLotSummaryByAccount(db, YEAR);
      const acct = rows.find((r) => r.account_id === ACCOUNT_ID);
      expect(acct).toBeTruthy();
      expect(acct!.totalClosedSales).toBe(2);
      expect(acct!.totalRealizedGain).toBe(5_000);
      expect(acct!.shortTermGain).toBe(5_000);
      expect(acct!.excludedNonUsdSales).toBe(1);
    });

    it("getClosedTaxLotSales rows carry the security's currency so the UI can label native values", () => {
      const sales = getClosedTaxLotSales(db, YEAR);
      const krwSale = sales.find((s) => s.symbol === "402340");
      const usdSale = sales.find((s) => s.symbol === "AAPL");
      expect(krwSale?.currency).toBe("KRW");
      expect(usdSale?.currency).toBe("USD");
      // row values stay native (never fabricate an FX vintage on tax rows)
      expect(krwSale?.realized_gain_loss).toBe(-3_980_000);
    });
  });
});
