/**
 * Task 4 (number-trust durable fixes) regression coverage for getGivingView:
 * the basis/gainAvoided formula (`cost_basis / quantity_acquired × quantity`)
 * was already correct once Task 3 made tax_lots.cost_basis store TRUE
 * ECONOMIC DOLLARS (bond ÷100, option ×multiplier) — no formula change here,
 * just proof it inherits the v2 dollar convention correctly for an option
 * lot, plus the new `conventionPending` field.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getGivingView } from "@/lib/queries/giving-view";
import { bumpTaxInputGeneration, stampTaxLotsConvention } from "@/lib/compute/tax-convention";

function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

// Migration 002 seeds accounts 1='Vanguard Taxable', 2='Vanguard Roth IRA', 3='IBKR'.

describe("getGivingView", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = fresh();
  });

  it("a donated OPTION lot's basis/gainAvoided come out in economic dollars (×multiplier), not the raw contract price", () => {
    const optId = db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, multiplier, underlying_symbol, option_type)
         VALUES ('AAPL  260619C00180000', 'AAPL Call', 'option', 100, 'AAPL', 'CALL')`
      )
      .run().lastInsertRowid as number;

    // Acquisition leg: BUY_TO_OPEN 1 contract @ $2.50 → true economic cost
    // $250 (Task 3's engine would compute this same figure; this test
    // isolates the READER by seeding the v2 lot directly, mirroring
    // tests/mutations/donation-links.test.ts's seedTaxLot pattern).
    const acqTxnId = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, source_key)
         VALUES (1, ?, '2025-01-15', 'BUY_TO_OPEN', 1, 2.5, 'test:acq')`
      )
      .run(optId).lastInsertRowid as number;

    db.prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_transaction_id, acquisition_date,
         acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (1, ?, ?, '2025-01-15', 2.5, 1, 1, 250)`
    ).run(optId, acqTxnId);

    // OUT leg: the donated contract leaves the account.
    const outTxnId = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, source_key)
         VALUES (1, ?, '2026-02-01', 'TRANSFER_OUT', 1, 'test:out')`
      )
      .run(optId).lastInsertRowid as number;

    const donationId = db
      .prepare(
        `INSERT INTO donations (source_key, kind, security_id, quantity, fmv_usd, received_date)
         VALUES ('test:donation', 'stock', ?, 1, 400, '2026-02-01')`
      )
      .run(optId).lastInsertRowid as number;

    db.prepare(`INSERT INTO donation_leg_links (donation_id, transaction_id, role) VALUES (?, ?, 'out')`).run(
      donationId,
      outTxnId
    );
    db.prepare(`INSERT INTO donation_lots (donation_id, acquisition_transaction_id, quantity) VALUES (?, ?, 1)`).run(
      donationId,
      acqTxnId
    );

    const view = getGivingView(db);
    expect(view.years).toHaveLength(1);
    const [year] = view.years;
    expect(year.donations).toHaveLength(1);
    const gd = year.donations[0];

    // Pre-fix, per-share math against the RAW per-contract price would have
    // read basis as $2.50 (contract price, not economic dollars). The v2
    // stored cost_basis is already ×multiplier, so basis must land at $250.
    expect(gd.basis).toBeCloseTo(250, 2);
    expect(gd.gainAvoided).toBeCloseTo(150, 2); // 400 fmv - 250 basis
    expect(year.gainAvoided).toBeCloseTo(150, 2);
  });

  it("conventionPending is false right after a stamped recompute, true once the generation moves past it", () => {
    stampTaxLotsConvention(db); // simulates computeTaxLots' own post-recompute stamp
    expect(getGivingView(db).conventionPending).toBe(false);

    bumpTaxInputGeneration(db); // a new tax-relevant mutation, no recompute yet
    expect(getGivingView(db).conventionPending).toBe(true);
  });
});
