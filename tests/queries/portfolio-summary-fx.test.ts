import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { formatUSD } from "@/lib/format";

// ─── Seed helpers (mirrors tests/queries/portfolio-summary.test.ts, + currency/cost_basis) ────

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts: { name?: string; security_type?: string; currency?: string; asset_class?: string } = {}
): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, currency, asset_class) VALUES (?, ?, ?, ?, ?)"
    )
    .run(
      symbol,
      opts.name ?? `${symbol} Corp`,
      opts.security_type ?? null,
      opts.currency ?? "USD",
      opts.asset_class ?? null
    );
  return result.lastInsertRowid as number;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
  costBasis: number | null = null
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
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

function seedPrice(db: Database.Database, securityId: number, date: string, price: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
  ).run(securityId, date, price);
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
  ).run(accountId, securityId, acquisitionDate, acquisitionPrice, quantityRemaining, quantityRemaining, costBasis);
}

describe("getPortfolioSummaryForChat FX conversion", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1; // Vanguard Taxable (migration 002 seed)
  const TODAY = "2026-07-01";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("holdings market value + unrealized gain use USD, not the won phantom", () => {
    // USD control: 100 sh @ $250, cost basis $20,000 -> MV $25,000, gain $5,000.
    const aapl = seedSecurity(db, "AAPL", { currency: "USD" });
    seedHolding(db, ACCOUNT_ID, aapl, 100, TODAY, 20000);
    seedPrice(db, aapl, TODAY, 250);

    // KRW holding: 10 sh @ ₩1,731,000 = ₩17,310,000 notional; cost basis
    // ₩16,329,792. Pre-fix this renders as $17,310,000 MV (phantom).
    const krw = seedSecurity(db, "402340", { currency: "KRW" });
    seedHolding(db, ACCOUNT_ID, krw, 10, TODAY, 16_329_792);
    seedPrice(db, krw, TODAY, 1_731_000);

    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.000734, asOf: TODAY, source: "test" });

    const summary = getPortfolioSummaryForChat(db);

    const expectedKrwUsdMv = 10 * 1_731_000 * 0.000734; // 12,705.54
    const expectedKrwUsdCost = 16_329_792 * 0.000734; // 11,986.07
    const expectedGain = expectedKrwUsdMv - expectedKrwUsdCost; // ~719.47

    expect(summary).toContain("402340");
    expect(summary).toContain(`MV:${formatUSD(expectedKrwUsdMv)}`);
    expect(summary).toContain(`G/L:+${formatUSD(expectedGain)}`);

    // Must NOT show the won-notional phantom ($17,310,000) anywhere.
    expect(summary).not.toContain("$17,310,000");
    expect(summary).not.toContain("17,310,000");

    // USD control unaffected.
    expect(summary).toContain("MV:$25,000");
    expect(summary).toContain("G/L:+$5,000");
  });

  it("asset allocation totals use USD, not the won phantom", () => {
    const aapl = seedSecurity(db, "AAPL", { currency: "USD", asset_class: "US Equity" });
    seedHolding(db, ACCOUNT_ID, aapl, 100, TODAY);
    seedPrice(db, aapl, TODAY, 250); // $25,000

    const krw = seedSecurity(db, "402340", { currency: "KRW", asset_class: "Intl Equity" });
    seedHolding(db, ACCOUNT_ID, krw, 10, TODAY);
    seedPrice(db, krw, TODAY, 1_731_000);

    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.000734, asOf: TODAY, source: "test" });

    const summary = getPortfolioSummaryForChat(db);
    const expectedKrwUsdMv = 10 * 1_731_000 * 0.000734; // 12,705.54

    expect(summary).toContain("Asset Allocation");
    expect(summary).toContain(`Intl Equity: ${formatUSD(expectedKrwUsdMv)}`);
    expect(summary).not.toContain("$17,310,000");
    expect(summary).toContain(`US Equity: $25,000`);
  });

  it("tax-loss harvesting candidates compute the loss in USD, not the won phantom", () => {
    const krw = seedSecurity(db, "402340", { currency: "KRW" });
    // 100 units acquired @ ₩2,000,000, now priced @ ₩1,700,000 -> a loss.
    seedTaxLot(db, ACCOUNT_ID, krw, "2025-01-01", 2_000_000, 100, 200_000_000);
    seedPrice(db, krw, TODAY, 1_700_000);

    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.000734, asOf: TODAY, source: "test" });

    const summary = getPortfolioSummaryForChat(db);

    const expectedUsdMv = 100 * 1_700_000 * 0.000734; // 124,780
    const expectedUsdCost = 100 * 2_000_000 * 0.000734; // 146,800
    const expectedLoss = expectedUsdMv - expectedUsdCost; // -22,020

    expect(summary).toContain("Tax-Loss Harvesting Candidates");
    expect(summary).toContain("402340");
    expect(summary).toContain(formatUSD(expectedLoss));

    // Must NOT show the won-notional phantom loss (-$30,000,000).
    expect(summary).not.toContain("30,000,000");
  });
});
