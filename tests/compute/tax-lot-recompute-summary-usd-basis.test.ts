import { beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { rehearseTaxLotRecompute } from "@/lib/compute/tax-lot-recompute-summary";
import { getTaxLotSummary } from "@/lib/queries/tax-lots";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seed(symbol: string, currency: string, qty: number, buy: number, sell: number) {
  const accountId = (
    db.prepare("SELECT id FROM accounts WHERE name = 'Vanguard Taxable'").get() as { id: number }
  ).id;
  const sec = db
    .prepare("INSERT INTO securities (symbol, security_type, currency) VALUES (?, 'Stock', ?)")
    .run(symbol, currency).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, '2026-01-02', 'BUY', ?, ?, ?, 0, ?)`
  ).run(accountId, sec, qty, buy, -qty * buy, `buy-${symbol}`);
  return { accountId, sec };
}

describe("recompute preview realized gain basis", () => {
  it("sums USD sales only, discloses excluded non-USD sales, and matches the page tile", () => {
    const a = seed("AAA", "USD", 100, 10, 12);
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, '2026-03-02', 'SELL', 40, 12, 480, 0, 'sell-AAA')`
    ).run(a.accountId, a.sec);
    const z = seed("ZZZ", "JPY", 10, 1000, 1500);
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, '2026-03-03', 'SELL', 10, 1500, 15000, 0, 'sell-ZZZ')`
    ).run(z.accountId, z.sec);
    computeTaxLots(db);

    const row = rehearseTaxLotRecompute(db).years.find((y) => y.taxYear === 2026)!;
    expect(row.realizedGainBefore).toBeCloseTo(80, 6);
    expect(row.realizedGainAfter).toBeCloseTo(80, 6);
    expect(row.nonUsdSalesExcludedBefore).toBe(1);
    expect(row.nonUsdSalesExcludedAfter).toBe(1);
    expect(getTaxLotSummary(db, 2026).totalRealizedGain).toBeCloseTo(row.realizedGainBefore, 6);
  });
});
