import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import {
  generateTaxReport,
  generateForm8949CSV,
  buildTaxReportFilename,
  washSaleAdvisory,
} from "@/lib/compute/tax-report";
import { stampBrokerAcceptance, stampTaxLotsConvention } from "@/lib/compute/tax-convention";

// Golden-file style coverage for the number-trust durable-fixes Task 6
// surface: short-cover 8949 dates, the filingOnly row filter, the
// marker-gated filingReady flag (fail-closed against the explicit account
// universe), and the wash-sale advisory disclosure. See
// .superpowers/sdd/2026-08-23-number-trust-durable-fixes/task-6-brief.md.

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
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

  db.exec("INSERT INTO accounts (id, name) VALUES (1, 'IBKR')");
  db.exec("INSERT INTO securities (id, symbol, name) VALUES (1, 'AAPL', 'Apple Inc.')");
  db.exec("INSERT INTO securities (id, symbol, name) VALUES (2, 'SHRT', 'Shortable Corp.')");

  return db;
}

/** Ordinary long/short-term round-trip sale (not a short-cover). */
function addSale(
  db: Database.Database,
  opts: {
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
    (new Date(opts.saleDate).getTime() - new Date(opts.acquisitionDate).getTime()) / (24 * 3600 * 1000)
  );

  const lotResult = db
    .prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (1, ?, ?, ?, ?, 0, ?)`
    )
    .run(opts.securityId, opts.acquisitionDate, opts.acquisitionPrice, opts.quantity, costBasis);

  // getClosedTaxLotSales INNER JOINs transactions via sale_transaction_id —
  // every sale row needs a real backing transaction.
  const txnResult = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount)
       VALUES (1, ?, ?, ?, ?, ?, ?)`
    )
    .run(opts.securityId, opts.saleDate, opts.txnType ?? "SELL", opts.quantity, opts.salePrice, proceeds);

  db.prepare(
    `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days, premium_rollover)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    lotResult.lastInsertRowid,
    txnResult.lastInsertRowid,
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

/**
 * Short round-trip: SELL_TO_OPEN then BUY_TO_COVER. Mirrors the Task-3
 * engine convention — tax_lots.is_short=1, holding_period_days SIGNED
 * NEGATIVE (display convention), sale_date is the COVER date.
 */
function addShortSale(
  db: Database.Database,
  opts: {
    securityId: number;
    openDate: string;
    coverDate: string;
    quantity: number;
    openPrice: number;
    coverPrice: number;
  }
) {
  const spanDays = Math.round(
    (new Date(opts.coverDate).getTime() - new Date(opts.openDate).getTime()) / (24 * 3600 * 1000)
  );
  const proceeds = opts.quantity * opts.openPrice; // net short-open leg
  const costBasisAllocated = opts.quantity * opts.coverPrice; // cover cost
  const gain = proceeds - costBasisAllocated;

  const lotResult = db
    .prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis, is_short)
       VALUES (1, ?, ?, ?, ?, 0, ?, 1)`
    )
    .run(opts.securityId, opts.openDate, opts.openPrice, opts.quantity, proceeds);

  const txnResult = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount)
       VALUES (1, ?, ?, 'BUY_TO_COVER', ?, ?, ?)`
    )
    .run(opts.securityId, opts.coverDate, opts.quantity, opts.coverPrice, costBasisAllocated);

  db.prepare(
    `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    lotResult.lastInsertRowid,
    txnResult.lastInsertRowid,
    opts.coverDate,
    opts.quantity,
    opts.coverPrice,
    proceeds,
    costBasisAllocated,
    gain,
    -spanDays
  );
}

describe("short sale rows (WS1 orientation)", () => {
  it("short rows report the cover date as BOTH 8949 dates", () => {
    const db = createTestDb();
    // open 2025-01-10, cover 2025-02-20
    addShortSale(db, {
      securityId: 2,
      openDate: "2025-01-10",
      coverDate: "2025-02-20",
      quantity: 100,
      openPrice: 50,
      coverPrice: 40,
    });

    const report = generateTaxReport(db, 2025);
    const row = report.shortTermRows.find((r) => r.symbol === "SHRT");
    expect(row).toBeDefined();
    expect(row!.dateAcquired).toBe("02/20/2025");
    expect(row!.dateSold).toBe("02/20/2025");
    // Signed display convention (Task 3) — a short row's holding_period_days
    // is stored negative; generateTaxReport passes it through unchanged.
    expect(row!.holdingPeriodDays).toBe(-41);
  });
});

describe("filingOnly exclusion", () => {
  it("uses filingOnly rows: RECONCILE_CLOSE and premium rollovers absent", () => {
    const db = createTestDb();
    // A real, filing-eligible sale
    addSale(db, {
      securityId: 1,
      acquisitionDate: "2025-01-15",
      saleDate: "2025-06-15",
      quantity: 10,
      acquisitionPrice: 100,
      salePrice: 120,
      isLongTerm: false,
    });
    // Engine-synthesized reconcile close — never real broker activity
    addSale(db, {
      securityId: 1,
      acquisitionDate: "2025-02-01",
      saleDate: "2025-07-01",
      quantity: 5,
      acquisitionPrice: 100,
      salePrice: 110,
      isLongTerm: false,
      txnType: "RECONCILE_CLOSE",
    });
    // Exercised option premium rollover — not a separate disposition
    addSale(db, {
      securityId: 1,
      acquisitionDate: "2025-03-01",
      saleDate: "2025-08-01",
      quantity: 1,
      acquisitionPrice: 300,
      salePrice: 300,
      isLongTerm: false,
      premiumRollover: true,
    });

    const report = generateTaxReport(db, 2025);
    const totalRows = report.shortTermRows.length + report.longTermRows.length;
    expect(totalRows).toBe(1);
    expect(report.shortTermRows[0].proceeds).toBe(1200);
  });
});

describe("filingReady (marker-gated, fail-closed)", () => {
  it("is false without acceptance coverage for the year, true with it", () => {
    const db = createTestDb();
    addSale(db, {
      securityId: 1,
      acquisitionDate: "2025-01-15",
      saleDate: "2025-06-15",
      quantity: 10,
      acquisitionPrice: 100,
      salePrice: 120,
      isLongTerm: false,
    });
    // Engine convention marker: simulates the Task-3 engine having already
    // run (satisfies the recomputeCurrent gate). Broker acceptance is the
    // dimension under test here.
    stampTaxLotsConvention(db);

    expect(generateTaxReport(db, 2025).filingReady).toBe(false);
    stampBrokerAcceptance(db, [{ accountId: 1, taxYear: 2025 }]);
    expect(generateTaxReport(db, 2025).filingReady).toBe(true); // account 1 is the only account in this fixture
  });

  it("stays false when acceptance is stamped but the recompute marker is stale", () => {
    const db = createTestDb();
    addSale(db, {
      securityId: 1,
      acquisitionDate: "2025-01-15",
      saleDate: "2025-06-15",
      quantity: 10,
      acquisitionPrice: 100,
      salePrice: 120,
      isLongTerm: false,
    });
    // Acceptance stamped, but the engine convention marker was never
    // stamped (no recompute since acceptance was granted).
    stampBrokerAcceptance(db, [{ accountId: 1, taxYear: 2025 }]);
    expect(generateTaxReport(db, 2025).filingReady).toBe(false);
  });

  it("stays false with zero sales even when both markers are stamped (empty universe never vacuously ready)", () => {
    // Codex plan review #12: isYearAccepted's own accountIds.every() check
    // returns true on an EMPTY array — the explicit accountIds.length > 0
    // guard in generateTaxReport is what prevents an all-empty year from
    // reading as "ready".
    const db = createTestDb();
    stampTaxLotsConvention(db);
    stampBrokerAcceptance(db, [{ accountId: 1, taxYear: 2025 }]);
    expect(generateTaxReport(db, 2025).filingReady).toBe(false);
  });
});

describe("CSV footer wash-sale advisory", () => {
  it("carries the advisory line; totals unchanged otherwise", () => {
    const db = createTestDb();
    addSale(db, {
      securityId: 1,
      acquisitionDate: "2025-01-15",
      saleDate: "2025-06-15",
      quantity: 100,
      acquisitionPrice: 150,
      salePrice: 170,
      isLongTerm: false,
    });

    const report = generateTaxReport(db, 2025);
    expect(report.washSaleAdvisory).toBe(washSaleAdvisory);

    const csv = generateForm8949CSV(report);
    expect(csv).toContain("Note: W adjustment codes are heuristic estimates");

    const lines = csv.split("\n");
    expect(lines[0]).toContain("Term,Description,Date Acquired,Date Sold,Proceeds,Cost Basis");
    expect(lines[1]).toContain("100 sh AAPL");
    // Totals row unchanged: 100 * (170 - 150) = $2,000 gain
    expect(lines[2]).toContain("Short-Term Totals");
    expect(lines[2]).toContain("17000.00");
    expect(lines[2]).toContain("15000.00");
    expect(lines[2]).toContain("2000.00");
    // Advisory is the LAST line — never inside the TXF body, CSV/UI only.
    expect(lines[lines.length - 1]).toBe(`Note: ${washSaleAdvisory}`);
  });
});

describe("buildTaxReportFilename", () => {
  it("appends -NOT-FOR-FILING for csv when not filing-ready", () => {
    expect(buildTaxReportFilename("csv", 2025, false)).toBe("form-8949-2025-NOT-FOR-FILING.csv");
  });
  it("omits the suffix for csv when filing-ready", () => {
    expect(buildTaxReportFilename("csv", 2025, true)).toBe("form-8949-2025.csv");
  });
  it("appends -NOT-FOR-FILING for txf when not filing-ready", () => {
    expect(buildTaxReportFilename("txf", 2025, false)).toBe("tax-report-2025-NOT-FOR-FILING.txf");
  });
  it("omits the suffix for txf when filing-ready", () => {
    expect(buildTaxReportFilename("txf", 2025, true)).toBe("tax-report-2025.txf");
  });
});
