import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertSecurity } from "@/lib/mutations/securities";
import { mapPlaidHoldings } from "@/lib/plaid/map-holdings";
import { writePlaidHoldings } from "@/lib/plaid/refresh";
import type { PlaidHolding, PlaidHoldingsResponse, PlaidSecurity } from "@/lib/plaid/client";
import { latestHoldingsPredicate } from "@/lib/queries/latest-holdings";
import { statementOverwritableHoldingSql } from "@/lib/db/holding-sources";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";

// Synthetic symbols and round numbers only.
const STMT_DATE = "2026-06-30";
const DAY1 = "2026-07-13"; // Mon
const DAY2 = "2026-07-14"; // Tue
const ACCOUNT_TOTAL = 20000;

let db: Database.Database;
let acct: number;
let mmId: number;
let stockId: number;

function freshDb(): void {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare(`INSERT OR IGNORE INTO accounts (name) VALUES ('Vanguard Taxable')`).run();
  acct = (db.prepare(`SELECT id FROM accounts WHERE name = 'Vanguard Taxable'`).get() as { id: number }).id;
  // A money-market fund classified the way production stores one
  // (type 'Mutual Fund', fund_category 'Cash Equivalent').
  mmId = upsertSecurity(db, { symbol: "ZMMXX", securityType: "Mutual Fund" });
  db.prepare(`UPDATE securities SET fund_category = 'Cash Equivalent' WHERE id = ?`).run(mmId);
  stockId = upsertSecurity(db, { symbol: "ZSTK", securityType: "Stock" });
  // Last month's statement: the stock and 5,000 in the fund.
  const stmt = db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, NULL, ?, ?)`,
  );
  stmt.run(acct, stockId, 100, STMT_DATE, `vanguard-pdf:holding:${acct}:${stockId}`);
  stmt.run(acct, mmId, 5000, STMT_DATE, `vanguard-pdf:holding:${acct}:${mmId}`);
}

beforeEach(freshDb);

function holding(id: string, quantity: number, price: number): PlaidHolding {
  return {
    account_id: "pTax",
    security_id: id,
    quantity,
    institution_price: price,
    institution_value: price * quantity,
    institution_price_as_of: null,
  };
}

const STOCK: PlaidSecurity = { security_id: "s", ticker_symbol: "ZSTK", cusip: null, name: "Z Stock", type: "equity", is_cash_equivalent: false };
const MM_FLAGGED: PlaidSecurity = { security_id: "m", ticker_symbol: "ZMMXX", cusip: null, name: "Z Money Market", type: "mutual fund", is_cash_equivalent: true };
const MM_UNFLAGGED: PlaidSecurity = { ...MM_FLAGGED, is_cash_equivalent: false };

function resp(holdings: PlaidHolding[], securities: PlaidSecurity[]): PlaidHoldingsResponse {
  return {
    accounts: [{ account_id: "pTax", name: "Brokerage", mask: "0000", subtype: "brokerage", balances: { current: ACCOUNT_TOTAL, available: null } }],
    holdings,
    securities,
  };
}

/** Stock 100 x 100 = 10,000 plus the fund at 1.00. */
function dayPayload(mmQty: number | null, mm: PlaidSecurity = MM_FLAGGED): PlaidHoldingsResponse {
  const holdings = [holding("s", 100, 100)];
  if (mmQty != null) holdings.push(holding("m", mmQty, 1));
  return resp(holdings, mmQty != null ? [STOCK, mm] : [STOCK]);
}

function write(r: PlaidHoldingsResponse, day: string) {
  return writePlaidHoldings(db, mapPlaidHoldings(r), { pTax: acct }, day);
}

function currentRows(securityId: number): { quantity: number; as_of_date: string; source_key: string }[] {
  return db
    .prepare(
      `SELECT h.quantity, h.as_of_date, h.source_key FROM holdings h
        WHERE ${latestHoldingsPredicate({ accountFilter: "AND h.account_id = ?" })} AND h.security_id = ?`,
    )
    .all(acct, securityId) as { quantity: number; as_of_date: string; source_key: string }[];
}

function snapshot(day: string) {
  return db
    .prepare(`SELECT total_value, cash_value FROM monthly_snapshots WHERE account_id = ? AND month_end_date = ?`)
    .get(acct, day) as { total_value: number; cash_value: number | null };
}

function valuation(day: string) {
  return db
    .prepare(
      `SELECT total_value, cash_balance, holdings_value FROM daily_valuations WHERE account_id = ? AND valuation_date = ?`,
    )
    .get(acct, day) as { total_value: number; cash_balance: number; holdings_value: number };
}

describe("money-market balance from Plaid", () => {
  it("a Plaid-flagged fund refreshes its own row from Plaid's balance; cash_value is unchanged", () => {
    const r = write(dayPayload(6000), DAY1);
    expect(r.cashEquivalentRowsWritten).toBe(1);
    expect(r.holdingsWritten).toBe(1); // the stock only: the fund is not a position
    // Before: the current row was the 5,000 statement row. After: Plaid's 6,000.
    expect(currentRows(mmId)).toEqual([
      { quantity: 6000, as_of_date: DAY1, source_key: `plaid:${acct}:${mmId}:${DAY1}` },
    ]);
    expect(snapshot(DAY1)).toEqual({ total_value: ACCOUNT_TOTAL, cash_value: 6000 });
  });

  it("conservation: the daily total, cash and holdings are identical with and without the new fund row", () => {
    const tws = db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 100, 'tws')`);
    tws.run(stockId, STMT_DATE);
    tws.run(stockId, DAY1);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 1, 'vanguard-pdf')`).run(mmId, STMT_DATE);

    write(dayPayload(6000), DAY1);
    computeDailyValuations(db);
    const withRow = valuation(DAY1);
    const snapWith = snapshot(DAY1);

    // Same payload, the new row removed: what the old code left behind.
    db.prepare(`DELETE FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?`).run(acct, mmId, DAY1);
    computeDailyValuations(db);
    const withoutRow = valuation(DAY1);

    expect(withRow).toEqual(withoutRow);
    expect(withRow.total_value).toBeCloseTo(ACCOUNT_TOTAL, 2);
    expect(withRow.holdings_value).toBeCloseTo(10000, 2); // the fund is never a holding
    expect(withRow.cash_balance).toBeCloseTo(10000, 2);
    expect(snapshot(DAY1)).toEqual(snapWith);
  });

  it("a fund Plaid stops reporting reads zero, never its last value or the statement's", () => {
    write(dayPayload(6000), DAY1);
    const r = write(dayPayload(null), DAY2);
    expect(r.cashEquivalentRetired).toBe(1);
    expect(currentRows(mmId)).toEqual([]);
    const day2 = db
      .prepare(`SELECT quantity FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?`)
      .get(acct, mmId, DAY2) as { quantity: number };
    expect(day2.quantity).toBe(0);
    // A later run that still omits it writes nothing more (idempotent).
    const again = write(dayPayload(null), "2026-07-15");
    expect(again.cashEquivalentRetired).toBe(0);
    expect(currentRows(mmId)).toEqual([]);
  });

  it("a fund Plaid reports at zero reads zero", () => {
    write(dayPayload(6000), DAY1);
    write(dayPayload(0), DAY2);
    expect(currentRows(mmId)).toEqual([]);
    expect(snapshot(DAY2).cash_value).toBeNull(); // a zero adds no cash line
  });

  it("a fund whose current row is the statement's is left alone when Plaid omits it", () => {
    // Plaid may report it inside its generic cash line; the next statement settles it.
    const r = write(dayPayload(null), DAY1);
    expect(r.cashEquivalentRetired).toBe(0);
    expect(currentRows(mmId)).toEqual([
      { quantity: 5000, as_of_date: STMT_DATE, source_key: `vanguard-pdf:holding:${acct}:${mmId}` },
    ]);
  });

  it("statement wins on a statement date, and a later statement import still writes its own row", () => {
    // A statement row already on the run day: Plaid cannot claim it.
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 7000, NULL, ?, 'vanguard-pdf:holding:same-day')`,
    ).run(acct, mmId, DAY1);
    const r = write(dayPayload(6000), DAY1);
    expect(r.cashEquivalentRowsWritten).toBe(0);
    expect(currentRows(mmId)[0]).toMatchObject({ quantity: 7000, source_key: "vanguard-pdf:holding:same-day" });

    // Plaid writes DAY2 first; the statement for DAY2 arrives later and
    // overwrites it through the import engine's own upsert guard.
    write(dayPayload(6500), DAY2);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 6400, NULL, ?, 'vanguard-pdf:holding:later')
       ON CONFLICT(account_id, security_id, as_of_date) DO UPDATE SET
         quantity = excluded.quantity, source_key = excluded.source_key
       WHERE ${statementOverwritableHoldingSql()}`,
    ).run(acct, mmId, DAY2);
    expect(currentRows(mmId)).toEqual([
      { quantity: 6400, as_of_date: DAY2, source_key: "vanguard-pdf:holding:later" },
    ]);
  });

  it("an unflagged money-market fund (an ordinary 'mutual fund' position) keeps one row and stays out of cash", () => {
    const r = write(dayPayload(6000, MM_UNFLAGGED), DAY1);
    expect(r.cashEquivalentRowsWritten).toBe(0);
    expect(r.holdingsWritten).toBe(2);
    const day1Rows = db
      .prepare(`SELECT COUNT(*) AS c FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?`)
      .get(acct, mmId, DAY1) as { c: number };
    expect(day1Rows.c).toBe(1);
    expect(currentRows(mmId)[0]).toMatchObject({ quantity: 6000, as_of_date: DAY1 });
    expect(snapshot(DAY1).cash_value).toBeNull();
    // And when Plaid stops reporting it, it is retired the same way.
    write(dayPayload(null), DAY2);
    expect(currentRows(mmId)).toEqual([]);
  });

  it("a Plaid-flagged fund the shared rule does not call cash gets no row (never both position and cash)", () => {
    db.prepare(`UPDATE securities SET fund_category = NULL WHERE id = ?`).run(mmId);
    const r = write(dayPayload(6000), DAY1);
    expect(r.cashEquivalentSkipped).toEqual(["ZMMXX"]);
    expect(r.cashEquivalentRowsWritten).toBe(0);
    expect(currentRows(mmId)[0]).toMatchObject({ as_of_date: STMT_DATE });
    expect(snapshot(DAY1).cash_value).toBe(6000);
  });

  it("a Plaid-flagged fund with no stored security is not created", () => {
    const other: PlaidSecurity = { ...MM_FLAGGED, security_id: "n", ticker_symbol: "ZNEWX" };
    const r = write(resp([holding("s", 100, 100), holding("n", 300, 1)], [STOCK, other]), DAY1);
    expect(r.cashEquivalentSkipped).toEqual(["ZNEWX"]);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM securities WHERE symbol = 'ZNEWX'`).get()).toEqual({ c: 0 });
  });
});
