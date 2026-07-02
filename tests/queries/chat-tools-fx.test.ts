import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import {
  getHoldingsForChat,
  getAllocationBreakdown,
  getTaxLotsForChat,
  getCashEstimates,
} from "@/lib/queries/chat-tools";

// ─── Seed helpers (mirrors tests/queries/chat-tools.test.ts, + currency) ──────

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts?: {
    name?: string;
    security_type?: string;
    asset_class?: string;
    currency?: string;
    multiplier?: number;
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, currency, multiplier)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol,
      opts?.name ?? `${symbol} Corp`,
      opts?.security_type ?? "stock",
      opts?.asset_class ?? "equity",
      opts?.currency ?? "USD",
      opts?.multiplier ?? 1
    );
  return result.lastInsertRowid as number;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
  costBasis?: number
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, costBasis ?? null, asOfDate, `hold-${accountId}-${securityId}-${asOfDate}`);
}

function seedPrice(db: Database.Database, securityId: number, date: string, price: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
  ).run(securityId, date, price);
}

function seedTaxLot(
  db: Database.Database,
  accountId: number,
  securityId: number,
  opts: {
    acquisition_date: string;
    acquisition_price: number;
    quantity_acquired: number;
    quantity_remaining: number;
    cost_basis: number;
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      accountId,
      securityId,
      opts.acquisition_date,
      opts.acquisition_price,
      opts.quantity_acquired,
      opts.quantity_remaining,
      opts.cost_basis
    );
  return result.lastInsertRowid as number;
}

function seedSnapshot(db: Database.Database, accountId: number, monthEnd: string, totalValue: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots (account_id, month_end_date, total_value)
     VALUES (?, ?, ?)`
  ).run(accountId, monthEnd, totalValue);
}

const TODAY = "2025-01-31";
const KRW_QTY = 10;
const KRW_PRICE = 1_731_000;
const KRW_COST_BASIS = 16_329_792;
const KRW_ACQ_PRICE = 1_632_979.2; // = cost_basis / qty
const FX_RATE = 0.000734;

const EXPECTED_KRW_USD_MV = KRW_QTY * KRW_PRICE * FX_RATE; // 12,705.54
const EXPECTED_KRW_USD_COST = KRW_COST_BASIS * FX_RATE; // ~11,986.07
const EXPECTED_KRW_USD_GAIN = EXPECTED_KRW_USD_MV - EXPECTED_KRW_USD_COST; // ~719.47

describe("chat-tools FX conversion", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  describe("getHoldingsForChat", () => {
    it("converts KRW market value, cost basis, and gain to USD (not the won phantom)", () => {
      const aapl = seedSecurity(db, "AAPL", { currency: "USD" });
      seedHolding(db, 1, aapl, 100, TODAY, 20000);
      seedPrice(db, aapl, TODAY, 250);

      const krw = seedSecurity(db, "402340", { currency: "KRW" });
      seedHolding(db, 1, krw, KRW_QTY, TODAY, KRW_COST_BASIS);
      seedPrice(db, krw, TODAY, KRW_PRICE);

      upsertFxRate(db, { currency: "KRW", usdPerUnit: FX_RATE, asOf: TODAY, source: "test" });

      const holdings = getHoldingsForChat(db);
      const krwRow = holdings.find((h) => h.symbol === "402340");
      const usdRow = holdings.find((h) => h.symbol === "AAPL");

      expect(krwRow).toBeDefined();
      expect(krwRow!.market_value).toBeCloseTo(EXPECTED_KRW_USD_MV, 1);
      expect(krwRow!.cost_basis).toBeCloseTo(EXPECTED_KRW_USD_COST, 1);
      expect(krwRow!.unrealized_gain).toBeCloseTo(EXPECTED_KRW_USD_GAIN, 1);
      // gain % should be a normal, small percentage (~6%), not distorted by mixed units
      expect(krwRow!.unrealized_gain_pct).toBeCloseTo(
        (EXPECTED_KRW_USD_GAIN * 100) / EXPECTED_KRW_USD_COST,
        1
      );

      // Must NOT show the won-notional phantom anywhere in the numeric fields.
      expect(krwRow!.market_value).not.toBeCloseTo(17_310_000, 0);
      expect(krwRow!.cost_basis).not.toBeCloseTo(KRW_COST_BASIS, 0);

      // USD control unaffected.
      expect(usdRow!.market_value).toBe(25000);
      expect(usdRow!.cost_basis).toBe(20000);
      expect(usdRow!.unrealized_gain).toBe(5000);
    });
  });

  describe("getAllocationBreakdown", () => {
    it("converts KRW allocation totals to USD (not the won phantom)", () => {
      const aapl = seedSecurity(db, "AAPL", { currency: "USD", asset_class: "US Equity" });
      seedHolding(db, 1, aapl, 100, TODAY);
      seedPrice(db, aapl, TODAY, 250); // $25,000

      const krw = seedSecurity(db, "402340", { currency: "KRW", asset_class: "Intl Equity" });
      seedHolding(db, 1, krw, KRW_QTY, TODAY);
      seedPrice(db, krw, TODAY, KRW_PRICE);

      upsertFxRate(db, { currency: "KRW", usdPerUnit: FX_RATE, asOf: TODAY, source: "test" });

      const alloc = getAllocationBreakdown(db, "asset_class");
      const intl = alloc.find((a) => a.group_name === "Intl Equity");
      const us = alloc.find((a) => a.group_name === "US Equity");

      expect(intl).toBeDefined();
      expect(intl!.total_market_value).toBeCloseTo(EXPECTED_KRW_USD_MV, 1);
      expect(intl!.total_market_value).not.toBeCloseTo(17_310_000, 0);
      expect(us!.total_market_value).toBe(25000);
    });

    it("converts the cost-basis fallback (unpriced KRW position) to USD", () => {
      const krw = seedSecurity(db, "402340", { currency: "KRW", asset_class: "Intl Equity" });
      seedHolding(db, 1, krw, KRW_QTY, TODAY, KRW_COST_BASIS);
      // No price seeded — allocation falls back to cost_basis.

      upsertFxRate(db, { currency: "KRW", usdPerUnit: FX_RATE, asOf: TODAY, source: "test" });

      const alloc = getAllocationBreakdown(db, "asset_class");
      const intl = alloc.find((a) => a.group_name === "Intl Equity");

      expect(intl).toBeDefined();
      expect(intl!.total_market_value).toBeCloseTo(EXPECTED_KRW_USD_COST, 1);
      expect(intl!.total_market_value).not.toBeCloseTo(KRW_COST_BASIS, 0);
    });
  });

  describe("getTaxLotsForChat (open lots)", () => {
    it("converts KRW current value, cost basis, and gain to USD (not the won phantom)", () => {
      const krw = seedSecurity(db, "402340", { currency: "KRW" });
      seedTaxLot(db, 1, krw, {
        acquisition_date: "2024-01-01",
        acquisition_price: KRW_ACQ_PRICE,
        quantity_acquired: KRW_QTY,
        quantity_remaining: KRW_QTY,
        cost_basis: KRW_COST_BASIS,
      });
      seedPrice(db, krw, TODAY, KRW_PRICE);

      upsertFxRate(db, { currency: "KRW", usdPerUnit: FX_RATE, asOf: TODAY, source: "test" });

      const lots = getTaxLotsForChat(db, { symbol: "402340" });
      expect(lots).toHaveLength(1);
      const lot = lots[0];

      expect(lot.current_value).toBeCloseTo(EXPECTED_KRW_USD_MV, 1);
      expect(lot.cost_basis).toBeCloseTo(EXPECTED_KRW_USD_COST, 1);
      expect(lot.unrealized_gain).toBeCloseTo(EXPECTED_KRW_USD_GAIN, 1);

      expect(lot.current_value).not.toBeCloseTo(17_310_000, 0);
      expect(lot.cost_basis).not.toBeCloseTo(KRW_COST_BASIS, 0);
    });
  });

  describe("getCashEstimates", () => {
    it("converts KRW holdings_total and estimated_cash to USD (not the won phantom)", () => {
      const krw = seedSecurity(db, "402340", { currency: "KRW" });
      seedHolding(db, 1, krw, KRW_QTY, TODAY);
      seedPrice(db, krw, TODAY, KRW_PRICE);
      // snapshot_total large enough that estimated_cash stays sane
      seedSnapshot(db, 1, TODAY, 100_000);

      upsertFxRate(db, { currency: "KRW", usdPerUnit: FX_RATE, asOf: TODAY, source: "test" });

      const estimates = getCashEstimates(db);
      const row = estimates.find((e) => e.account_name === "Vanguard Taxable");
      expect(row).toBeDefined();
      expect(row!.holdings_total).toBeCloseTo(EXPECTED_KRW_USD_MV, 1);
      expect(row!.estimated_cash).toBeCloseTo(100_000 - EXPECTED_KRW_USD_MV, 1);

      expect(row!.holdings_total).not.toBeCloseTo(17_310_000, 0);
    });
  });
});
