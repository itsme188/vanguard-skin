import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getAccountCashLine,
  LIVE_SNAPSHOT_CASH_CAPTION,
  priceDateMismatchCaption,
} from "@/lib/queries/account-cash-line";

/**
 * Owner ruling 2026-10-12: date the measurement, not the row. A carried
 * 'estimated' daily valuation is labelled with the day its figures were
 * measured; a live broker total whose positions were priced at an older
 * close is called a price-date mismatch, not an intraday residual.
 *
 * Fixtures are synthetic: AAA/ZZZ tickers, round numbers, fixed past dates.
 */
describe("getAccountCashLine: measured date and price-date mismatch", () => {
  let db: Database.Database;
  let accountId: number;

  function seedValuation(date: string, quality: string | null): void {
    db.prepare(
      `INSERT INTO daily_valuations
         (account_id, valuation_date, cash_balance, holdings_value, total_value,
          holdings_count, priced_count, data_quality)
       VALUES (?, ?, 250, 750, 1000, 1, 1, ?)`,
    ).run(accountId, date, quality);
  }

  function seedAnchor(date: string, source: string): void {
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source, cash_value)
       VALUES (?, ?, 1000, ?, 250)`,
    ).run(accountId, date, source);
  }

  function seedSecurity(symbol: string, type = "Stock", fundCategory: string | null = null): number {
    return db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, fund_category, currency) VALUES (?, ?, ?, ?, 'USD')",
      )
      .run(symbol, `${symbol} Corp`, type, fundCategory).lastInsertRowid as number;
  }

  function seedHolding(securityId: number, asOfDate: string, quantity = 10): void {
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).run(accountId, securityId, quantity, asOfDate, `zz:${accountId}:${securityId}:${asOfDate}`);
  }

  function seedPrice(securityId: number, date: string, close = 100): void {
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(
      securityId,
      date,
      close,
    );
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    accountId = db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Broker')").run()
      .lastInsertRowid as number;
  });

  describe("measured date", () => {
    it("a carried 'estimated' row reads as measured on the last non-estimated day", () => {
      seedValuation("2026-03-05", "live");
      seedValuation("2026-03-06", "estimated");
      seedValuation("2026-03-07", "estimated");

      const line = getAccountCashLine(db, accountId)!;
      expect(line.valuationDate).toBe("2026-03-07");
      expect(line.dataQuality).toBe("estimated");
      expect(line.measuredDate).toBe("2026-03-05");
      expect(line.carried).toBe(true);
    });

    it("a 'live' latest row is measured on its own date and is not carried", () => {
      seedValuation("2026-03-04", "estimated");
      seedValuation("2026-03-05", "live");

      const line = getAccountCashLine(db, accountId)!;
      expect(line.dataQuality).toBe("live");
      expect(line.measuredDate).toBe("2026-03-05");
      expect(line.carried).toBe(false);
    });

    it.each(["recent", "computed", null])("counts a %s row as measured", (quality) => {
      seedValuation("2026-03-05", quality);
      const line = getAccountCashLine(db, accountId)!;
      expect(line.measuredDate).toBe("2026-03-05");
      expect(line.carried).toBe(false);
    });

    it("has no measured date, and is not carried, when every row is 'estimated'", () => {
      seedValuation("2026-03-06", "estimated");
      seedValuation("2026-03-07", "estimated");
      const line = getAccountCashLine(db, accountId)!;
      expect(line.measuredDate).toBeNull();
      expect(line.carried).toBe(false);
    });

    it("never reads another account's measured row", () => {
      const other = db.prepare("INSERT INTO accounts (name) VALUES ('ZZ Other')").run()
        .lastInsertRowid as number;
      db.prepare(
        `INSERT INTO daily_valuations
           (account_id, valuation_date, cash_balance, holdings_value, total_value, data_quality)
         VALUES (?, '2026-03-06', 0, 1000, 1000, 'live')`,
      ).run(other);
      seedValuation("2026-03-05", "live");
      seedValuation("2026-03-07", "estimated");
      expect(getAccountCashLine(db, accountId)!.measuredDate).toBe("2026-03-05");
    });
  });

  describe("price-date mismatch on a live anchor", () => {
    it("positions priced a day older than the live broker total: mismatch, caption names both dates", () => {
      const aaa = seedSecurity("AAA");
      seedHolding(aaa, "2026-03-05");
      seedPrice(aaa, "2026-03-03");
      seedPrice(aaa, "2026-03-04");
      seedValuation("2026-03-05", "live");
      seedAnchor("2026-03-05", "tws");

      const line = getAccountCashLine(db, accountId)!;
      expect(line.isLiveSource).toBe(true);
      expect(line.anchorDate).toBe("2026-03-05");
      expect(line.positionsPriceDate).toBe("2026-03-04");
      expect(line.priceDateMismatch).toBe(true);
      expect(line.liveSourceCaption).toBe(priceDateMismatchCaption("2026-03-05", "2026-03-04"));
      expect(line.liveSourceCaption).toContain("2026-03-05");
      expect(line.liveSourceCaption).toContain("2026-03-04");
      expect(line.liveSourceCaption).toContain("price-date mismatch");
      expect(line.liveSourceCaption).not.toContain("intraday");
    });

    it("positions priced on the anchor day: no mismatch, the usual live caption", () => {
      const aaa = seedSecurity("AAA");
      seedHolding(aaa, "2026-03-05");
      seedPrice(aaa, "2026-03-04");
      seedPrice(aaa, "2026-03-05");
      seedValuation("2026-03-05", "live");
      seedAnchor("2026-03-05", "plaid");

      const line = getAccountCashLine(db, accountId)!;
      expect(line.positionsPriceDate).toBe("2026-03-05");
      expect(line.priceDateMismatch).toBe(false);
      expect(line.liveSourceCaption).toBe(LIVE_SNAPSHOT_CASH_CAPTION);
    });

    it("ignores a price dated after the valuation date and a sweep fund's price", () => {
      const aaa = seedSecurity("AAA");
      const zzz = seedSecurity("ZZZ", "Mutual Fund", "Cash Equivalent");
      seedHolding(aaa, "2026-03-05");
      seedHolding(zzz, "2026-03-05", 250);
      seedPrice(aaa, "2026-03-04");
      seedPrice(aaa, "2026-03-09");
      seedPrice(zzz, "2026-03-05", 1);
      seedValuation("2026-03-05", "live");
      seedAnchor("2026-03-05", "tws");

      const line = getAccountCashLine(db, accountId)!;
      expect(line.positionsPriceDate).toBe("2026-03-04");
      expect(line.priceDateMismatch).toBe(true);
    });

    it("is not a mismatch when the live anchor is older than the valuation date (carried-forward cash)", () => {
      const aaa = seedSecurity("AAA");
      seedHolding(aaa, "2026-03-05");
      seedPrice(aaa, "2026-03-04");
      seedValuation("2026-03-04", "live");
      seedValuation("2026-03-06", "estimated");
      seedAnchor("2026-03-04", "tws");

      const line = getAccountCashLine(db, accountId)!;
      expect(line.anchorDate).toBe("2026-03-04");
      expect(line.priceDateMismatch).toBe(false);
      expect(line.liveSourceCaption).toBe(LIVE_SNAPSHOT_CASH_CAPTION);
    });

    it("is not a mismatch on a statement anchor, and has no caption", () => {
      const aaa = seedSecurity("AAA");
      seedHolding(aaa, "2026-03-05");
      seedPrice(aaa, "2026-03-03");
      seedValuation("2026-03-05", "recent");
      seedAnchor("2026-03-05", "statement");

      const line = getAccountCashLine(db, accountId)!;
      expect(line.positionsPriceDate).toBe("2026-03-03");
      expect(line.priceDateMismatch).toBe(false);
      expect(line.liveSourceCaption).toBeNull();
    });

    it("has no positions price date when nothing held has a price", () => {
      const aaa = seedSecurity("AAA");
      seedHolding(aaa, "2026-03-05");
      seedValuation("2026-03-05", "live");
      seedAnchor("2026-03-05", "tws");
      const line = getAccountCashLine(db, accountId)!;
      expect(line.positionsPriceDate).toBeNull();
      expect(line.priceDateMismatch).toBe(false);
    });

    it("pins the caption wording", () => {
      expect(priceDateMismatchCaption("2026-03-05", "2026-03-04")).toBe(
        "The broker total is from 2026-03-05 but the positions are priced at the 2026-03-04 close, so this cash figure is a price-date mismatch, not a literal cash balance.",
      );
    });
  });
});
