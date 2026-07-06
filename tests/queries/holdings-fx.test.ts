import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { getAllHoldings, getHoldingsByAccount } from "@/lib/queries/holdings";

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts: { currency?: string } = {}
): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name, currency) VALUES (?, ?, ?)")
    .run(symbol, `${symbol} Corp`, opts.currency ?? "USD");
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

describe("getAllHoldings FX conversion", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1; // Vanguard Taxable
  const TODAY = "2026-07-01";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("KRW holding's current_value + unrealized_gain are in USD, not the won phantom", () => {
    // USD control: 10,000 sh @ $208, cost basis $1,800,000.
    const aapl = seedSecurity(db, "AAPL", { currency: "USD" });
    seedHolding(db, ACCOUNT_ID, aapl, 10_000, TODAY, 1_800_000);
    seedPrice(db, aapl, TODAY, 208);

    // KRW holding: 10 sh @ ₩1,731,000 = ₩17,310,000 notional; cost basis
    // ₩16,329,792. Pre-fix current_value renders as ~17,310,000 (phantom).
    const krw = seedSecurity(db, "402340", { currency: "KRW" });
    seedHolding(db, ACCOUNT_ID, krw, 10, TODAY, 16_329_792);
    seedPrice(db, krw, TODAY, 1_731_000);

    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.000734, asOf: TODAY, source: "test" });

    const rows = getAllHoldings(db);
    const usdRow = rows.find((r) => r.symbol === "AAPL");
    const krwRow = rows.find((r) => r.symbol === "402340");

    expect(usdRow).toBeTruthy();
    expect(krwRow).toBeTruthy();

    // USD control unchanged.
    expect(usdRow!.current_value).toBe(2_080_000);
    expect(usdRow!.unrealized_gain).toBe(2_080_000 - 1_800_000);

    // KRW row valued in USD (₩17,310,000 * 0.000734 ≈ $12,705.54), NOT the
    // won notional ($17,310,000 if FX were never applied).
    const expectedUsdMv = 10 * 1_731_000 * 0.000734;
    const expectedUsdCost = 16_329_792 * 0.000734;
    expect(krwRow!.current_value).toBeCloseTo(expectedUsdMv, 5);
    expect(krwRow!.current_value).toBeLessThan(20_000);
    expect(krwRow!.unrealized_gain).toBeCloseTo(expectedUsdMv - expectedUsdCost, 5);

    // Task 5d: the RAW returned cost_basis field must also be USD, not the
    // won notional (₩16,329,792) — otherwise pct = gain(USD)/cost_basis(KRW)
    // and <Money> rendering both break downstream.
    expect(krwRow!.cost_basis).toBeCloseTo(expectedUsdCost, 5);
    expect(krwRow!.cost_basis).not.toBeCloseTo(16_329_792, 0);
    expect(krwRow!.cost_basis).toBeLessThan(20_000);

    // USD control's returned cost_basis is byte-unchanged.
    expect(usdRow!.cost_basis).toBe(1_800_000);
  });
});

describe("getHoldingsByAccount FX conversion", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1;
  const TODAY = "2026-07-01";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("KRW cost_basis converts to USD; USD control byte-unchanged", () => {
    const aapl = seedSecurity(db, "AAPL", { currency: "USD" });
    seedHolding(db, ACCOUNT_ID, aapl, 100, TODAY, 15_000);

    const krw = seedSecurity(db, "402340", { currency: "KRW" });
    seedHolding(db, ACCOUNT_ID, krw, 10, TODAY, 16_329_792);

    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.0006531, asOf: TODAY, source: "test" });

    const rows = getHoldingsByAccount(db, ACCOUNT_ID);
    const usdRow = rows.find((r) => r.symbol === "AAPL")!;
    const krwRow = rows.find((r) => r.symbol === "402340")!;

    expect(usdRow.cost_basis).toBe(15_000);
    // ₩16,329,792 × 0.0006531 ≈ $10,665 — NOT the $16.3M phantom.
    expect(krwRow.cost_basis).toBeCloseTo(16_329_792 * 0.0006531, 5);
    expect(krwRow.cost_basis).toBeLessThan(20_000);
  });

  it("missing fx_rates row passes native through at rate 1 (never fabricates)", () => {
    const krw = seedSecurity(db, "402340", { currency: "KRW" });
    seedHolding(db, ACCOUNT_ID, krw, 10, TODAY, 16_329_792);
    const rows = getHoldingsByAccount(db, ACCOUNT_ID);
    expect(rows[0].cost_basis).toBe(16_329_792);
  });
});
