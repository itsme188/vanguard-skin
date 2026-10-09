import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import {
  getOpenTaxLots,
  getTaxLotSummary,
  getTaxLotSummaryByAccount,
  getClosedTaxLotSales,
  isCurrencyConversionTaxLot,
} from "@/lib/queries/tax-lots";
import { generateForm8949CSV, generateTaxReport, generateTXF } from "@/lib/compute/tax-report";

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
    it("keeps Forex lots query-visible but classifies them as Section 988 currency conversions", () => {
      const stock = seedSecurity(db, "ZZSTOCK", { security_type: "Stock" });
      seedTaxLot(db, ACCOUNT_ID, stock, "2026-01-02", 10, 10, 100);
      seedPrice(db, stock, 12, TODAY);

      const fx = seedSecurity(db, "ZZE.USD", { security_type: "fOrEx" });
      seedTaxLot(db, ACCOUNT_ID, fx, "2026-01-02", 1, 25, 25);

      const lots = getOpenTaxLots(db);
      expect(lots.map((l) => l.symbol).sort()).toEqual(["ZZE.USD", "ZZSTOCK"]);
      expect(lots.find((l) => l.symbol === "ZZE.USD")?.currency_conversion).toBe(true);
      expect(lots.find((l) => l.symbol === "ZZSTOCK")?.currency_conversion).toBe(false);
      expect(lots.filter(isCurrencyConversionTaxLot).map((l) => l.symbol)).toEqual(["ZZE.USD"]);
    });

    it("converts a KRW lot's market value + adjusted cost basis + unrealized gain to USD, not the won phantom", () => {
      const krw = seedSecurity(db, "000000", { currency: "KRW" });
      seedTaxLot(db, ACCOUNT_ID, krw, "2025-01-01", 1_400_000, 10, 14_000_000);
      seedPrice(db, krw, 1_500_000, TODAY);

      upsertFxRate(db, {
        currency: "KRW",
        usdPerUnit: 0.000734,
        asOf: TODAY,
        source: "test",
      });

      const lots = getOpenTaxLots(db);
      const krwLot = lots.find((l) => l.symbol === "000000");
      expect(krwLot).toBeTruthy();

      const expectedMv = 10 * 1_500_000 * 0.000734; // 11,010.00
      const expectedCostUsd = 10 * 1_400_000 * 0.000734; // 10,276.00

      expect(krwLot!.current_value).toBeCloseTo(expectedMv, 2);
      expect(krwLot!.current_value).toBeLessThan(20_000);
      expect(krwLot!.current_value).not.toBeCloseTo(15_000_000, 0);

      expect(krwLot!.adjusted_cost_basis).toBeCloseTo(expectedCostUsd, 2);
      expect(krwLot!.adjusted_cost_basis).not.toBeCloseTo(14_000_000, 0);

      expect(krwLot!.unrealized_gain).toBeCloseTo(expectedMv - expectedCostUsd, 2);
      expect(krwLot!.unrealized_gain).toBeCloseTo(734.00, 1);
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
      const krw = seedSecurity(db, "000000", { currency: "KRW" });
      seedTaxLot(db, ACCOUNT_ID, krw, "2025-01-01", 1_400_000, 10, 14_000_000);
      seedPrice(db, krw, 1_500_000, TODAY);

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
      const krwLot = lots.find((l) => l.symbol === "000000");
      const usdLot = lots.find((l) => l.symbol === "AAPL");
      expect(krwLot).toBeTruthy();
      expect(usdLot).toBeTruthy();

      const expectedCostUsd = 10 * 1_400_000 * 0.000734; // 10,276.00
      expect(krwLot!.cost_basis).toBeCloseTo(expectedCostUsd, 2);
      expect(krwLot!.cost_basis).not.toBeCloseTo(14_000_000, 0);

      // USD control: byte-identical (×1)
      expect(usdLot!.cost_basis).toBe(20_000);
    });
  });

  describe("getTaxLotSummary", () => {
    it("excludes Forex conversion lots from the open-lot count and unrealized tile", () => {
      const stock = seedSecurity(db, "ZZSTOCK", { security_type: "Stock" });
      seedTaxLot(db, ACCOUNT_ID, stock, "2026-01-02", 10, 10, 100);
      seedPrice(db, stock, 12, TODAY);

      const fx = seedSecurity(db, "ZZE.USD", { security_type: "Forex" });
      seedTaxLot(db, ACCOUNT_ID, fx, "2026-01-02", 1, 25, 25);
      seedPrice(db, fx, 2, TODAY);

      const summary = getTaxLotSummary(db);
      expect(summary.totalOpenLots).toBe(1);
      expect(summary.totalUnrealizedGain).toBe(20);
      expect(summary.currencyConversionOpenLots).toBe(1);
    });

    it("aggregates a KRW lot's unrealized gain in USD, not the won phantom", () => {
      const aapl = seedSecurity(db, "AAPL", { currency: "USD" });
      seedTaxLot(db, ACCOUNT_ID, aapl, "2025-01-01", 200, 100, 20_000);
      seedPrice(db, aapl, 250, TODAY); // USD gain: (100*250) - 20000 = 5,000

      const krw = seedSecurity(db, "000000", { currency: "KRW" });
      seedTaxLot(db, ACCOUNT_ID, krw, "2025-01-01", 1_400_000, 10, 14_000_000);
      seedPrice(db, krw, 1_500_000, TODAY);

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
        10 * 1_500_000 * 0.000734 - 10 * 1_400_000 * 0.000734; // ~734.00
      const expectedTotal = usdGain + krwGainUsd;

      expect(summary.totalUnrealizedGain).toBeCloseTo(expectedTotal, 2);
      // Must NOT be dominated by the won-notional phantom gain
      // (would be ~1,005,000 if KRW were treated as raw USD).
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
      // KRW sale: native −3,000,000 (≈ −$1,994) — must NOT sum as USD
      const krw = seedSecurity(db, "000000", { currency: "KRW" });
      seedSale(db, ACCOUNT_ID, krw, "2026-07-12", {
        proceeds: 11_000_000,
        costBasis: 14_000_000,
        realized: -3_000_000,
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
      const krwSale = sales.find((s) => s.symbol === "000000");
      const usdSale = sales.find((s) => s.symbol === "AAPL");
      expect(krwSale?.currency).toBe("KRW");
      expect(usdSale?.currency).toBe("USD");
      // row values stay native (never fabricate an FX vintage on tax rows)
      expect(krwSale?.realized_gain_loss).toBe(-3_000_000);
      // Sort keys are display-only USD conversions so non-USD rows do not
      // rank by raw native magnitude in the Closed Sales table.
      expect(krwSale?.realized_gain_loss_usd).toBeCloseTo(-3_000_000 * 0.0006648, 6);
      expect(usdSale?.realized_gain_loss_usd).toBe(usdSale?.realized_gain_loss);
    });

    it("filingOnly excludes Forex conversion sales while the operational reader keeps them classified", () => {
      const csvBefore = generateForm8949CSV(generateTaxReport(db, YEAR));
      const txfBefore = generateTXF(generateTaxReport(db, YEAR));

      const fx = seedSecurity(db, "ZZE.USD", { security_type: "Forex" });
      seedSale(db, ACCOUNT_ID, fx, "2026-07-12", {
        proceeds: 120,
        costBasis: 100,
        realized: 20,
      });

      const operational = getClosedTaxLotSales(db, YEAR);
      expect(operational.find((s) => s.symbol === "ZZE.USD")?.currency_conversion).toBe(true);

      const filing = getClosedTaxLotSales(db, YEAR, { filingOnly: true });
      expect(filing.some((s) => s.symbol === "ZZE.USD")).toBe(false);

      const report = generateTaxReport(db, YEAR);
      expect(report.shortTermRows.some((r) => r.symbol === "ZZE.USD")).toBe(false);
      const csvAfter = generateForm8949CSV(report);
      const txfAfter = generateTXF(report);
      expect(csvAfter).not.toContain("ZZE.USD");
      expect(txfAfter).not.toContain("ZZE.USD");
      expect(csvAfter).toBe(csvBefore);
      expect(txfAfter).toBe(txfBefore);
    });
  });
});
