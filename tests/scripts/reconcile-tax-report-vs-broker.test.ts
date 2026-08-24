import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  runReconciliation,
  type BrokerRealizedConfig,
} from "@/scripts/reconcile-tax-report-vs-broker";
import { stampBrokerAcceptance, getTaxConventionState, stampTaxLotsConvention } from "@/lib/compute/tax-convention";
import sampleConfig from "@/tests/fixtures/broker-realized-sample.json";

// Migration 002 seeds accounts in this fixed order: 'Vanguard Taxable' (1),
// 'Vanguard Roth IRA' (2), 'IBKR' (3) — same convention tests/queries/
// tax-lots.test.ts relies on (hardcoded ACCOUNT_ID = 1).
const ACCOUNT_ID = 1;

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function ensureSecurity(db: Database.Database, symbol: string): number {
  db.prepare(
    "INSERT OR IGNORE INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')",
  ).run(symbol, symbol);
  return (db.prepare("SELECT id FROM securities WHERE symbol = ?").get(symbol) as { id: number })
    .id;
}

let txnCounter = 0;
function insertSellTransaction(
  db: Database.Database,
  accountId: number,
  securityId: number,
  tradeDate: string,
  type: string = "SELL",
): number {
  txnCounter++;
  const result = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, source_key)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .run(accountId, securityId, tradeDate, type, `test:txn:${txnCounter}`);
  return result.lastInsertRowid as number;
}

function insertTaxLot(
  db: Database.Database,
  accountId: number,
  securityId: number,
  acquisitionDate: string,
  acquisitionPrice: number,
  quantityAcquired: number,
  quantityRemaining: number,
  costBasis: number,
): number {
  const result = db
    .prepare(
      `INSERT INTO tax_lots
         (account_id, security_id, acquisition_date, acquisition_price,
          quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(accountId, securityId, acquisitionDate, acquisitionPrice, quantityAcquired, quantityRemaining, costBasis);
  return result.lastInsertRowid as number;
}

function insertSaleRow(
  db: Database.Database,
  opts: {
    taxLotId: number;
    saleTransactionId: number;
    quantitySold: number;
    salePrice: number;
    proceeds: number;
    costBasisAllocated: number;
    realizedGainLoss: number;
    saleDate: string;
    premiumRollover?: number;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO tax_lot_sales
         (tax_lot_id, sale_transaction_id, quantity_sold, sale_price, proceeds,
          cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days,
          sale_date, premium_rollover)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 400, ?, ?)`,
    )
    .run(
      opts.taxLotId,
      opts.saleTransactionId,
      opts.quantitySold,
      opts.salePrice,
      opts.proceeds,
      opts.costBasisAllocated,
      opts.realizedGainLoss,
      opts.saleDate,
      opts.premiumRollover ?? 0,
    );
  return result.lastInsertRowid as number;
}

/** Seeds one filing-eligible disposal: one tax lot fully consumed by one
 * sale transaction on one sale date. `txnType` lets callers exercise the
 * RECONCILE_CLOSE exclusion; `premiumRollover` the premium_rollover
 * exclusion. */
function seedDisposal(
  db: Database.Database,
  opts: {
    accountId: number;
    symbol: string;
    acquisitionDate: string;
    saleDate: string;
    quantity: number;
    proceeds: number;
    basis: number;
    gain: number;
    txnType?: string;
    premiumRollover?: number;
  },
): void {
  const securityId = ensureSecurity(db, opts.symbol);
  const saleTransactionId = insertSellTransaction(
    db,
    opts.accountId,
    securityId,
    opts.saleDate,
    opts.txnType ?? "SELL",
  );
  const taxLotId = insertTaxLot(
    db,
    opts.accountId,
    securityId,
    opts.acquisitionDate,
    opts.basis / opts.quantity,
    opts.quantity,
    0,
    opts.basis,
  );
  insertSaleRow(db, {
    taxLotId,
    saleTransactionId,
    quantitySold: opts.quantity,
    salePrice: opts.proceeds / opts.quantity,
    proceeds: opts.proceeds,
    costBasisAllocated: opts.basis,
    realizedGainLoss: opts.gain,
    saleDate: opts.saleDate,
    premiumRollover: opts.premiumRollover,
  });
}

describe("runReconciliation", () => {
  it("(a) transcription tie-out mismatch fails before any engine comparison", () => {
    const db = createTestDb();
    // No engine data seeded at all — if the tie-out check didn't run FIRST,
    // this would fail for "unmatched broker row" instead of the tie-out
    // reason; assert the reason to prove ordering.
    const config: BrokerRealizedConfig = {
      entries: [
        {
          accountId: ACCOUNT_ID,
          taxYear: 2026,
          source: "test-a",
          statementTotal: { proceeds: 1000, basis: 800, gain: 200 },
          rows: [
            {
              symbol: "TIEOUT",
              disposalDate: "2026-01-01",
              quantity: 10,
              currency: "USD",
              proceeds: 900, // rows sum to 900/800/100 — off by $100 from statementTotal
              basis: 800,
              gain: 100,
            },
          ],
        },
      ],
    };

    const result = runReconciliation(db, config);
    expect(result.pass).toBe(false);
    expect(result.summary).toContain("transcription tie-out mismatch");
    expect(result.coverage).toEqual([]);
  });

  it("(b) full match passes with per-field tolerance (fixture-backed)", () => {
    const db = createTestDb();
    seedDisposal(db, {
      accountId: ACCOUNT_ID,
      symbol: "ACME",
      acquisitionDate: "2026-01-05",
      saleDate: "2026-03-10",
      quantity: 100,
      proceeds: 10100,
      basis: 8000,
      gain: 2100,
    });
    seedDisposal(db, {
      accountId: ACCOUNT_ID,
      symbol: "ACME",
      acquisitionDate: "2026-04-01",
      saleDate: "2026-06-01",
      quantity: 50,
      proceeds: 5200,
      basis: 4000,
      gain: 1200,
    });

    const result = runReconciliation(db, sampleConfig as BrokerRealizedConfig);
    expect(result.pass).toBe(true);
    expect(result.coverage).toEqual([{ accountId: 1, taxYear: 2026 }]);
    expect(result.summary).toContain("PASS");
  });

  it("ACCEPT_TOL_USD boundary: a $0.01 delta passes, $0.02 fails", () => {
    const db = createTestDb();
    seedDisposal(db, {
      accountId: ACCOUNT_ID,
      symbol: "TOL",
      acquisitionDate: "2026-01-01",
      saleDate: "2026-02-01",
      quantity: 10,
      proceeds: 1000.0,
      basis: 800.0,
      gain: 200.0,
    });

    const passConfig: BrokerRealizedConfig = {
      entries: [
        {
          accountId: ACCOUNT_ID,
          taxYear: 2026,
          source: "tol-pass",
          statementTotal: { proceeds: 1000.01, basis: 800.0, gain: 200.01 },
          rows: [
            {
              symbol: "TOL",
              disposalDate: "2026-02-01",
              quantity: 10,
              currency: "USD",
              proceeds: 1000.01,
              basis: 800.0,
              gain: 200.01,
            },
          ],
        },
      ],
    };
    expect(runReconciliation(db, passConfig).pass).toBe(true);

    const failConfig: BrokerRealizedConfig = {
      entries: [
        {
          accountId: ACCOUNT_ID,
          taxYear: 2026,
          source: "tol-fail",
          statementTotal: { proceeds: 1000.02, basis: 800.0, gain: 200.02 },
          rows: [
            {
              symbol: "TOL",
              disposalDate: "2026-02-01",
              quantity: 10,
              currency: "USD",
              proceeds: 1000.02,
              basis: 800.0,
              gain: 200.02,
            },
          ],
        },
      ],
    };
    const failResult = runReconciliation(db, failConfig);
    expect(failResult.pass).toBe(false);
    expect(failResult.summary).toContain("field mismatch");
  });

  it("(c) an unmatched broker row fails", () => {
    const db = createTestDb();
    // No matching engine disposal exists anywhere for this symbol/date/qty.
    const config: BrokerRealizedConfig = {
      entries: [
        {
          accountId: ACCOUNT_ID,
          taxYear: 2026,
          source: "test-c",
          statementTotal: { proceeds: 500, basis: 400, gain: 100 },
          rows: [
            {
              symbol: "GHOST",
              disposalDate: "2026-05-01",
              quantity: 5,
              currency: "USD",
              proceeds: 500,
              basis: 400,
              gain: 100,
            },
          ],
        },
      ],
    };

    const result = runReconciliation(db, config);
    expect(result.pass).toBe(false);
    expect(result.summary).toContain("unmatched broker row");
    expect(result.coverage).toEqual([]);
  });

  it("(d) an extra engine disposal in the covered (account, year) fails", () => {
    const db = createTestDb();
    seedDisposal(db, {
      accountId: ACCOUNT_ID,
      symbol: "KNOWN",
      acquisitionDate: "2026-01-01",
      saleDate: "2026-02-01",
      quantity: 10,
      proceeds: 1000,
      basis: 800,
      gain: 200,
    });
    // Never mentioned in the broker config below.
    seedDisposal(db, {
      accountId: ACCOUNT_ID,
      symbol: "EXTRA",
      acquisitionDate: "2026-01-01",
      saleDate: "2026-03-01",
      quantity: 5,
      proceeds: 500,
      basis: 400,
      gain: 100,
    });

    const config: BrokerRealizedConfig = {
      entries: [
        {
          accountId: ACCOUNT_ID,
          taxYear: 2026,
          source: "test-d",
          statementTotal: { proceeds: 1000, basis: 800, gain: 200 },
          rows: [
            {
              symbol: "KNOWN",
              disposalDate: "2026-02-01",
              quantity: 10,
              currency: "USD",
              proceeds: 1000,
              basis: 800,
              gain: 200,
            },
          ],
        },
      ],
    };

    const result = runReconciliation(db, config);
    expect(result.pass).toBe(false);
    expect(result.summary).toContain("extra engine disposal");
  });

  it("(e) one broker disposal matching two FIFO sale rows sums them and passes", () => {
    const db = createTestDb();
    const securityId = ensureSecurity(db, "SPLIT");
    const saleTransactionId = insertSellTransaction(db, ACCOUNT_ID, securityId, "2026-04-01");
    // Two lots consumed by the SAME sale transaction — same sale_date, same
    // sale_transaction_id, different tax_lot_id (different acquisition_date).
    const lot1 = insertTaxLot(db, ACCOUNT_ID, securityId, "2026-01-01", 50, 60, 0, 3000);
    const lot2 = insertTaxLot(db, ACCOUNT_ID, securityId, "2026-02-01", 55, 40, 0, 2200);
    insertSaleRow(db, {
      taxLotId: lot1,
      saleTransactionId,
      quantitySold: 60,
      salePrice: 70,
      proceeds: 4200,
      costBasisAllocated: 3000,
      realizedGainLoss: 1200,
      saleDate: "2026-04-01",
    });
    insertSaleRow(db, {
      taxLotId: lot2,
      saleTransactionId,
      quantitySold: 40,
      salePrice: 70,
      proceeds: 2800,
      costBasisAllocated: 2200,
      realizedGainLoss: 600,
      saleDate: "2026-04-01",
    });
    // Combined: qty 100, proceeds 7000, basis 5200, gain 1800.

    const config: BrokerRealizedConfig = {
      entries: [
        {
          accountId: ACCOUNT_ID,
          taxYear: 2026,
          source: "test-e",
          statementTotal: { proceeds: 7000, basis: 5200, gain: 1800 },
          rows: [
            {
              symbol: "SPLIT",
              disposalDate: "2026-04-01",
              quantity: 100,
              currency: "USD",
              proceeds: 7000,
              basis: 5200,
              gain: 1800,
            },
          ],
        },
      ],
    };

    const result = runReconciliation(db, config);
    expect(result.pass).toBe(true);
    expect(result.coverage).toEqual([{ accountId: ACCOUNT_ID, taxYear: 2026 }]);
  });

  it("(f) empty rows fails with zero coverage", () => {
    const db = createTestDb();
    const config: BrokerRealizedConfig = {
      entries: [
        {
          accountId: ACCOUNT_ID,
          taxYear: 2026,
          source: "test-f",
          statementTotal: { proceeds: 0, basis: 0, gain: 0 },
          rows: [],
        },
      ],
    };

    const result = runReconciliation(db, config);
    expect(result.pass).toBe(false);
    expect(result.summary).toContain("zero coverage");
    expect(result.coverage).toEqual([]);
  });

  it("zero entries (empty config) fails closed — never a vacuous pass, and --stamp must not write coverage", () => {
    const db = createTestDb();
    const config: BrokerRealizedConfig = { entries: [] };

    const result = runReconciliation(db, config);
    expect(result.pass).toBe(false);
    expect(result.coverage).toEqual([]);
    expect(result.summary).toContain("no entries — nothing reconciled");
    expect(result.summary).toContain("GATE: FAIL");

    // Mirror the CLI's --stamp guard exactly (main() in
    // reconcile-tax-report-vs-broker.ts: only stamps when result.pass) and
    // confirm the settings row is never written for a failing result.
    if (result.pass) {
      db.transaction(() => {
        stampBrokerAcceptance(db, result.coverage);
      })();
    }
    const row = db
      .prepare("SELECT value FROM settings WHERE key = 'tax_report_broker_accepted'")
      .get();
    expect(row).toBeUndefined();
  });

  it("(g) RECONCILE_CLOSE and premium_rollover engine rows are invisible to the extra-disposal check", () => {
    const db = createTestDb();
    seedDisposal(db, {
      accountId: ACCOUNT_ID,
      symbol: "KNOWN2",
      acquisitionDate: "2026-01-01",
      saleDate: "2026-02-01",
      quantity: 10,
      proceeds: 1000,
      basis: 800,
      gain: 200,
    });
    // Engine-synthesized RECONCILE_CLOSE row — never real broker activity;
    // must not surface as an extra disposal.
    seedDisposal(db, {
      accountId: ACCOUNT_ID,
      symbol: "SYNTH",
      acquisitionDate: "2026-01-01",
      saleDate: "2026-03-01",
      quantity: 3,
      proceeds: 300,
      basis: 250,
      gain: 50,
      txnType: "RECONCILE_CLOSE",
    });
    // Option premium-rollover close — not a separate disposition under IRS
    // Pub 550; must not surface as an extra disposal either.
    seedDisposal(db, {
      accountId: ACCOUNT_ID,
      symbol: "OPT",
      acquisitionDate: "2026-01-01",
      saleDate: "2026-04-01",
      quantity: 1,
      proceeds: 50,
      basis: 40,
      gain: 10,
      premiumRollover: 1,
    });

    const config: BrokerRealizedConfig = {
      entries: [
        {
          accountId: ACCOUNT_ID,
          taxYear: 2026,
          source: "test-g",
          statementTotal: { proceeds: 1000, basis: 800, gain: 200 },
          rows: [
            {
              symbol: "KNOWN2",
              disposalDate: "2026-02-01",
              quantity: 10,
              currency: "USD",
              proceeds: 1000,
              basis: 800,
              gain: 200,
            },
          ],
        },
      ],
    };

    const result = runReconciliation(db, config);
    expect(result.pass).toBe(true);
    expect(result.summary).not.toContain("extra engine disposal");
  });

  it("ambiguous match: two engine groups sharing one broker identity key fail closed", () => {
    const db = createTestDb();
    const securityId = ensureSecurity(db, "DUPKEY");
    // Two SEPARATE sale transactions, same symbol/date/qty/currency — after
    // engine-side grouping they still collide on the broker match key.
    const txn1 = insertSellTransaction(db, ACCOUNT_ID, securityId, "2026-02-01");
    const txn2 = insertSellTransaction(db, ACCOUNT_ID, securityId, "2026-02-01");
    const lot1 = insertTaxLot(db, ACCOUNT_ID, securityId, "2026-01-01", 50, 10, 0, 500);
    const lot2 = insertTaxLot(db, ACCOUNT_ID, securityId, "2026-01-02", 50, 10, 0, 500);
    insertSaleRow(db, {
      taxLotId: lot1,
      saleTransactionId: txn1,
      quantitySold: 10,
      salePrice: 70,
      proceeds: 700,
      costBasisAllocated: 500,
      realizedGainLoss: 200,
      saleDate: "2026-02-01",
    });
    insertSaleRow(db, {
      taxLotId: lot2,
      saleTransactionId: txn2,
      quantitySold: 10,
      salePrice: 70,
      proceeds: 700,
      costBasisAllocated: 500,
      realizedGainLoss: 200,
      saleDate: "2026-02-01",
    });

    const config: BrokerRealizedConfig = {
      entries: [
        {
          accountId: ACCOUNT_ID,
          taxYear: 2026,
          source: "test-ambiguous",
          statementTotal: { proceeds: 700, basis: 500, gain: 200 },
          rows: [
            {
              symbol: "DUPKEY",
              disposalDate: "2026-02-01",
              quantity: 10,
              currency: "USD",
              proceeds: 700,
              basis: 500,
              gain: 200,
            },
          ],
        },
      ],
    };

    const result = runReconciliation(db, config);
    expect(result.pass).toBe(false);
    expect(result.summary).toContain("ambiguous match");
  });

  it("wires cleanly into stampBrokerAcceptance on a passing result", () => {
    const db = createTestDb();
    seedDisposal(db, {
      accountId: ACCOUNT_ID,
      symbol: "WIRE",
      acquisitionDate: "2026-01-01",
      saleDate: "2026-02-01",
      quantity: 10,
      proceeds: 1000,
      basis: 800,
      gain: 200,
    });
    stampTaxLotsConvention(db);

    const config: BrokerRealizedConfig = {
      entries: [
        {
          accountId: ACCOUNT_ID,
          taxYear: 2026,
          source: "test-wire",
          statementTotal: { proceeds: 1000, basis: 800, gain: 200 },
          rows: [
            {
              symbol: "WIRE",
              disposalDate: "2026-02-01",
              quantity: 10,
              currency: "USD",
              proceeds: 1000,
              basis: 800,
              gain: 200,
            },
          ],
        },
      ],
    };

    const result = runReconciliation(db, config);
    expect(result.pass).toBe(true);

    db.transaction(() => {
      stampBrokerAcceptance(db, result.coverage);
    })();

    const state = getTaxConventionState(db);
    expect(state.acceptance.current).toBe(true);
    expect(state.acceptance.coverage).toEqual([{ accountId: ACCOUNT_ID, taxYear: 2026 }]);
  });
});
