import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { getDefaultChartSecurityId } from "@/lib/queries/ohlcv";

/**
 * Coverage for the charts-landing default-security ruling (QA findings
 * charts-landing--defaults-to-closed-foreign-symbol-with-no-bars-regression-1
 * and ...-defaults-to-dead-402340-no-bars-regression-2): a bare
 * /dashboard/charts visit must default to the LARGEST CURRENTLY-HELD
 * chartable position, never the alphabetically-first security regardless
 * of whether it is actually held.
 */

let nextConId = 5000;

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts: {
    currency?: string;
    ibConId?: number | null;
    securityType?: string | null;
  } = {},
): number {
  const ibConId = opts.ibConId === undefined ? nextConId++ : opts.ibConId;
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, currency, ib_con_id, security_type) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      symbol,
      `${symbol} Test Co`,
      opts.currency ?? "USD",
      ibConId,
      opts.securityType ?? "Stock",
    );
  return result.lastInsertRowid as number;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    accountId,
    securityId,
    quantity,
    asOfDate,
    `hold-${accountId}-${securityId}-${asOfDate}`,
  );
}

function seedPrice(
  db: Database.Database,
  securityId: number,
  date: string,
  price: number,
): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)",
  ).run(securityId, date, price);
}

describe("getDefaultChartSecurityId", () => {
  let db: Database.Database;
  const TAXABLE = 1; // Vanguard Taxable (seeded by runMigrations)
  const IBKR = 3; // IBKR (seeded by runMigrations)
  const TODAY = "2026-07-01";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns null when nothing is held", () => {
    seedSecurity(db, "QAAA");
    expect(getDefaultChartSecurityId(db)).toBeNull();
  });

  it("picks the largest currently-held chartable position, summed across accounts", () => {
    const small = seedSecurity(db, "QAAA");
    seedHolding(db, TAXABLE, small, 10, TODAY);
    seedPrice(db, small, TODAY, 50); // $500

    const large = seedSecurity(db, "QBBB");
    seedHolding(db, TAXABLE, large, 100, TODAY);
    seedHolding(db, IBKR, large, 50, TODAY);
    seedPrice(db, large, TODAY, 200); // (100 + 50) * 200 = $30,000

    expect(getDefaultChartSecurityId(db)).toBe(large);
  });

  it("excludes a quantity-0 tombstone even though it is alphabetically first and was once the largest position", () => {
    // "QAAA" sorts before "QBBB" — pre-fix behavior would have picked it.
    const tombstone = seedSecurity(db, "QAAA");
    seedHolding(db, TAXABLE, tombstone, 100, "2026-06-01"); // was a real, large position...
    seedHolding(db, TAXABLE, tombstone, 0, TODAY); // ...closed: the latest row is a 0-qty tombstone
    seedPrice(db, tombstone, TODAY, 999);

    const held = seedSecurity(db, "QBBB");
    seedHolding(db, TAXABLE, held, 10, TODAY);
    seedPrice(db, held, TODAY, 20); // $200 — smaller in native terms, but it's the only live holding

    expect(getDefaultChartSecurityId(db)).toBe(held);
  });

  it("FX-converts a foreign-currency position before comparing — a huge native quantity loses to a smaller USD position", () => {
    const krw = seedSecurity(db, "QKRW", { currency: "KRW" });
    seedHolding(db, TAXABLE, krw, 1000, TODAY);
    seedPrice(db, krw, TODAY, 1_000_000); // native notional 1,000,000,000 (huge)
    upsertFxRate(db, {
      currency: "KRW",
      usdPerUnit: 0.0000007,
      asOf: TODAY,
      source: "test",
    }); // converts to ~$700 USD

    const usd = seedSecurity(db, "QUSD");
    seedHolding(db, TAXABLE, usd, 100, TODAY);
    seedPrice(db, usd, TODAY, 50); // $5,000 USD — smaller native number, bigger in USD

    expect(getDefaultChartSecurityId(db)).toBe(usd);
  });

  it("skips a non-chartable security (no IB contract id) even if it would otherwise be the largest", () => {
    const notChartable = seedSecurity(db, "QMUT", { ibConId: null });
    seedHolding(db, TAXABLE, notChartable, 1000, TODAY);
    seedPrice(db, notChartable, TODAY, 1000); // $1,000,000 — huge, but not chartable

    const chartable = seedSecurity(db, "QAAA");
    seedHolding(db, TAXABLE, chartable, 10, TODAY);
    seedPrice(db, chartable, TODAY, 50); // $500

    expect(getDefaultChartSecurityId(db)).toBe(chartable);
  });

  it("ranks by gross exposure — a large short position outranks a smaller long one", () => {
    const smallLong = seedSecurity(db, "QLONG");
    const bigShort = seedSecurity(db, "QSHRT");
    seedHolding(db, IBKR, smallLong, 10, TODAY); // 10 x 100 = 1,000 long
    seedHolding(db, IBKR, bigShort, -50, TODAY); // -50 x 100 = 5,000 gross short
    seedPrice(db, smallLong, TODAY, 100);
    seedPrice(db, bigShort, TODAY, 100);
    expect(getDefaultChartSecurityId(db)).toBe(bigShort);
  });
});
