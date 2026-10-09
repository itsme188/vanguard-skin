import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { getPortfolioTotals, getPortfolioCurrentValues } from "@/lib/queries/dashboard";
import { formatUSD } from "@/lib/format";

/**
 * Owner ruling 2026-10-08: the chat reads the Portfolio strip's total.
 * All figures are invented round numbers.
 */

let db: Database.Database;
// Migration 002 seeds: Vanguard Taxable (1), Vanguard Roth IRA (2), IBKR (3).

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function seedSnapshot(accountId: number, date: string, value: number, source = "manual"): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots (account_id, month_end_date, total_value, source)
     VALUES (?, ?, ?, ?)`,
  ).run(accountId, date, value, source);
}

function seedDaily(accountId: number, date: string, value: number): void {
  db.prepare(
    `INSERT INTO daily_valuations (account_id, valuation_date, total_value, holdings_value, cash_balance)
     VALUES (?, ?, ?, ?, 0)`,
  ).run(accountId, date, value, value);
}

/** The strip treats a live row as current when dated within a day of SQLite's own "now". */
function sqliteToday(): string {
  return (db.prepare("SELECT date('now') AS d").get() as { d: string }).d;
}

/** A mixed book: one account on a statement, one on a daily valuation, one on a live row. */
function seedMixedBook(): { live: string } {
  const live = sqliteToday();
  seedSnapshot(1, "2025-01-31", 100000);
  seedSnapshot(2, "2025-01-31", 40000);
  seedDaily(2, "2025-02-10", 42000);
  seedSnapshot(3, "2025-01-31", 200000);
  seedSnapshot(3, live, 230000, "tws");
  return { live };
}

describe("chat summary total is the Portfolio strip's total", () => {
  it("equals getPortfolioTotals' total and date for a mixed book", () => {
    const { live } = seedMixedBook();
    const strip = getPortfolioTotals(db);
    expect(strip.totalValue).toBe(372000);
    expect(strip.latestDate).toBe(live);

    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain(`**Total Portfolio**: ${formatUSD(strip.totalValue)} (as of ${strip.latestDate}`);
    // The old total summed each account's latest monthly snapshot row.
    expect(summary).not.toContain(`**Total Portfolio**: ${formatUSD(370000)}`);
  });

  it("keeps a per-account freshness footnote: each account's own date and kind of source", () => {
    const { live } = seedMixedBook();
    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain(`- Vanguard Taxable: ${formatUSD(100000)} (as of 2025-01-31, statement)`);
    expect(summary).toContain(`- Vanguard Roth IRA: ${formatUSD(42000)} (as of 2025-02-10, daily valuation)`);
    expect(summary).toContain(`- IBKR: ${formatUSD(230000)} (as of ${live}, live broker value)`);
    // The total is labelled with the newest date, and the summary says the
    // accounts are not all valued on it.
    expect(summary).toMatch(/oldest account value is dated 2025-01-31/);
  });

  it("an old live row is not the current value (the strip's rule)", () => {
    seedSnapshot(3, "2025-01-31", 200000);
    seedSnapshot(3, "2025-02-14", 230000, "tws");
    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain(`- IBKR: ${formatUSD(200000)} (as of 2025-01-31, statement)`);
    expect(getPortfolioTotals(db).totalValue).toBe(200000);
  });

  it("a scoped call totals only its own account", () => {
    seedMixedBook();
    const summary = getPortfolioSummaryForChat(db, "Vanguard Roth IRA");
    expect(summary).toContain(`**Total Portfolio**: ${formatUSD(42000)} (as of 2025-02-10`);
    expect(summary).not.toContain("IBKR:");
    expect(summary).not.toContain(formatUSD(230000));
    expect(summary).not.toContain(formatUSD(372000));
  });

  it("an account name that matches nothing shows no account value (never widened)", () => {
    seedMixedBook();
    const summary = getPortfolioSummaryForChat(db, "No Such Account");
    expect(summary).not.toContain("Total Portfolio");
    expect(summary).not.toContain(formatUSD(372000));
  });
});

describe("getPortfolioCurrentValues (the one per-account selection)", () => {
  it("unscoped totals are getPortfolioTotals' totals", () => {
    seedMixedBook();
    const strip = getPortfolioTotals(db);
    const values = getPortfolioCurrentValues(db);
    expect(values.totalValue).toBe(strip.totalValue);
    expect(values.totalPreviousValue).toBe(strip.totalPreviousValue);
    expect(values.latestDate).toBe(strip.latestDate);
    expect(values.oldestDate).toBe(strip.oldestDate);
    expect(values.accounts.map((a) => a.sourceKind)).toEqual(["statement", "daily", "live"]);
  });

  it("a scope sums only its accounts; an empty scope is empty", () => {
    seedMixedBook();
    const two = getPortfolioCurrentValues(db, [1, 2]);
    expect(two.totalValue).toBe(142000);
    expect(two.latestDate).toBe("2025-02-10");
    expect(two.accounts.map((a) => a.accountName)).toEqual(["Vanguard Taxable", "Vanguard Roth IRA"]);
    const none = getPortfolioCurrentValues(db, []);
    expect(none.totalValue).toBe(0);
    expect(none.accounts).toEqual([]);
    expect(none.latestDate).toBeNull();
  });

  it("an account with no value has a null value, date and source kind", () => {
    const values = getPortfolioCurrentValues(db);
    expect(values.accounts).toHaveLength(3);
    expect(values.accounts[0]).toMatchObject({ currentValue: null, asOfDate: null, sourceKind: null });
  });
});
