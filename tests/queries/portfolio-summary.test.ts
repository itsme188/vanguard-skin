import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";

function seedSecurity(
  db: Database.Database,
  symbol: string,
  name?: string,
  securityType?: string
): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)"
    )
    .run(symbol, name ?? symbol + " Corp", securityType ?? null);
  return result.lastInsertRowid as number;
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    accountId,
    securityId,
    quantity,
    asOfDate,
    `hold-${accountId}-${securityId}-${asOfDate}`
  );
}

function seedPrice(
  db: Database.Database,
  securityId: number,
  date: string,
  price: number
): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
  ).run(securityId, date, price);
}

function seedSnapshot(
  db: Database.Database,
  accountId: number,
  monthEnd: string,
  totalValue: number
): void {
  db.prepare(
    `INSERT OR REPLACE INTO monthly_snapshots (account_id, month_end_date, total_value)
     VALUES (?, ?, ?)`
  ).run(accountId, monthEnd, totalValue);
}

describe("getPortfolioSummaryForChat", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1; // Vanguard Taxable

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("includes all accounts in summary", () => {
    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain("Vanguard Taxable");
    expect(summary).toContain("Vanguard Roth IRA");
    expect(summary).toContain("IBKR");
    expect(summary).toContain("No data yet");
  });

  it("shows account values from snapshots", () => {
    seedSnapshot(db, ACCOUNT_ID, "2025-01-31", 100000);
    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain("$100,000");
    expect(summary).toContain("as of 2025-01-31");
  });

  it("shows holdings with price data", () => {
    const sec = seedSecurity(db, "VTI", "Vanguard Total Market");
    seedHolding(db, ACCOUNT_ID, sec, 100, "2025-01-31");
    seedPrice(db, sec, "2025-01-31", 250);

    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain("VTI");
    expect(summary).toContain("100");
    // New format: MV:$25,000 instead of "@ $250"
    expect(summary).toContain("MV:$25,000");
  });

  it("shows holdings without prices (no MV)", () => {
    const sec = seedSecurity(db, "MYSTERY");
    seedHolding(db, ACCOUNT_ID, sec, 50, "2025-01-31");

    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain("MYSTERY");
    // Unpriced holdings just show quantity, no MV
    expect(summary).toContain("50 shares");
  });

  it("returns null market_value for holdings without prices (not $0)", () => {
    const sec = seedSecurity(db, "NOPRICE");
    seedHolding(db, ACCOUNT_ID, sec, 100, "2025-01-31");

    // Also seed a holding WITH a price so we can verify the total
    const sec2 = seedSecurity(db, "PRICED");
    seedHolding(db, ACCOUNT_ID, sec2, 10, "2025-01-31");
    seedPrice(db, sec2, "2025-01-31", 100);

    const summary = getPortfolioSummaryForChat(db);
    // Should NOT contain "$0" for the unpriced holding
    // The PRICED holding should show $1,000 market value
    expect(summary).toContain("MV:$1,000");
    // NOPRICE should not have any market value shown
    expect(summary).not.toContain("MV:$0");
  });

  it("includes data quality warning when holdings lack prices", () => {
    const sec = seedSecurity(db, "MYSTERY");
    seedHolding(db, ACCOUNT_ID, sec, 50, "2025-01-31");

    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain("Data Quality Notes");
    expect(summary).toContain("no price data");
    expect(summary).toContain("MYSTERY");
  });

  it("applies bond market value correctly (quantity * price / 100)", () => {
    const bond = seedSecurity(db, "TBILL", "Treasury Bill", "bond");
    seedHolding(db, ACCOUNT_ID, bond, 10000, "2025-01-31");
    seedPrice(db, bond, "2025-01-31", 98.5);

    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain("TBILL");
    expect(summary).toContain("face"); // "face" unit label for bonds
    // Bond: 10000 * 98.5 / 100 = 9,850
    expect(summary).toContain("$9,850");
  });

  it("includes recent transactions", () => {
    db.prepare(
      `INSERT INTO transactions (account_id, trade_date, type, amount, source_key)
       VALUES (?, ?, ?, ?, ?)`
    ).run(ACCOUNT_ID, "2025-01-15", "DEPOSIT", 5000, "txn-test-1");

    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain("Recent Transactions");
    expect(summary).toContain("DEPOSIT");
    expect(summary).toContain("$5,000");
  });

  it("includes tax summary when lots exist", () => {
    const sec = seedSecurity(db, "VTI");
    db.prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(ACCOUNT_ID, sec, "2025-01-01", 200, 10, 10, 2000);

    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain("Tax Summary");
    expect(summary).toContain("Open lots: 1");
    expect(summary).toContain("cost basis: $2,000");
  });
});

describe("account-filtered summary", () => {
  let db: Database.Database;
  const VANGUARD_TAXABLE_ID = 1;
  const ROTH_IRA_ID = 2;
  const IBKR_ID = 3;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    // Seed holdings in two different accounts
    const vti = seedSecurity(db, "VTI", "Vanguard Total Market");
    const aapl = seedSecurity(db, "AAPL", "Apple Inc");
    seedHolding(db, VANGUARD_TAXABLE_ID, vti, 100, "2025-01-31");
    seedHolding(db, IBKR_ID, aapl, 50, "2025-01-31");
    seedPrice(db, vti, "2025-01-31", 250);
    seedPrice(db, aapl, "2025-01-31", 200);
    seedSnapshot(db, VANGUARD_TAXABLE_ID, "2025-01-31", 25000);
    seedSnapshot(db, IBKR_ID, "2025-01-31", 10000);
  });

  it("filters to single account when accountName provided", () => {
    const summary = getPortfolioSummaryForChat(db, "IBKR");
    expect(summary).toContain("AAPL");
    expect(summary).not.toContain("VTI");
    // Should only show IBKR account value
    expect(summary).toContain("IBKR");
    expect(summary).not.toContain("Vanguard Taxable");
  });

  it("shows all accounts when no accountName provided", () => {
    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain("VTI");
    expect(summary).toContain("AAPL");
    expect(summary).toContain("IBKR");
    expect(summary).toContain("Vanguard Taxable");
  });

  it("computes position weights relative to filtered account total", () => {
    // AAPL is 100% of IBKR, not 100*200/(100*250+50*200) = 28.6% of portfolio
    const summary = getPortfolioSummaryForChat(db, "IBKR");
    expect(summary).toContain("100.0%");
  });
});
