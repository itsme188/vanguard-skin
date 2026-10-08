import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";

/**
 * QA findings
 *   header-dataconfidence--valuations-line-counts-zero-quantity-tombstones-as-holdings
 *   dashboard-data-health-snapshot-reconciliation-coverage-column-reconciliation-coverage-counts-closed-zero-share
 *
 * A closed position leaves a `quantity = 0` tombstone row on the snapshot
 * date. The valuation engine read every row on the date and counted each one
 * in `holdings_count` / `priced_count`, so the confidence popover and the
 * Snapshot Reconciliation "Coverage" column counted closed rows as held (and
 * an unpriced closed row as an unpriced position).
 *
 * The fix is COUNTS ONLY: a tombstone is worth zero, so no value changes, and
 * which days get a row does not change either. All figures are synthetic.
 */

const ACCOUNT_ID = 1;

function seedSecurity(db: Database.Database, symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, fund_category) VALUES (?, ?, 'stock', 'US Large Cap Equity')",
    )
    .run(symbol, `${symbol} Inc`).lastInsertRowid as number;
}

function seedHolding(
  db: Database.Database,
  securityId: number,
  quantity: number,
  asOfDate: string,
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(ACCOUNT_ID, securityId, quantity, asOfDate, `tws-test:${securityId}:${asOfDate}`);
}

function seedPrice(db: Database.Database, securityId: number, date: string, price: number): void {
  db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(
    securityId,
    date,
    price,
  );
}

interface ValuationRow {
  holdings_value: number;
  total_value: number;
  holdings_count: number;
  priced_count: number;
  data_quality: string;
}

function valuation(db: Database.Database, date: string): ValuationRow | undefined {
  return db
    .prepare(
      `SELECT holdings_value, total_value, holdings_count, priced_count, data_quality
         FROM daily_valuations WHERE account_id = ? AND valuation_date = ?`,
    )
    .get(ACCOUNT_ID, date) as ValuationRow | undefined;
}

describe("daily valuation — closed (quantity 0) rows are not counted as holdings", () => {
  let db: Database.Database;
  const DAY = "2026-03-02";

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("a priced tombstone is in neither holdings_count nor priced_count", () => {
    const aaa = seedSecurity(db, "AAA");
    const bbb = seedSecurity(db, "BBB");
    const closed = seedSecurity(db, "ZZZ");
    seedHolding(db, aaa, 10, DAY);
    seedHolding(db, bbb, 20, DAY);
    seedHolding(db, closed, 0, DAY);
    seedPrice(db, aaa, DAY, 100);
    seedPrice(db, bbb, DAY, 50);
    seedPrice(db, closed, DAY, 30);

    computeDailyValuations(db);
    const row = valuation(db, DAY)!;

    expect(row.holdings_count).toBe(2);
    expect(row.priced_count).toBe(2);
    // Value math is untouched: 10*100 + 20*50, the tombstone adds zero.
    expect(row.holdings_value).toBe(2_000);
  });

  it("an UNPRICED tombstone does not read as an unpriced position", () => {
    // The 71/83 shape: closed rows with no price made coverage look short.
    const aaa = seedSecurity(db, "AAA");
    const closed = seedSecurity(db, "ZZZ");
    seedHolding(db, aaa, 10, DAY);
    seedHolding(db, closed, 0, DAY);
    seedPrice(db, aaa, DAY, 100);

    computeDailyValuations(db);
    const row = valuation(db, DAY)!;

    expect(row.holdings_count).toBe(1);
    expect(row.priced_count).toBe(1);
    expect(row.holdings_value).toBe(1_000);
  });

  it("a genuinely unpriced OPEN position still counts as held and not priced", () => {
    const aaa = seedSecurity(db, "AAA");
    const bbb = seedSecurity(db, "BBB");
    seedHolding(db, aaa, 10, DAY);
    seedHolding(db, bbb, 20, DAY);
    seedPrice(db, aaa, DAY, 100);

    computeDailyValuations(db);
    const row = valuation(db, DAY)!;

    expect(row.holdings_count).toBe(2);
    expect(row.priced_count).toBe(1);
  });

  it("a short position (negative quantity) is counted", () => {
    const aaa = seedSecurity(db, "AAA");
    const shorted = seedSecurity(db, "SSS");
    seedHolding(db, aaa, 10, DAY);
    seedHolding(db, shorted, -5, DAY);
    seedPrice(db, aaa, DAY, 100);
    seedPrice(db, shorted, DAY, 40);

    computeDailyValuations(db);
    const row = valuation(db, DAY)!;

    expect(row.holdings_count).toBe(2);
    expect(row.priced_count).toBe(2);
    expect(row.holdings_value).toBe(800);
  });

  it("a day whose only rows are priced tombstones still gets its row (counts 0/0), so the series does not gain a hole", () => {
    // Which days are written is value math (Phase 2 attaches cash to these
    // rows) — the count fix must not skip a day it used to write.
    const closed = seedSecurity(db, "ZZZ");
    seedHolding(db, closed, 0, DAY);
    seedPrice(db, closed, DAY, 30);

    computeDailyValuations(db);
    const row = valuation(db, DAY);

    expect(row).toBeDefined();
    expect(row!.holdings_count).toBe(0);
    expect(row!.priced_count).toBe(0);
    expect(row!.holdings_value).toBe(0);
  });
});
