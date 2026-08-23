import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getDataConfidence } from "@/lib/queries/data-confidence";

/**
 * Covers the WS3 universe-correctness bullets for data-confidence.ts: the
 * dimension scorers previously hand-rolled per-account MAX(as_of_date)
 * holdings semantics instead of using the shared latestHoldingsPredicate
 * (lib/queries/latest-holdings.ts), which produced several defective
 * universes — see individual test comments for the specific defect each
 * one targets. Uses the full migrated schema (runMigrations seeds Vanguard
 * Taxable=1, Vanguard Roth IRA=2, IBKR=3).
 */
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function insertSecurity(db: Database.Database, symbol: string): number {
  db.prepare(`INSERT INTO securities (symbol) VALUES (?)`).run(symbol);
  return (db.prepare(`SELECT id FROM securities WHERE symbol = ?`).get(symbol) as { id: number }).id;
}

function insertHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
  sourceKey: string
): void {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, asOfDate, sourceKey);
}

function insertPrice(db: Database.Database, securityId: number, date: string, closePrice: number): void {
  db.prepare(
    `INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)`
  ).run(securityId, date, closePrice);
}

function insertDailyValuation(
  db: Database.Database,
  accountId: number,
  date: string,
  holdingsCount: number,
  pricedCount: number
): void {
  db.prepare(
    `INSERT INTO daily_valuations
       (account_id, valuation_date, cash_balance, holdings_value, total_value, holdings_count, priced_count)
     VALUES (?, ?, 0, 0, 0, ?, ?)`
  ).run(accountId, date, holdingsCount, pricedCount);
}

const NOW = new Date("2026-08-21T16:00:00Z"); // 2026-08-21 in ET, well within the trading day

describe("data-confidence universes (latest-holdings predicate)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("a carried position under a fresher live row stays in the price-freshness universe", () => {
    // Account has a statement AAPL holding as_of 2026-07-31 and a TWS MSFT
    // row as_of 2026-08-20 — the old per-account MAX(as_of_date) join would
    // only see MSFT (the account's max date) and silently drop AAPL from
    // totalHeld, even though AAPL is still a currently-held position.
    const aapl = insertSecurity(db, "AAPL");
    const msft = insertSecurity(db, "MSFT");
    insertHolding(db, 1, aapl, 10, "2026-07-31", "canonical:hold:TAX:AAPL:2026-07-31");
    insertHolding(db, 1, msft, 5, "2026-08-20", "tws-1-msft-2026-08-20");

    const { priceFreshness } = getDataConfidence(db, NOW);
    expect(priceFreshness.totalHeld).toBe(2);
  });

  it("shorts are in the universe (quantity != 0)", () => {
    const spy = insertSecurity(db, "SPY");
    insertHolding(db, 3, spy, -50, "2026-08-20", "tws-3-spy-2026-08-20");

    const { priceFreshness } = getDataConfidence(db, NOW);
    expect(priceFreshness.totalHeld).toBe(1);
  });

  it("a sold-out position can never be the stalest symbol", () => {
    // XYZ was held (qty>0) back on 2026-06-01 with an ancient price, then
    // fully sold — the latest row for (account, XYZ) is qty=0 as_of
    // 2026-08-01. The old stalest query joined ANY holdings row with
    // quantity > 0 (no "latest" filter at all), so the long-sold, long-stale
    // XYZ row would still win "stalest" forever.
    const xyz = insertSecurity(db, "XYZ");
    insertPrice(db, xyz, "2026-06-01", 10);
    insertHolding(db, 1, xyz, 100, "2026-06-01", "canonical:hold:TAX:XYZ:2026-06-01");
    insertHolding(db, 1, xyz, 0, "2026-08-01", "canonical:hold:TAX:XYZ:2026-08-01");

    // A currently-held, recently-priced security so the universe isn't empty.
    const aapl = insertSecurity(db, "AAPL");
    insertPrice(db, aapl, "2026-08-20", 200);
    insertHolding(db, 1, aapl, 10, "2026-08-20", "canonical:hold:TAX:AAPL:2026-08-20");

    const { priceFreshness } = getDataConfidence(db, NOW);
    expect(priceFreshness.stalestSymbol).not.toContain("XYZ");
  });

  it("a held security with NO price rows IS the stalest (LEFT JOIN, missing-first)", () => {
    const noPrice = insertSecurity(db, "NOPRICE");
    insertHolding(db, 1, noPrice, 10, "2026-08-15", "canonical:hold:TAX:NOPRICE:2026-08-15");

    const hasPrice = insertSecurity(db, "HASPRICE");
    insertPrice(db, hasPrice, "2026-08-16", 50); // 5 days stale as of NOW, but it HAS a price
    insertHolding(db, 1, hasPrice, 10, "2026-08-20", "canonical:hold:TAX:HASPRICE:2026-08-20");

    const { priceFreshness } = getDataConfidence(db, NOW);
    expect(priceFreshness.stalestSymbol).toContain("NOPRICE");
    expect(priceFreshness.stalestSymbol).toContain("no price rows");
    // "no price rows" falls back to the holding's own age: 2026-08-21 - 2026-08-15 = 6 days.
    expect(priceFreshness.stalestDays).toBe(6);
  });

  it("holdings recency is per (account, security): one fresh TWS row does not make the account read today", () => {
    const aapl = insertSecurity(db, "AAPL");
    const msft = insertSecurity(db, "MSFT");
    insertHolding(db, 1, aapl, 10, "2026-06-22", "canonical:hold:TAX:AAPL:2026-06-22"); // 60 days old
    insertHolding(db, 1, msft, 5, "2026-08-21", "tws-1-msft-2026-08-21"); // today

    const { holdingsRecency } = getDataConfidence(db, NOW);
    const taxable = holdingsRecency.perAccount.find((a) => a.name === "Vanguard Taxable");
    expect(taxable).toBeDefined();
    expect(taxable!.daysOld).toBe(60);
    expect(taxable!.source).toBe("statement");
  });

  it("valuation coverage sums per-account latest rows; an account with holdings but no valuation row counts as unpriced", () => {
    const aapl = insertSecurity(db, "AAPL");
    const msft = insertSecurity(db, "MSFT");
    insertHolding(db, 1, aapl, 10, "2026-08-20", "canonical:hold:TAX:AAPL:2026-08-20");
    insertHolding(db, 1, msft, 5, "2026-08-20", "canonical:hold:TAX:MSFT:2026-08-20");
    insertDailyValuation(db, 1, "2026-08-20", 2, 2); // fully priced

    const spy = insertSecurity(db, "SPY");
    insertHolding(db, 2, spy, 3, "2026-08-19", "canonical:hold:ROTH:SPY:2026-08-19");
    // No daily_valuations row at all for account 2.

    const { valuationCoverage } = getDataConfidence(db, NOW);
    expect(valuationCoverage.totalCount).toBe(3);
    expect(valuationCoverage.pricedCount).toBe(2);
    expect(valuationCoverage.perAccountAsOf).toEqual(
      expect.arrayContaining([
        { accountName: "Vanguard Taxable", asOfDate: "2026-08-20" },
        { accountName: "Vanguard Roth IRA", asOfDate: null },
      ])
    );
  });

  it("evening ET boundary: at 2026-08-23T23:30-04:00 the staleness baseline is 2026-08-23, not -24", () => {
    const aapl = insertSecurity(db, "AAPL");
    insertHolding(db, 1, aapl, 10, "2026-08-23", "canonical:hold:TAX:AAPL:2026-08-23");

    const { holdingsRecency } = getDataConfidence(db, new Date("2026-08-24T03:30:00Z"));
    const taxable = holdingsRecency.perAccount.find((a) => a.name === "Vanguard Taxable");
    expect(taxable).toBeDefined();
    expect(taxable!.daysOld).toBe(0);
  });
});
