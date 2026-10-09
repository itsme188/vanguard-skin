import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { bumpTaxInputGeneration } from "@/lib/compute/tax-convention";

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

function seedTaxLot(
  db: Database.Database,
  accountId: number,
  securityId: number,
  opts: {
    acquisitionDate: string;
    acquisitionPrice: number;
    quantityAcquired: number;
    quantityRemaining: number;
    costBasis: number;
  }
): number {
  const result = db
    .prepare(
      `INSERT INTO tax_lots
         (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      accountId,
      securityId,
      opts.acquisitionDate,
      opts.acquisitionPrice,
      opts.quantityAcquired,
      opts.quantityRemaining,
      opts.costBasis
    );
  return result.lastInsertRowid as number;
}

function seedTaxLotSale(
  db: Database.Database,
  accountId: number,
  securityId: number,
  taxLotId: number,
  opts: {
    saleDate: string;
    quantitySold: number;
    proceeds: number;
    costBasisAllocated: number;
    realizedGainLoss: number;
    isLongTerm?: boolean;
  }
): void {
  const txnId = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, source_key)
       VALUES (?, ?, ?, 'SELL', ?)`
    )
    .run(accountId, securityId, opts.saleDate, `summary-sale-${taxLotId}`)
    .lastInsertRowid as number;
  db.prepare(
    `INSERT INTO tax_lot_sales
       (tax_lot_id, sale_transaction_id, sale_date, sale_price, quantity_sold, proceeds,
        cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    taxLotId,
    txnId,
    opts.saleDate,
    opts.proceeds / opts.quantitySold,
    opts.quantitySold,
    opts.proceeds,
    opts.costBasisAllocated,
    opts.realizedGainLoss,
    opts.isLongTerm === false ? 0 : 1,
    opts.isLongTerm === false ? 100 : 400
  );
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

  it("keeps a statement-only Treasury (older as_of_date) in the holdings block and the allocation/weight denominators when another security in the same account has a newer as_of_date", () => {
    // Statement-only row: TBOND never restates outside the monthly Vanguard
    // statement, so its only holdings row stays at 2025-01-31.
    const bond = seedSecurity(db, "TBOND", "US Treasury Bond", "bond");
    seedHolding(db, ACCOUNT_ID, bond, 10000, "2025-01-31");
    seedPrice(db, bond, "2025-01-31", 98.5);

    // AAPL gets a newer live-sync row in the SAME account. Under a
    // per-account global MAX(as_of_date), this newer date would push the
    // account's "latest" cursor past TBOND's only row and drop it from both
    // the holdings list and the allocation/weight denominators.
    const stock = seedSecurity(db, "AAPL", "Apple Inc", "stock");
    seedHolding(db, ACCOUNT_ID, stock, 100, "2025-02-28");
    seedPrice(db, stock, "2025-02-28", 250);

    const summary = getPortfolioSummaryForChat(db);

    // Holdings block: the Treasury survives.
    expect(summary).toContain("TBOND");
    expect(summary).toContain("MV:$9,850"); // 10000 * 98.5 / 100

    // Allocation denominator: the bond's $9,850 is folded into the
    // portfolio total and the asset-allocation bucket sum, not excluded.
    expect(summary).toContain("bond: $9,850");
    // Weight denominator: AAPL's position weight is diluted by the bond
    // ($25,000 / $34,850 = 71.7%), not 100% as it would be if the bond
    // were silently dropped from portfolio_total.
    expect(summary).toContain("(71.7%)");
    expect(summary).toContain("(28.3%)"); // TBOND's own weight: $9,850 / $34,850
  });

  it("keeps a closed-position tombstone (latest row quantity=0) hidden from holdings", () => {
    const sec = seedSecurity(db, "CLOSEDCO", "Closed Co", "stock");
    seedHolding(db, ACCOUNT_ID, sec, 10, "2025-01-31");
    seedHolding(db, ACCOUNT_ID, sec, 0, "2025-02-28"); // reconciler tombstone
    seedPrice(db, sec, "2025-01-31", 50);

    const summary = getPortfolioSummaryForChat(db);
    expect(summary).not.toContain("CLOSEDCO");
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

  it("excludes currency conversions and expired options from chat tax totals", () => {
    const stock = seedSecurity(db, "ZZSTOCK", "ZZ Stock", "stock");
    seedTaxLot(db, ACCOUNT_ID, stock, {
      acquisitionDate: "2026-01-01",
      acquisitionPrice: 100,
      quantityAcquired: 10,
      quantityRemaining: 10,
      costBasis: 1000,
    });

    const fx = seedSecurity(db, "ZZE.USD", "ZZ Euro conversion", "Forex");
    const fxLot = seedTaxLot(db, ACCOUNT_ID, fx, {
      acquisitionDate: "2026-01-01",
      acquisitionPrice: 100,
      quantityAcquired: 1,
      quantityRemaining: 0,
      costBasis: 100,
    });
    seedTaxLotSale(db, ACCOUNT_ID, fx, fxLot, {
      saleDate: "2026-03-01",
      quantitySold: 1,
      proceeds: 120,
      costBasisAllocated: 100,
      realizedGainLoss: 20,
      isLongTerm: false,
    });

    const expiredOption = seedSecurity(db, "ZZOPT 260101C00050000", "ZZ expired call", "Option");
    db.prepare("UPDATE securities SET multiplier = 100, expiration_date = '2026-01-01' WHERE id = ?").run(expiredOption);
    seedTaxLot(db, ACCOUNT_ID, expiredOption, {
      acquisitionDate: "2025-12-01",
      acquisitionPrice: 2,
      quantityAcquired: 1,
      quantityRemaining: 1,
      costBasis: 200,
    });

    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain("Open lots: 1");
    expect(summary).toContain("cost basis: $1,000");
    expect(summary).toContain("Realized gains: $0");
    expect(summary).not.toContain("ZZOPT");
    expect(summary).not.toContain("$1,200");
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

describe("v2 dollar convention (task 4: readers consume stored tax_lots.cost_basis)", () => {
  let db: Database.Database;
  const ACCOUNT_ID = 1; // Vanguard Taxable

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  function addSecurity(opts: { symbol: string; securityType: string; multiplier?: number }): number {
    const r = db
      .prepare("INSERT INTO securities (symbol, name, security_type, multiplier) VALUES (?, ?, ?, ?)")
      .run(opts.symbol, opts.symbol, opts.securityType, opts.multiplier ?? 1);
    return r.lastInsertRowid as number;
  }

  /** Amount left NULL so netLegDollars derives the true economic dollars
   *  from price×multiplier (options) / ÷100 (bonds) rather than trusting a
   *  raw qty×price `amount`, which is wrong for either convention. */
  function addBuyTxn(secId: number, type: string, date: string, qty: number, price: number): void {
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(ACCOUNT_ID, secId, date, type, qty, price, `test:${type}:${secId}:${date}`);
  }

  it("shows an option lot's tax-summary cost basis at economic dollars (×multiplier), not the raw contract price", () => {
    const optId = addSecurity({ symbol: "AAPL  260619C00180000", securityType: "option", multiplier: 100 });
    addBuyTxn(optId, "BUY_TO_OPEN", "2025-01-15", 1, 2.5);
    computeTaxLots(db);

    const summary = getPortfolioSummaryForChat(db);
    // 1 × 2.50 × 100 = $250 — pre-fix, quantity_remaining * acquisition_price
    // would have read 1 × 2.50 = $2.50.
    expect(summary).toContain("cost basis: $250");
  });

  it("shows a bond lot's tax-summary cost basis at face-adjusted dollars (÷100), not the raw quote", () => {
    const bondId = addSecurity({ symbol: "ZZBILL01", securityType: "bond" });
    addBuyTxn(bondId, "BUY", "2025-01-06", 10000, 98.123456);
    computeTaxLots(db);

    const summary = getPortfolioSummaryForChat(db);
    // Synthetic: 10000 × 98.123456 / 100 = $9,812.35 (rounds to $9,812) — pre-fix,
    // quantity_remaining * acquisition_price would have read ≈$981,235.
    expect(summary).toContain("cost basis: $9,812");
  });

  it("appends the pending-recompute disclaimer only once the convention marker goes stale", () => {
    const secId = addSecurity({ symbol: "STALE", securityType: "stock" });
    addBuyTxn(secId, "BUY", "2025-01-02", 10, 100);
    computeTaxLots(db); // stamps the convention marker current

    expect(getPortfolioSummaryForChat(db)).not.toContain("pending a recompute");

    bumpTaxInputGeneration(db); // a new tax-relevant mutation, no recompute yet
    expect(getPortfolioSummaryForChat(db)).toContain(
      "Note: cost-basis figures are pending a recompute under the corrected dollar convention and may be unit-inconsistent."
    );
  });
});
