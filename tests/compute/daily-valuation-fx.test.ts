import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";
import { upsertFxRate } from "@/lib/mutations/fx-rates";

// Seeds one account with a single KRW stock and asserts the day's holdings
// value is FX-converted, not the won notional.
describe("computeDailyValuations FX", () => {
  const ACCOUNT_ID = 1;

  it("values a KRW holding in USD, not won", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    const krwSec = db
      .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, ?, ?)")
      .run("005930", "Samsung Electronics", "stock", "KRW").lastInsertRowid as number;

    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, ?, ?, ?)`
    ).run(ACCOUNT_ID, krwSec, 10, "2026-07-01", `hold-${ACCOUNT_ID}-${krwSec}-2026-07-01`);

    db.prepare(
      "INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
    ).run(krwSec, "2026-07-01", 1_731_000);

    upsertFxRate(db, { currency: "KRW", usdPerUnit: 0.000734, asOf: "2026-07-01", source: "test" });

    computeDailyValuations(db);

    const val = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ? AND valuation_date = '2026-07-01'")
      .get(ACCOUNT_ID) as any;

    // 10 shares * 1,731,000 won * 0.000734 usd/won = 12,705.54 USD, NOT 17,310,000
    expect(val.holdings_value).toBeCloseTo(12_705.54, 1);
    expect(val.total_value).toBeCloseTo(12_705.54, 1);
    expect(val.holdings_value).not.toBeCloseTo(17_310_000, 0);
  });

  it("leaves a USD-only holding unchanged (regression guard)", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    const usdSec = db
      .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)")
      .run("AAPL", "Apple Corp", "stock").lastInsertRowid as number;

    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, ?, ?, ?)`
    ).run(ACCOUNT_ID, usdSec, 10, "2026-07-01", `hold-${ACCOUNT_ID}-${usdSec}-2026-07-01`);

    db.prepare(
      "INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
    ).run(usdSec, "2026-07-01", 150);

    computeDailyValuations(db);

    const val = db
      .prepare("SELECT * FROM daily_valuations WHERE account_id = ? AND valuation_date = '2026-07-01'")
      .get(ACCOUNT_ID) as any;

    expect(val.holdings_value).toBe(1500);
    expect(val.total_value).toBe(1500);
  });
});
