import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import {
  getChartableSecurities,
  getDefaultChartSecurityId,
} from "@/lib/queries/ohlcv";

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

/**
 * Seeds a single cached bar. Callers only need "does at least one bar
 * exist" for this security — the OHLC values are arbitrary synthetic round
 * numbers, not real prices.
 */
function seedBar(db: Database.Database, securityId: number, barDate: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', 10, 11, 9, 10, 1000)`,
  ).run(securityId, barDate);
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

  it("never lands on a held OPTION, however large its multiplier-inflated notional", () => {
    // adjustedMarketValueSQL multiplies an option row by its x100 contract
    // multiplier, so a handful of contracts can out-notional every equity in
    // the book and become the surprise landing chart. A landing default
    // should be a name the desk recognises, not the largest notional.
    const option = seedSecurity(db, "QOPT  260918C00100000", {
      securityType: "Option",
    });
    db.prepare("UPDATE securities SET multiplier = 100 WHERE id = ?").run(option);
    seedHolding(db, IBKR, option, 20, TODAY);
    seedPrice(db, option, TODAY, 40); // 20 x 40 x 100 = $80,000

    const equity = seedSecurity(db, "QAAA");
    seedHolding(db, TAXABLE, equity, 10, TODAY);
    seedPrice(db, equity, TODAY, 50); // $500 — far smaller, but it is a stock

    expect(getDefaultChartSecurityId(db)).toBe(equity);
  });

  it("the exclusion is scoped to the landing default — options stay chartable in the picker", () => {
    const option = seedSecurity(db, "QOPT  260918P00050000", {
      securityType: "Option",
    });
    seedHolding(db, IBKR, option, 5, TODAY);
    seedPrice(db, option, TODAY, 10);

    // Nothing else is held, so the landing default has no candidate at all
    // rather than silently falling back to the option.
    expect(getDefaultChartSecurityId(db)).toBeNull();
    // ...but the picker still lists it (CHARTABLE_PREDICATE_SQL is untouched).
    expect(getChartableSecurities(db).map((s) => s.id)).toContain(option);
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

  // charts-landing--default-rank-ignores-bar-coverage-opens-empty-chart:
  // ranking by FX-converted gross exposure alone can land on a held position
  // with ZERO cached bars, opening the chart on an empty "connect TWS to
  // load bars" screen even though a smaller held position already has bars
  // ready to render. Bar coverage must be preferred ahead of value.

  it("prefers bar coverage over gross exposure — a smaller held position with a cached bar outranks a larger one with none", () => {
    const noBars = seedSecurity(db, "QNOBAR");
    seedHolding(db, TAXABLE, noBars, 100, TODAY);
    seedPrice(db, noBars, TODAY, 200); // $20,000 gross — largest by value, but no bars

    const hasBars = seedSecurity(db, "QHASBAR");
    seedHolding(db, TAXABLE, hasBars, 10, TODAY);
    seedPrice(db, hasBars, TODAY, 50); // $500 gross — smaller, but has a cached bar
    seedBar(db, hasBars, TODAY);

    expect(getDefaultChartSecurityId(db)).toBe(hasBars);
  });

  it("falls back to largest gross exposure when NO held position has any cached bars — the bar-coverage gate is a preference, not an exclusion", () => {
    const small = seedSecurity(db, "QSMALL");
    seedHolding(db, TAXABLE, small, 10, TODAY);
    seedPrice(db, small, TODAY, 50); // $500

    const large = seedSecurity(db, "QLARGE");
    seedHolding(db, TAXABLE, large, 100, TODAY);
    seedPrice(db, large, TODAY, 200); // $20,000 — neither has bars, so value still decides

    expect(getDefaultChartSecurityId(db)).toBe(large);
  });

  // charts-landing--bar-coverage-gate-weaker-than-chart-reader: the has_bars
  // gate must apply the SAME filters as the chart reader (getOhlcvBars:
  // bar_size = '1 day' AND PRICED_BAR_SQL) — otherwise it can count a bar
  // that the chart itself would never render as "coverage", landing on a
  // security that then shows "No cached price history".

  it("does not count a legacy zero-priced bar as coverage — a smaller position with a real priced bar wins", () => {
    const zeroBarOnly = seedSecurity(db, "QZEROBAR");
    seedHolding(db, TAXABLE, zeroBarOnly, 100, TODAY);
    seedPrice(db, zeroBarOnly, TODAY, 200); // $20,000 gross — largest by value
    // Insert directly (bypassing upsertOhlcvBars' write guard, which would
    // reject this) to simulate a pre-2026-09-06 legacy zero-priced bar.
    db.prepare(
      `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
       VALUES (?, ?, '1 day', 0, 0, 0, 0, 0)`,
    ).run(zeroBarOnly, TODAY);

    const hasBars = seedSecurity(db, "QHASBAR2");
    seedHolding(db, TAXABLE, hasBars, 10, TODAY);
    seedPrice(db, hasBars, TODAY, 50); // $500 gross — smaller, but has a real priced bar
    seedBar(db, hasBars, TODAY);

    expect(getDefaultChartSecurityId(db)).toBe(hasBars);
  });

  it("does not count an intraday ('1 hour') bar as coverage — a smaller position with a daily bar wins", () => {
    const hourlyOnly = seedSecurity(db, "QHOURLY");
    seedHolding(db, TAXABLE, hourlyOnly, 100, TODAY);
    seedPrice(db, hourlyOnly, TODAY, 200); // $20,000 gross — largest by value
    db.prepare(
      `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
       VALUES (?, ?, '1 hour', 10, 11, 9, 10, 1000)`,
    ).run(hourlyOnly, TODAY);

    const hasBars = seedSecurity(db, "QHASBAR3");
    seedHolding(db, TAXABLE, hasBars, 10, TODAY);
    seedPrice(db, hasBars, TODAY, 50); // $500 gross — smaller, but has a daily bar
    seedBar(db, hasBars, TODAY);

    expect(getDefaultChartSecurityId(db)).toBe(hasBars);
  });

  it("bars on an UNHELD security do not make it win", () => {
    const ghost = seedSecurity(db, "QGHOST");
    seedBar(db, ghost, TODAY); // never held — no holdings row at all

    const held = seedSecurity(db, "QHELD");
    seedHolding(db, TAXABLE, held, 10, TODAY);
    seedPrice(db, held, TODAY, 50);

    expect(getDefaultChartSecurityId(db)).toBe(held);
  });
});
