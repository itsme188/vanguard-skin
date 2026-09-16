import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import {
  generateTaxReport,
  generateForm8949CSV,
  generateTXF,
} from "@/lib/compute/tax-report";
import {
  TAX_TREATMENTS,
  isTaxableAccount,
  normalizeTaxTreatment,
  type TaxTreatment,
} from "@/lib/compute/tax-treatment";

/**
 * Retirement accounts leave the tax report and the Form 8949 exports (QA
 * finding tax-lots--form-8949-export-and-taxable-totals-include-roth-ira-sales,
 * user ruling 2026-09-14).
 *
 * A sale inside an IRA is not a taxable event and is never reported on Form
 * 8949, yet the all-accounts report summed those rows into "TAXABLE ST/LT"
 * and the CSV/TXF carried them. The account's treatment is a real column
 * (accounts.tax_treatment, migration 094) — never a name heuristic, which is
 * why the fixture below deliberately gives the RETIREMENT account a name with
 * no "IRA"/"Roth" in it and the TAXABLE one a name that contains "ira"
 * inside an ordinary word.
 *
 * Every account name, symbol, quantity and price here is synthetic.
 */

const YEAR = 2022;

const ACCOUNT_TAXABLE = "Alpha Brokerage";
/** Contains the letters "ira" (adm-IRA-l) on purpose: a name heuristic would
 *  wrongly classify this taxable account as a retirement account. */
const ACCOUNT_TAXABLE_TRAP = "Admiral Brokerage";
/** No "IRA"/"Roth"/"retirement" token: only the stamped column identifies it. */
const ACCOUNT_RETIREMENT = "Beta Plan";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      tax_treatment TEXT NOT NULL DEFAULT 'taxable'
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
    INSERT INTO accounts (id, name, tax_treatment) VALUES
      (1, '${ACCOUNT_TAXABLE}', 'taxable'),
      (2, '${ACCOUNT_RETIREMENT}', 'roth_ira'),
      (3, '${ACCOUNT_TAXABLE_TRAP}', 'taxable');
    INSERT INTO securities (id, symbol, name, currency) VALUES
      (1, 'AAA', 'Alpha Test Co', 'USD'),
      (2, 'BBB', 'Beta Test Co', 'USD');
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
       VALUES (?, ?, ?, 'SELL', ?, ?, ?)`
    )
    .run(opts.accountId, opts.securityId, opts.saleDate, opts.quantity, opts.salePrice, proceeds);

  db.prepare(
    `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days, premium_rollover)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(
    lot.lastInsertRowid,
    txn.lastInsertRowid,
    opts.saleDate,
    opts.quantity,
    opts.salePrice,
    proceeds,
    costBasis,
    gain,
    holdingDays > 365 ? 1 : 0,
    holdingDays
  );
}

/** One short-term gain in each of the three accounts, same size, so the
 *  "retirement rows dropped" assertions read off round numbers. */
function seedYear(db: Database.Database) {
  // Taxable, short-term: 10 sh bought at 100, sold at 110 → +100
  addSale(db, {
    accountId: 1,
    securityId: 1,
    acquisitionDate: `${YEAR}-02-01`,
    saleDate: `${YEAR}-06-01`,
    quantity: 10,
    acquisitionPrice: 100,
    salePrice: 110,
  });
  // Retirement, short-term: identical shape → must never reach the report
  addSale(db, {
    accountId: 2,
    securityId: 2,
    acquisitionDate: `${YEAR}-02-01`,
    saleDate: `${YEAR}-06-01`,
    quantity: 10,
    acquisitionPrice: 100,
    salePrice: 110,
  });
  // Retirement, long-term
  addSale(db, {
    accountId: 2,
    securityId: 1,
    acquisitionDate: `${YEAR - 2}-02-01`,
    saleDate: `${YEAR}-07-01`,
    quantity: 20,
    acquisitionPrice: 100,
    salePrice: 150,
  });
  // Taxable trap account, long-term
  addSale(db, {
    accountId: 3,
    securityId: 2,
    acquisitionDate: `${YEAR - 2}-03-01`,
    saleDate: `${YEAR}-08-01`,
    quantity: 10,
    acquisitionPrice: 100,
    salePrice: 120,
  });
}

let db: Database.Database;

beforeEach(() => {
  db = createTestDb();
  seedYear(db);
});

describe("tax treatment vocabulary", () => {
  it("lists the four treatments exactly once each", () => {
    expect([...TAX_TREATMENTS]).toEqual([
      "taxable",
      "roth_ira",
      "traditional_ira",
      "other_tax_advantaged",
    ]);
    expect(new Set(TAX_TREATMENTS).size).toBe(TAX_TREATMENTS.length);
  });

  it("treats only 'taxable' as taxable", () => {
    expect(isTaxableAccount("taxable")).toBe(true);
    for (const t of TAX_TREATMENTS.filter((t) => t !== "taxable")) {
      expect(isTaxableAccount(t)).toBe(false);
    }
  });

  it("treats a missing value as taxable (pre-migration rows) and an unknown value as NOT taxable", () => {
    expect(isTaxableAccount(null)).toBe(true);
    expect(isTaxableAccount(undefined)).toBe(true);
    expect(isTaxableAccount("")).toBe(true);
    // Fail closed: a hand-edited value nobody recognises must not put rows on
    // a Form 8949 — it surfaces in excludedRetirementAccounts instead.
    expect(isTaxableAccount("something_else")).toBe(false);
  });

  it("normalizes case/whitespace and refuses an unknown treatment", () => {
    const normalized: TaxTreatment = normalizeTaxTreatment(" Roth_IRA ");
    expect(normalized).toBe("roth_ira");
    expect(() => normalizeTaxTreatment("brokerage")).toThrow(/brokerage/);
  });
});

describe("generateTaxReport — unscoped (all accounts)", () => {
  it("drops the retirement account's sales from the rows", () => {
    const report = generateTaxReport(db, YEAR);
    const names = [...report.shortTermRows, ...report.longTermRows].map((r) => r.accountName);
    expect(names).not.toContain(ACCOUNT_RETIREMENT);
    expect(new Set(names)).toEqual(new Set([ACCOUNT_TAXABLE, ACCOUNT_TAXABLE_TRAP]));
    expect(report.shortTermRows).toHaveLength(1);
    expect(report.longTermRows).toHaveLength(1);
  });

  it("drops the retirement account's sales from the totals", () => {
    const report = generateTaxReport(db, YEAR);
    // Only the taxable short-term sale: 10 sh × (110 - 100)
    expect(report.shortTermTotal.proceeds).toBeCloseTo(1100, 6);
    expect(report.shortTermTotal.costBasis).toBeCloseTo(1000, 6);
    expect(report.shortTermTotal.gainLoss).toBeCloseTo(100, 6);
    // Only the trap account's long-term sale: 10 sh × (120 - 100)
    expect(report.longTermTotal.gainLoss).toBeCloseTo(200, 6);
  });

  it("names the excluded retirement account so the banner can say so", () => {
    const report = generateTaxReport(db, YEAR);
    expect(report.excludedRetirementAccounts).toEqual([ACCOUNT_RETIREMENT]);
    expect(report.retirementAccount).toBe(false);
    expect(report.hasTaxAdvantagedAccounts).toBe(true);
  });

  it("reports an all-taxable book as having no retirement stamp yet", () => {
    db.prepare("UPDATE accounts SET tax_treatment = 'taxable'").run();
    const report = generateTaxReport(db, YEAR);
    expect(report.hasTaxAdvantagedAccounts).toBe(false);
    expect(report.excludedRetirementAccounts).toEqual([]);
    // Every sale is back in scope — the exclusion is driven ONLY by the column.
    expect(report.shortTermRows.length + report.longTermRows.length).toBe(4);
  });

  it("keeps the taxable account whose NAME merely contains 'ira'", () => {
    const report = generateTaxReport(db, YEAR);
    expect(report.longTermRows.map((r) => r.accountName)).toContain(ACCOUNT_TAXABLE_TRAP);
  });
});

describe("generateTaxReport — scoped to a retirement account", () => {
  it("returns an empty, zeroed report flagged retirementAccount instead of throwing", () => {
    const report = generateTaxReport(db, YEAR, { accountName: ACCOUNT_RETIREMENT });
    expect(report.retirementAccount).toBe(true);
    expect(report.shortTermRows).toEqual([]);
    expect(report.longTermRows).toEqual([]);
    expect(report.shortTermTotal).toEqual({
      proceeds: 0,
      costBasis: 0,
      adjustments: 0,
      gainLoss: 0,
    });
    expect(report.longTermTotal).toEqual({
      proceeds: 0,
      costBasis: 0,
      adjustments: 0,
      gainLoss: 0,
    });
    expect(report.washSaleWarnings).toEqual([]);
    expect(report.filingReady).toBe(false);
    expect(report.accountName).toBe(ACCOUNT_RETIREMENT);
    expect(report.excludedRetirementAccounts).toEqual([ACCOUNT_RETIREMENT]);
  });

  it("still reports normally when scoped to a taxable account", () => {
    const report = generateTaxReport(db, YEAR, { accountName: ACCOUNT_TAXABLE });
    expect(report.retirementAccount).toBe(false);
    expect(report.shortTermRows).toHaveLength(1);
    expect(report.excludedRetirementAccounts).toEqual([]);
  });
});

describe("Form 8949 exports", () => {
  it("emits no retirement rows in the all-accounts CSV", () => {
    const csv = generateForm8949CSV(generateTaxReport(db, YEAR));
    expect(csv).not.toContain(ACCOUNT_RETIREMENT);
    expect(csv).toContain(ACCOUNT_TAXABLE);
    // Two data rows + two totals lines + the advisory footer
    const dataLines = csv.split("\n").filter((l) => l.startsWith("Short-Term,") || l.startsWith("Long-Term,"));
    expect(dataLines).toHaveLength(2);
  });

  it("emits no sale records at all for a retirement-scoped report", () => {
    const report = generateTaxReport(db, YEAR, { accountName: ACCOUNT_RETIREMENT });
    const csv = generateForm8949CSV(report);
    expect(csv.split("\n").filter((l) => l.startsWith("Short-Term,") || l.startsWith("Long-Term,"))).toHaveLength(0);
    const txf = generateTXF(report);
    expect(txf).not.toContain("TD");
  });
});
