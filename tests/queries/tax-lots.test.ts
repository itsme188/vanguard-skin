import { marketValue } from "@/lib/valuation";
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import {
  getOpenTaxLots,
  getClosedTaxLotSales,
  getTaxLotSummary,
  getExpiredOptionLotsAwaitingClose,
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
  const security = db.prepare("SELECT security_type, COALESCE(multiplier,1) multiplier FROM securities WHERE id=?")
    .get(securityId) as { security_type: string; multiplier: number };
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
     VALUES (?, ?, ?, 'BUY', ?, ?, ?, ?)`
  ).run(
    accountId,
    securityId,
    date,
    qty,
    price,
    -marketValue(qty, price, security.security_type, security.multiplier),
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

      const lots = getOpenTaxLots(db, undefined, { today: "2025-02-28" });
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

      const lots = getOpenTaxLots(db, undefined, { today: "2025-02-28" });
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

      const lots = getOpenTaxLots(db, undefined, { today: "2025-02-28" });
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
      const secId = (
        db.prepare("SELECT id FROM securities WHERE symbol = ?").get("AAPL  250321C00150000") as { id: number }
      ).id;

      seedBuy(db, ACCOUNT_ID, secId, "2025-01-15", 5, 3.5);
      seedPrice(db, secId, "2025-02-28", 5.0);
      computeTaxLots(db);

      const lots = getOpenTaxLots(db, undefined, { today: "2025-02-28" });
      expect(lots).toHaveLength(1);
      // current_value: 5 * 5.0 * 100 = $2,500
      expect(lots[0].current_value).toBe(2500);
      // cost: 5 * 3.5 * 100 = $1,750
      // unrealized: 2500 - 1750 = $750
      expect(lots[0].unrealized_gain).toBe(750);
    });

    it("classifies expired options, including legacy YYYYMMDD expirations, outside live open lots", () => {
      db.prepare(
        `INSERT INTO securities (symbol, name, security_type, multiplier, underlying_symbol, strike_price, expiration_date, option_type)
         VALUES
           ('ZZOPTA 260821C00050000', 'ZZOPTA Call', 'Option', 100, 'ZZOPTA', 50, '2026-08-21', 'CALL'),
           ('ZZOPTB 260820P00040000', 'ZZOPTB Put', 'Option', 100, 'ZZOPTB', 40, '20260820', 'PUT'),
           ('ZZOPTC 260822C00030000', 'ZZOPTC Call', 'Option', 100, 'ZZOPTC', 30, '2026-08-22', 'CALL')`
      ).run();
      const expiredDashed = (db.prepare("SELECT id FROM securities WHERE symbol = 'ZZOPTA 260821C00050000'").get() as { id: number }).id;
      const expiredLegacy = (db.prepare("SELECT id FROM securities WHERE symbol = 'ZZOPTB 260820P00040000'").get() as { id: number }).id;
      const live = (db.prepare("SELECT id FROM securities WHERE symbol = 'ZZOPTC 260822C00030000'").get() as { id: number }).id;

      seedBuy(db, ACCOUNT_ID, expiredDashed, "2026-08-01", 1, 2);
      seedBuy(db, ACCOUNT_ID, expiredLegacy, "2026-08-01", 1, 3);
      seedBuy(db, ACCOUNT_ID, live, "2026-08-01", 1, 4);
      seedPrice(db, expiredDashed, "2026-08-21", 9);
      seedPrice(db, expiredLegacy, "2026-08-21", 8);
      seedPrice(db, live, "2026-08-21", 7);
      computeTaxLots(db);

      const lots = getOpenTaxLots(db, undefined, { today: "2026-08-22" });
      expect(lots.map((l) => l.symbol)).toEqual(["ZZOPTC 260822C00030000"]);

      const awaiting = getExpiredOptionLotsAwaitingClose(db, { today: "2026-08-22" });
      expect(awaiting.map((l) => l.symbol).sort()).toEqual([
        "ZZOPTA 260821C00050000",
        "ZZOPTB 260820P00040000",
      ]);
      expect(awaiting.every((l) => l.expired_option)).toBe(true);
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

    it("exposes is_synthetic_close: true for a RECONCILE_CLOSE-sourced sale, false for a real sale (finding 1, number-trust durable fixes)", () => {
      const sec = seedSecurity(db, "VTI");
      seedBuy(db, ACCOUNT_ID, sec, "2025-01-15", 100, 200);
      seedSell(db, ACCOUNT_ID, sec, "2025-02-15", 30, 220); // real sale
      seedSell(db, ACCOUNT_ID, sec, "2025-03-01", 30, 230); // will become RECONCILE_CLOSE
      computeTaxLots(db);

      // RECONCILE_CLOSE is engine-owned in production (synthesized by
      // computeTaxLots for a broker-zeroed position with an orphan open
      // lot) — simulated directly here, mirroring the filingOnly test below.
      db.prepare(
        `UPDATE transactions SET type = 'RECONCILE_CLOSE'
         WHERE id = (
           SELECT sale_transaction_id FROM tax_lot_sales WHERE sale_date = '2025-03-01'
         )`
      ).run();

      const sales = getClosedTaxLotSales(db, 2025);
      expect(sales).toHaveLength(2);
      const real = sales.find((s) => s.sale_date === "2025-02-15")!;
      const synthetic = sales.find((s) => s.sale_date === "2025-03-01")!;
      expect(real.is_synthetic_close).toBe(false);
      expect(synthetic.is_synthetic_close).toBe(true);
    });

    it("carries is_short and account_id through to the reader (Task 6 dependency)", () => {
      const sec = seedSecurity(db, "SHRT");
      db.prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
         VALUES (?, ?, '2025-01-10', 'SELL_TO_OPEN', 10, 50, 500, 'short-open')`
      ).run(ACCOUNT_ID, sec);
      db.prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
         VALUES (?, ?, '2025-02-20', 'BUY_TO_COVER', 10, 40, -400, 'short-cover')`
      ).run(ACCOUNT_ID, sec);
      computeTaxLots(db);

      const sales = getClosedTaxLotSales(db, 2025);
      expect(sales).toHaveLength(1);
      expect(sales[0].is_short).toBe(1);
      expect(sales[0].account_id).toBe(ACCOUNT_ID);
    });

    describe("filingOnly", () => {
      it("excludes RECONCILE_CLOSE-sourced and premium-rollover sales; default includes them", () => {
        const sec = seedSecurity(db, "VTI");
        seedBuy(db, ACCOUNT_ID, sec, "2025-01-15", 100, 200);
        seedSell(db, ACCOUNT_ID, sec, "2025-02-15", 30, 220); // stays filing-eligible
        seedSell(db, ACCOUNT_ID, sec, "2025-03-01", 30, 230); // will become RECONCILE_CLOSE
        seedSell(db, ACCOUNT_ID, sec, "2025-04-01", 30, 240); // will become a premium rollover
        computeTaxLots(db);

        // RECONCILE_CLOSE is engine-owned in production (synthesized by
        // computeTaxLots for a broker-zeroed position with an orphan open
        // lot) — simulated directly here to test the reader's filter in
        // isolation from that synthesis path.
        db.prepare(
          `UPDATE transactions SET type = 'RECONCILE_CLOSE'
           WHERE id = (
             SELECT sale_transaction_id FROM tax_lot_sales WHERE sale_date = '2025-03-01'
           )`
        ).run();
        db.prepare(
          `UPDATE tax_lot_sales SET premium_rollover = 1 WHERE sale_date = '2025-04-01'`
        ).run();

        const defaultSales = getClosedTaxLotSales(db, 2025);
        expect(defaultSales).toHaveLength(3);

        const filingSales = getClosedTaxLotSales(db, 2025, { filingOnly: true });
        expect(filingSales).toHaveLength(1);
        expect(filingSales[0].sale_date).toBe("2025-02-15");
      });

      it("also filters correctly with no year argument", () => {
        const sec = seedSecurity(db, "VTI");
        seedBuy(db, ACCOUNT_ID, sec, "2025-01-15", 100, 200);
        seedSell(db, ACCOUNT_ID, sec, "2025-02-15", 30, 220);
        seedSell(db, ACCOUNT_ID, sec, "2025-04-01", 30, 240);
        computeTaxLots(db);
        db.prepare(
          `UPDATE tax_lot_sales SET premium_rollover = 1 WHERE sale_date = '2025-04-01'`
        ).run();

        const filingSales = getClosedTaxLotSales(db, undefined, { filingOnly: true });
        expect(filingSales).toHaveLength(1);
        expect(filingSales[0].sale_date).toBe("2025-02-15");
      });
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

    it("drops expired options from open-lot and unrealized counts while disclosing awaiting-close contracts", () => {
      db.prepare(
        `INSERT INTO securities (symbol, name, security_type, multiplier, underlying_symbol, strike_price, expiration_date, option_type)
         VALUES
           ('ZZOLD 260821C00050000', 'ZZOLD Call', 'Option', 100, 'ZZOLD', 50, '2026-08-21', 'CALL'),
           ('ZZLIVE 260822C00050000', 'ZZLIVE Call', 'Option', 100, 'ZZLIVE', 50, '2026-08-22', 'CALL')`
      ).run();
      const expired = (db.prepare("SELECT id FROM securities WHERE symbol = 'ZZOLD 260821C00050000'").get() as { id: number }).id;
      const live = (db.prepare("SELECT id FROM securities WHERE symbol = 'ZZLIVE 260822C00050000'").get() as { id: number }).id;
      seedBuy(db, ACCOUNT_ID, expired, "2026-08-01", 1, 2);
      seedBuy(db, ACCOUNT_ID, live, "2026-08-01", 1, 4);
      seedPrice(db, expired, "2026-08-21", 9);
      seedPrice(db, live, "2026-08-21", 7);
      computeTaxLots(db);

      const summary = getTaxLotSummary(db, undefined, { today: "2026-08-22" });
      expect(summary.totalOpenLots).toBe(1);
      expect(summary.totalUnrealizedGain).toBe(300);
      expect(summary.expiredOptionLotsAwaitingClose).toBe(1);
    });
  });
});
