import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  generateTaxReport,
  generateForm8949CSV,
  generateTXF,
  buildTaxReportFilename,
  washSaleAdvisory,
  type Form8949Row,
} from "@/lib/compute/tax-report";
import { stampBrokerAcceptance, stampTaxLotsConvention } from "@/lib/compute/tax-convention";

/**
 * Account-scoped tax report (QA finding
 * tax-lots--account-filter-ignored-by-tax-report-card-and-exports).
 *
 * The Tax Lots page's ?account= filter narrowed the headline tiles, Open
 * Lots and Closed Sales tables but NOT the TAX REPORT card or the CSV/TXF
 * downloads — a Roth-filtered page offered a "form-8949-<year>.csv" that
 * held only Taxable rows. These tests pin the scoped behaviour, the
 * fail-closed filing gate under a filter, and the conservation identity
 * (Σ per-account = all-accounts) that makes a partial export provably a
 * subset rather than a differently-computed number.
 */

const YEAR = 2022;

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE securities (
      id INTEGER PRIMARY KEY,
      symbol TEXT NOT NULL UNIQUE,
      name TEXT,
      security_type TEXT DEFAULT 'stock',
      multiplier REAL DEFAULT 1,
      currency TEXT NOT NULL DEFAULT 'USD'
    );

    CREATE TABLE tax_lots (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      security_id INTEGER NOT NULL,
      acquisition_date TEXT NOT NULL,
      acquisition_price REAL NOT NULL,
      quantity_acquired REAL NOT NULL,
      quantity_remaining REAL NOT NULL DEFAULT 0,
      cost_basis REAL NOT NULL,
      is_from_opening_snapshot INTEGER NOT NULL DEFAULT 0,
      is_short INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (security_id) REFERENCES securities(id)
    );

    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL,
      security_id INTEGER,
      trade_date TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity REAL,
      price_per_share REAL,
      amount REAL,
      fees REAL DEFAULT 0,
      FOREIGN KEY (account_id) REFERENCES accounts(id)
    );

    CREATE TABLE tax_lot_sales (
      id INTEGER PRIMARY KEY,
      tax_lot_id INTEGER NOT NULL,
      sale_transaction_id INTEGER,
      sale_date TEXT NOT NULL,
      quantity_sold REAL NOT NULL,
      sale_price REAL NOT NULL,
      proceeds REAL NOT NULL,
      cost_basis_allocated REAL NOT NULL,
      realized_gain_loss REAL NOT NULL,
      is_long_term INTEGER NOT NULL DEFAULT 0,
      holding_period_days INTEGER NOT NULL DEFAULT 0,
      premium_rollover INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (tax_lot_id) REFERENCES tax_lots(id),
      FOREIGN KEY (sale_transaction_id) REFERENCES transactions(id)
    );
  `);

  db.exec(`
    INSERT INTO accounts (id, name) VALUES
      (1, 'Taxable'),
      (2, 'Vanguard Roth IRA'),
      (3, 'IBKR');
    INSERT INTO securities (id, symbol, name, currency) VALUES
      (1, 'AAPL', 'Apple Inc.', 'USD'),
      (2, 'MSFT', 'Microsoft Corp.', 'USD'),
      (3, 'SHOP', 'Shopify Inc.', 'CAD');
  `);

  return db;
}

function addSale(
  db: Database.Database,
  opts: {
    accountId: number;
    securityId: number;
    acquisitionDate: string;
    saleDate: string;
    quantity: number;
    acquisitionPrice: number;
    salePrice: number;
    isLongTerm?: boolean;
    txnType?: string;
    premiumRollover?: boolean;
  }
) {
  const costBasis = opts.quantity * opts.acquisitionPrice;
  const proceeds = opts.quantity * opts.salePrice;
  const gain = proceeds - costBasis;
  const holdingDays = Math.round(
    (new Date(opts.saleDate).getTime() - new Date(opts.acquisitionDate).getTime()) /
      (24 * 3600 * 1000)
  );

  const lot = db
    .prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    )
    .run(
      opts.accountId,
      opts.securityId,
      opts.acquisitionDate,
      opts.acquisitionPrice,
      opts.quantity,
      costBasis
    );

  const txn = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.accountId,
      opts.securityId,
      opts.saleDate,
      opts.txnType ?? "SELL",
      opts.quantity,
      opts.salePrice,
      proceeds
    );

  db.prepare(
    `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days, premium_rollover)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    lot.lastInsertRowid,
    txn.lastInsertRowid,
    opts.saleDate,
    opts.quantity,
    opts.salePrice,
    proceeds,
    costBasis,
    gain,
    (opts.isLongTerm ?? holdingDays > 365) ? 1 : 0,
    holdingDays,
    opts.premiumRollover ? 1 : 0
  );
}

/** An open (unsold) lot — feeds the 30-day wash-sale repurchase scan. */
function addPurchase(
  db: Database.Database,
  opts: { accountId: number; securityId: number; date: string; quantity: number; price: number }
) {
  db.prepare(
    `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    opts.accountId,
    opts.securityId,
    opts.date,
    opts.price,
    opts.quantity,
    opts.quantity,
    opts.quantity * opts.price
  );
}

/** Three accounts, both terms, a wash sale, a non-USD sale, plus rows the
 *  filingOnly filter must keep out of every scope. */
function seedMultiAccountYear(db: Database.Database) {
  // Taxable — short-term gain
  addSale(db, {
    accountId: 1,
    securityId: 1,
    acquisitionDate: "2022-01-10",
    saleDate: "2022-04-10",
    quantity: 10,
    acquisitionPrice: 100,
    salePrice: 130,
  });
  // Taxable — long-term gain
  addSale(db, {
    accountId: 1,
    securityId: 2,
    acquisitionDate: "2020-02-01",
    saleDate: "2022-05-01",
    quantity: 20,
    acquisitionPrice: 50,
    salePrice: 90,
    isLongTerm: true,
  });
  // Taxable — short-term LOSS with a repurchase 10 days later (wash sale)
  addSale(db, {
    accountId: 1,
    securityId: 1,
    acquisitionDate: "2022-06-01",
    saleDate: "2022-08-01",
    quantity: 5,
    acquisitionPrice: 200,
    salePrice: 150,
  });
  addPurchase(db, { accountId: 1, securityId: 1, date: "2022-08-11", quantity: 5, price: 155 });

  // Roth — long-term gain
  addSale(db, {
    accountId: 2,
    securityId: 1,
    acquisitionDate: "2019-03-15",
    saleDate: "2022-07-20",
    quantity: 7,
    acquisitionPrice: 40,
    salePrice: 145,
    isLongTerm: true,
  });
  // Roth — short-term loss (no repurchase within 30 days anywhere)
  addSale(db, {
    accountId: 2,
    securityId: 2,
    acquisitionDate: "2022-02-02",
    saleDate: "2022-03-02",
    quantity: 3,
    acquisitionPrice: 300,
    salePrice: 250,
  });

  // IBKR — non-USD sale (row exported, excluded from USD totals)
  addSale(db, {
    accountId: 3,
    securityId: 3,
    acquisitionDate: "2022-01-05",
    saleDate: "2022-09-05",
    quantity: 12,
    acquisitionPrice: 30,
    salePrice: 44,
  });
  // IBKR — engine-synthesized close (never a filing row, in any scope)
  addSale(db, {
    accountId: 3,
    securityId: 1,
    acquisitionDate: "2022-01-06",
    saleDate: "2022-09-06",
    quantity: 4,
    acquisitionPrice: 100,
    salePrice: 110,
    txnType: "RECONCILE_CLOSE",
  });
  // IBKR — option premium rollover (never a filing row, in any scope)
  addSale(db, {
    accountId: 3,
    securityId: 2,
    acquisitionDate: "2022-01-07",
    saleDate: "2022-09-07",
    quantity: 1,
    acquisitionPrice: 300,
    salePrice: 300,
    premiumRollover: true,
  });
}

const ACCOUNTS = ["Taxable", "Vanguard Roth IRA", "IBKR"];

function allRows(report: { shortTermRows: Form8949Row[]; longTermRows: Form8949Row[] }) {
  return [...report.shortTermRows, ...report.longTermRows];
}

describe("generateTaxReport — account scoping", () => {
  it("returns only the named account's rows and totals", () => {
    const db = createTestDb();
    seedMultiAccountYear(db);

    const roth = generateTaxReport(db, YEAR, { accountName: "Vanguard Roth IRA" });

    expect(roth.accountName).toBe("Vanguard Roth IRA");
    expect(allRows(roth).length).toBe(2);
    expect(allRows(roth).every((r) => r.accountName === "Vanguard Roth IRA")).toBe(true);
    // Roth LT: 7 * (145 - 40) = +735; Roth ST: 3 * (250 - 300) = -150
    expect(roth.longTermTotal.gainLoss).toBeCloseTo(735, 6);
    expect(roth.shortTermTotal.gainLoss).toBeCloseTo(-150, 6);

    // …and the unscoped report still carries every account.
    const all = generateTaxReport(db, YEAR);
    expect(all.accountName).toBeNull();
    expect(new Set(allRows(all).map((r) => r.accountName))).toEqual(new Set(ACCOUNTS));
  });

  it("scopes wash-sale warnings to the filtered account", () => {
    const db = createTestDb();
    seedMultiAccountYear(db);

    const all = generateTaxReport(db, YEAR);
    expect(all.washSaleWarnings.length).toBe(1);

    const taxable = generateTaxReport(db, YEAR, { accountName: "Taxable" });
    expect(taxable.washSaleWarnings.length).toBe(1);

    // The wash sale lives in Taxable — Roth must not inherit its warning.
    const roth = generateTaxReport(db, YEAR, { accountName: "Vanguard Roth IRA" });
    expect(roth.washSaleWarnings.length).toBe(0);
  });

  it("keeps the wash-sale determination identical scoped vs unscoped (the 30-day scan spans accounts)", () => {
    const db = createTestDb();
    seedMultiAccountYear(db);

    const all = generateTaxReport(db, YEAR);
    const taxable = generateTaxReport(db, YEAR, { accountName: "Taxable" });

    const allWashSymbols = allRows(all)
      .filter((r) => r.accountName === "Taxable" && r.isWashSale)
      .map((r) => `${r.symbol}@${r.dateSold}`)
      .sort();
    const scopedWashSymbols = allRows(taxable)
      .filter((r) => r.isWashSale)
      .map((r) => `${r.symbol}@${r.dateSold}`)
      .sort();
    expect(scopedWashSymbols).toEqual(allWashSymbols);
  });

  it("treats an unknown account name as an empty, fail-closed report", () => {
    const db = createTestDb();
    seedMultiAccountYear(db);
    stampTaxLotsConvention(db);
    stampBrokerAcceptance(db, [
      { accountId: 1, taxYear: YEAR },
      { accountId: 2, taxYear: YEAR },
      { accountId: 3, taxYear: YEAR },
    ]);

    const bogus = generateTaxReport(db, YEAR, { accountName: "Nonexistent Account" });
    expect(allRows(bogus).length).toBe(0);
    // Empty universe never satisfies .every() vacuously.
    expect(bogus.filingReady).toBe(false);
  });

  it("never lets the filingOnly exclusions leak into a scoped report", () => {
    const db = createTestDb();
    seedMultiAccountYear(db);

    const ibkr = generateTaxReport(db, YEAR, { accountName: "IBKR" });
    // Only the non-USD sale survives: RECONCILE_CLOSE + premium rollover are out.
    expect(allRows(ibkr).length).toBe(1);
    expect(allRows(ibkr)[0].symbol).toBe("SHOP");
    expect(ibkr.excludedNonUsdSales).toBe(1);
    // Non-USD rows never sum into USD totals, in any scope.
    expect(ibkr.shortTermTotal.proceeds).toBe(0);
    expect(ibkr.longTermTotal.proceeds).toBe(0);
  });

  /**
   * CONSERVATION IDENTITY (money-moving engine rule): a per-account export
   * must be a strict SUBSET of the all-accounts export — identical rows,
   * never recomputed differently — and the per-account totals must sum
   * exactly to the all-accounts totals. If this fails, a scoped download is
   * not "the same report, filtered".
   */
  it("CONSERVATION: per-account export rows are a subset of the all-accounts export and Σ per-account = all", () => {
    const db = createTestDb();
    seedMultiAccountYear(db);

    const all = generateTaxReport(db, YEAR);
    const allShort = all.shortTermRows;
    const allLong = all.longTermRows;

    const gatheredShort: Form8949Row[] = [];
    const gatheredLong: Form8949Row[] = [];
    const summed = {
      shortProceeds: 0,
      shortCostBasis: 0,
      shortAdjustments: 0,
      shortGainLoss: 0,
      longProceeds: 0,
      longCostBasis: 0,
      longAdjustments: 0,
      longGainLoss: 0,
      excludedNonUsd: 0,
      washWarnings: 0,
    };

    for (const accountName of ACCOUNTS) {
      const scoped = generateTaxReport(db, YEAR, { accountName });

      // SUBSET: every scoped row appears verbatim in the all-accounts export.
      for (const row of scoped.shortTermRows) {
        expect(allShort).toContainEqual(row);
      }
      for (const row of scoped.longTermRows) {
        expect(allLong).toContainEqual(row);
      }

      gatheredShort.push(...scoped.shortTermRows);
      gatheredLong.push(...scoped.longTermRows);

      summed.shortProceeds += scoped.shortTermTotal.proceeds;
      summed.shortCostBasis += scoped.shortTermTotal.costBasis;
      summed.shortAdjustments += scoped.shortTermTotal.adjustments;
      summed.shortGainLoss += scoped.shortTermTotal.gainLoss;
      summed.longProceeds += scoped.longTermTotal.proceeds;
      summed.longCostBasis += scoped.longTermTotal.costBasis;
      summed.longAdjustments += scoped.longTermTotal.adjustments;
      summed.longGainLoss += scoped.longTermTotal.gainLoss;
      summed.excludedNonUsd += scoped.excludedNonUsdSales;
      summed.washWarnings += scoped.washSaleWarnings.length;
    }

    // PARTITION: the union of the per-account exports is the whole export —
    // no row dropped, no row double-counted.
    expect(gatheredShort.length).toBe(allShort.length);
    expect(gatheredLong.length).toBe(allLong.length);

    // Σ per-account = all-accounts, on every money column.
    expect(summed.shortProceeds).toBeCloseTo(all.shortTermTotal.proceeds, 6);
    expect(summed.shortCostBasis).toBeCloseTo(all.shortTermTotal.costBasis, 6);
    expect(summed.shortAdjustments).toBeCloseTo(all.shortTermTotal.adjustments, 6);
    expect(summed.shortGainLoss).toBeCloseTo(all.shortTermTotal.gainLoss, 6);
    expect(summed.longProceeds).toBeCloseTo(all.longTermTotal.proceeds, 6);
    expect(summed.longCostBasis).toBeCloseTo(all.longTermTotal.costBasis, 6);
    expect(summed.longAdjustments).toBeCloseTo(all.longTermTotal.adjustments, 6);
    expect(summed.longGainLoss).toBeCloseTo(all.longTermTotal.gainLoss, 6);
    expect(summed.excludedNonUsd).toBe(all.excludedNonUsdSales);
    expect(summed.washWarnings).toBe(all.washSaleWarnings.length);
  });
});

describe("filingReady under an account filter (gate never bypassed)", () => {
  it("is per (account, tax-year): a scoped report clears only when THAT account is accepted", () => {
    const db = createTestDb();
    seedMultiAccountYear(db);
    stampTaxLotsConvention(db);
    // Only the Roth account (id 2) is broker-accepted for this year.
    stampBrokerAcceptance(db, [{ accountId: 2, taxYear: YEAR }]);

    expect(generateTaxReport(db, YEAR, { accountName: "Vanguard Roth IRA" }).filingReady).toBe(true);
    // Unaccepted accounts stay marked, and so does the all-accounts export.
    expect(generateTaxReport(db, YEAR, { accountName: "Taxable" }).filingReady).toBe(false);
    expect(generateTaxReport(db, YEAR).filingReady).toBe(false);
  });

  it("stays false for a scoped report when the recompute marker is stale", () => {
    const db = createTestDb();
    seedMultiAccountYear(db);
    stampBrokerAcceptance(db, [{ accountId: 2, taxYear: YEAR }]); // no convention stamp
    expect(generateTaxReport(db, YEAR, { accountName: "Vanguard Roth IRA" }).filingReady).toBe(false);
  });

  it("stays false for a scoped report when the accepted year is a different year", () => {
    const db = createTestDb();
    seedMultiAccountYear(db);
    stampTaxLotsConvention(db);
    stampBrokerAcceptance(db, [{ accountId: 2, taxYear: YEAR - 1 }]);
    expect(generateTaxReport(db, YEAR, { accountName: "Vanguard Roth IRA" }).filingReady).toBe(false);
  });
});

describe("buildTaxReportFilename — account slug", () => {
  it("carries the account slug before the NOT-FOR-FILING marker", () => {
    expect(buildTaxReportFilename("csv", 2022, false, "Vanguard Roth IRA")).toBe(
      "form-8949-2022-vanguard-roth-ira-NOT-FOR-FILING.csv"
    );
    expect(buildTaxReportFilename("txf", 2022, false, "Vanguard Roth IRA")).toBe(
      "tax-report-2022-vanguard-roth-ira-NOT-FOR-FILING.txf"
    );
  });

  it("keeps the account slug once the year is filing-ready", () => {
    expect(buildTaxReportFilename("csv", 2022, true, "Vanguard Roth IRA")).toBe(
      "form-8949-2022-vanguard-roth-ira.csv"
    );
    expect(buildTaxReportFilename("txf", 2022, true, "Vanguard Roth IRA")).toBe(
      "tax-report-2022-vanguard-roth-ira.txf"
    );
  });

  it("is unchanged with no account filter", () => {
    expect(buildTaxReportFilename("csv", 2022, false)).toBe("form-8949-2022-NOT-FOR-FILING.csv");
    expect(buildTaxReportFilename("csv", 2022, true)).toBe("form-8949-2022.csv");
    expect(buildTaxReportFilename("txf", 2022, false, null)).toBe(
      "tax-report-2022-NOT-FOR-FILING.txf"
    );
  });

  it("sanitizes punctuation and slashes out of the slug (never a path segment)", () => {
    const name = buildTaxReportFilename("csv", 2022, false, "Brokerage #7 / Joint (Smith & Co.)");
    expect(name).toBe("form-8949-2022-brokerage-7-joint-smith-co-NOT-FOR-FILING.csv");
    expect(name).not.toContain("/");
  });

  it("falls back to the unscoped name when the account name has no usable characters", () => {
    expect(buildTaxReportFilename("csv", 2022, false, "///")).toBe(
      "form-8949-2022-NOT-FOR-FILING.csv"
    );
  });
});

describe("export scope disclosure inside the files", () => {
  it("CSV names the partial scope and keeps the advisory as the last line", () => {
    const db = createTestDb();
    seedMultiAccountYear(db);

    const csv = generateForm8949CSV(
      generateTaxReport(db, YEAR, { accountName: "Vanguard Roth IRA" })
    );
    expect(csv).toContain("Vanguard Roth IRA");
    expect(csv).toContain("PARTIAL EXPORT");
    const lines = csv.split("\n");
    expect(lines[lines.length - 1]).toBe(`Note: ${washSaleAdvisory}`);
  });

  it("CSV is unchanged with no account filter", () => {
    const db = createTestDb();
    seedMultiAccountYear(db);

    const csv = generateForm8949CSV(generateTaxReport(db, YEAR));
    expect(csv).not.toContain("PARTIAL EXPORT");
    const lines = csv.split("\n");
    expect(lines[0]).toContain("Term,Description,Date Acquired,Date Sold,Proceeds,Cost Basis");
    expect(lines[lines.length - 1]).toBe(`Note: ${washSaleAdvisory}`);
  });

  it("TXF names the scope in its header record and stays a valid header block", () => {
    const db = createTestDb();
    seedMultiAccountYear(db);

    const scoped = generateTXF(generateTaxReport(db, YEAR, { accountName: "Vanguard Roth IRA" }));
    const lines = scoped.split("\n");
    expect(lines[0]).toBe("V042");
    expect(lines[1].startsWith("A")).toBe(true);
    expect(lines[1]).toContain("Vanguard Roth IRA");
    expect(lines[3]).toBe("^");

    const unscoped = generateTXF(generateTaxReport(db, YEAR)).split("\n");
    expect(unscoped[1]).toBe("APortfolio Desk");
  });
});
