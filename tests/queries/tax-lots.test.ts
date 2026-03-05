import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import {
  getOpenTaxLots,
  getClosedTaxLotSales,
  getTaxLotSummary,
} from "@/lib/queries/tax-lots";

function seedSecurity(
  db: Database.Database,
  symbol: string,
  securityType?: string
): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)"
    )
    .run(symbol, symbol + " Corp", securityType ?? null);
  return result.lastInsertRowid as number;
}

function seedBuy(
  db: Database.Database,
  accountId: number,
  securityId: number,
  date: string,
  qty: number,
  price: number
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
     VALUES (?, ?, ?, 'BUY', ?, ?, ?, ?)`
  ).run(
    accountId,
    securityId,
    date,
    qty,
    price,
    -(qty * price),
    `buy-${accountId}-${securityId}-${date}-${Math.random()}`
  );
}

function seedSell(
  db: Database.Database,
  accountId: number,
  securityId: number,
  date: string,
  qty: number,
  price: number
): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
     VALUES (?, ?, ?, 'SELL', ?, ?, ?, ?)`
  ).run(
    accountId,
    securityId,
    date,
    qty,
    price,
    qty * price,
    `sell-${accountId}-${securityId}-${date}-${Math.random()}`
  );
}

function seedPrice(
  db: Database.Database,
  securityId: number,
  date: string,
  price: number
): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
  ).run(securityId, date, price);
}

describe("tax-lots queries", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  describe("getOpenTaxLots", () => {
    it("returns open lots with current value and unrealized gain", () => {
      const sec = seedSecurity(db, "VTI");
      seedBuy(db, ACCOUNT_ID, sec, "2025-01-15", 100, 200);
      seedPrice(db, sec, "2025-02-28", 220);
      computeTaxLots(db);

      const lots = getOpenTaxLots(db);
      expect(lots).toHaveLength(1);
      expect(lots[0].symbol).toBe("VTI");
      expect(lots[0].quantity_remaining).toBe(100);
      expect(lots[0].current_price).toBe(220);
      expect(lots[0].current_value).toBe(22000); // 100 * 220
      expect(lots[0].unrealized_gain).toBe(2000); // 22000 - 20000
    });

    it("returns null current_value when no price exists", () => {
      const sec = seedSecurity(db, "MYSTERY");
      seedBuy(db, ACCOUNT_ID, sec, "2025-01-15", 50, 100);
      computeTaxLots(db);

      const lots = getOpenTaxLots(db);
      expect(lots).toHaveLength(1);
      expect(lots[0].current_price).toBeNull();
      expect(lots[0].current_value).toBeNull();
      expect(lots[0].unrealized_gain).toBeNull();
    });

    it("applies bond adjustment for bond securities (both sides)", () => {
      const bond = seedSecurity(db, "TBILL", "bond");
      seedBuy(db, ACCOUNT_ID, bond, "2025-01-15", 10000, 98);
      seedPrice(db, bond, "2025-02-28", 99);
      computeTaxLots(db);

      const lots = getOpenTaxLots(db);
      expect(lots).toHaveLength(1);
      // Bond current_value: 10000 * 99 / 100 = $9,900
      expect(lots[0].current_value).toBe(9900);
      // Both current value and cost basis are now par-adjusted:
      // unrealized = (10000 * 99 / 100) - (10000 * 98 / 100) = 9900 - 9800 = $100
      expect(lots[0].unrealized_gain).toBe(100);
    });

    it("applies multiplier for option securities", () => {
      // Create an option security with multiplier 100
      db.prepare(
        `INSERT INTO securities (symbol, name, security_type, multiplier, underlying_symbol, strike_price, expiration_date, option_type)
         VALUES (?, ?, 'option', 100, 'AAPL', 150, '2025-03-21', 'CALL')`
      ).run("AAPL  250321C00150000", "AAPL 150 Call");
      const secId = (db.prepare("SELECT id FROM securities WHERE symbol = ?").get("AAPL  250321C00150000") as any).id;

      seedBuy(db, ACCOUNT_ID, secId, "2025-01-15", 5, 3.5);
      seedPrice(db, secId, "2025-02-28", 5.0);
      computeTaxLots(db);

      const lots = getOpenTaxLots(db);
      expect(lots).toHaveLength(1);
      // current_value: 5 * 5.0 * 100 = $2,500
      expect(lots[0].current_value).toBe(2500);
      // cost: 5 * 3.5 * 100 = $1,750
      // unrealized: 2500 - 1750 = $750
      expect(lots[0].unrealized_gain).toBe(750);
    });
  });

  describe("getClosedTaxLotSales", () => {
    it("returns sales ordered by date desc", () => {
      const sec = seedSecurity(db, "VTI");
      seedBuy(db, ACCOUNT_ID, sec, "2025-01-15", 100, 200);
      seedSell(db, ACCOUNT_ID, sec, "2025-02-15", 50, 220);
      seedSell(db, ACCOUNT_ID, sec, "2025-03-01", 25, 230);
      computeTaxLots(db);

      const sales = getClosedTaxLotSales(db);
      expect(sales).toHaveLength(2);
      expect(sales[0].sale_date).toBe("2025-03-01");
      expect(sales[1].sale_date).toBe("2025-02-15");
      expect(sales[0].quantity_sold).toBe(25);
      expect(sales[1].quantity_sold).toBe(50);
    });
  });

  describe("getTaxLotSummary", () => {
    it("aggregates open lots and closed sales correctly", () => {
      const sec = seedSecurity(db, "VTI");
      seedBuy(db, ACCOUNT_ID, sec, "2025-01-15", 100, 200);
      seedSell(db, ACCOUNT_ID, sec, "2025-02-15", 40, 220);
      seedPrice(db, sec, "2025-02-28", 210);
      computeTaxLots(db);

      const summary = getTaxLotSummary(db);
      expect(summary.totalOpenLots).toBe(1);
      expect(summary.totalClosedSales).toBe(1);
      // Realized: 40 * (220 - 200) = 800
      expect(summary.totalRealizedGain).toBe(800);
      // Unrealized: (60 * 210) - (60 * 200) = 12600 - 12000 = 600
      expect(summary.totalUnrealizedGain).toBe(600);
    });

    it("returns zeros when no tax lots exist", () => {
      const summary = getTaxLotSummary(db);
      expect(summary.totalOpenLots).toBe(0);
      expect(summary.totalClosedSales).toBe(0);
      expect(summary.totalUnrealizedGain).toBe(0);
      expect(summary.totalRealizedGain).toBe(0);
    });
  });
});
