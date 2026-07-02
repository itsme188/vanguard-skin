import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { getAllocationByDimension } from "@/lib/queries/analysis";

let db: Database.Database;

// ─── Seed helpers (mirrors tests/queries/analysis.test.ts, + currency) ────

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

function seedAccount(db: Database.Database, name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  const row = db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as {
    id: number;
  };
  return row.id;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  costBasis: number,
  asOfDate: string = "2026-07-01"
) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, ?)"
  ).run(accountId, securityId, quantity, costBasis, asOfDate);
}

function seedPrice(
  db: Database.Database,
  securityId: number,
  price: number,
  date: string = "2026-07-01"
) {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, close_price, date, source) VALUES (?, ?, ?, 'test')"
  ).run(securityId, price, date);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("Analysis allocation FX", () => {
  it("KRW holding contributes its USD value, not its won notional", () => {
    const acctId = seedAccount(db, "IBKR");

    // USD control: 10,000 sh @ $208 = $2,080,000. Unaffected by the FX join
    // (default currency 'USD' has no fx_rates row; COALESCE(fx.usd_per_unit,1)
    // falls back to 1).
    const aaplId = seedSecurity(db, "AAPL", { currency: "USD" });
    seedHolding(db, acctId, aaplId, 10000, 1_800_000);
    seedPrice(db, aaplId, 208);

    // KRW holding: 10 sh @ ₩1,731,000 = ₩17,310,000 notional.
    const krwId = seedSecurity(db, "402340", { currency: "KRW" });
    seedHolding(db, acctId, krwId, 10, 15000);
    seedPrice(db, krwId, 1_731_000);

    upsertFxRate(db, {
      currency: "KRW",
      usdPerUnit: 0.000734,
      asOf: "2026-07-01",
      source: "test",
    });

    const alloc = getAllocationByDimension(db, "symbol");

    const usdRow = alloc.find((a) => a.group_name === "AAPL");
    const krwRow = alloc.find((a) => a.group_name === "402340");

    expect(usdRow).toBeTruthy();
    expect(krwRow).toBeTruthy();

    // USD control unchanged.
    expect(usdRow!.total_market_value).toBe(2_080_000);

    // KRW row valued in USD (₩17,310,000 * 0.000734 ≈ $12,705.54),
    // NOT the won notional ($17,310,000 if FX were never applied).
    const expectedKrwUsd = 10 * 1_731_000 * 0.000734;
    expect(krwRow!.total_market_value).toBeCloseTo(expectedKrwUsd, 5);
    expect(krwRow!.total_market_value).toBeLessThan(20_000);

    // Allocation total reflects real USD (~$2.09M), NOT the won-as-dollars
    // phantom (~$19.39M = $2.08M + ₩17.31M treated as $17.31M).
    const total = alloc.reduce((sum, a) => sum + a.total_market_value, 0);
    expect(total).toBeCloseTo(2_080_000 + expectedKrwUsd, 5);
    expect(total).toBeGreaterThan(2_000_000);
    expect(total).toBeLessThan(2_200_000);
  });
});
