/**
 * Shared seeding for the "basis verified" marker tests (owner request
 * 2026-10-07). Everything is synthetic: ZZ* tickers and round invented
 * numbers. Each helper takes the database, so every test file keeps its own
 * in-memory copy.
 */

import type Database from "better-sqlite3";
import { linkDonationLegs, assignDonationLots } from "@/lib/mutations/donation-links";
import { insertDonation } from "@/lib/mutations/donations";
import { computeTaxLots } from "@/lib/compute/tax-lots";

let seq = 0;

/** migration 002 seeds account 1 ('Vanguard Taxable'). */
export const FIXTURE_ACCOUNT_ID = 1;

export function seedSecurity(db: Database.Database, symbol: string): number {
  return db.prepare("INSERT INTO securities (symbol, currency, security_type) VALUES (?, 'USD', 'Stock')").run(symbol)
    .lastInsertRowid as number;
}

export function seedTxn(
  db: Database.Database,
  sec: number,
  date: string,
  type: string,
  qty: number,
  price: number,
  importBatchId: number | null = null
): number {
  seq++;
  return db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key, import_batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(FIXTURE_ACCOUNT_ID, sec, date, type, qty, price, qty * price, `basis-fixture-${seq}`, importBatchId)
    .lastInsertRowid as number;
}

/** A linked stock gift of `quantity` shares worth `fmvUsd`, not yet assigned to lots. */
export function seedGift(db: Database.Database, sec: number, date: string, quantity: number, fmvUsd: number): number {
  seq++;
  const out = seedTxn(db, sec, date, "TRANSFER_OUT", quantity, 0);
  const id = insertDonation(
    db,
    {
      sourceKey: `basis-fixture-don-${seq}`,
      kind: "stock",
      securityId: sec,
      symbolRaw: "ZZAA",
      quantity,
      fmvUsd,
      unitValuation: null,
      createdDate: null,
      receivedDate: date,
      completedDate: null,
      notes: null,
    },
    null
  );
  linkDonationLegs(db, { donationId: id, outTransactionId: out });
  return id;
}

export function assign(
  db: Database.Database,
  donationId: number,
  lots: { acquisitionTransactionId: number; quantity: number }[]
): void {
  computeTaxLots(db);
  assignDonationLots(db, donationId, lots);
  computeTaxLots(db);
}

/**
 * The owner's case: 100 shares carried in at a cent a share (so the lot's
 * whole basis is 1), 10 of them given at 100 a share. The basis is far under
 * 1% of the fair market value, so the row is flagged; its avoided gain is
 * 1,000 − 10 × 0.01 = 999.90.
 */
export function seedFlaggedGift(db: Database.Database, symbol = "ZZBB", date = "2026-04-02") {
  const sec = seedSecurity(db, symbol);
  const lotTxn = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 100, 0.01);
  const donationId = seedGift(db, sec, date, 10, 1000);
  assign(db, donationId, [{ acquisitionTransactionId: lotTxn, quantity: 10 }]);
  return { sec, lotTxn, donationId };
}

/** An ordinary gift: bought at 40 a share, given at 100 a share. Avoided gain 600. */
export function seedPlausibleGift(db: Database.Database, symbol = "ZZAA", date = "2026-03-02") {
  const sec = seedSecurity(db, symbol);
  const lotTxn = seedTxn(db, sec, "2020-01-10", "BUY", 100, 40);
  const donationId = seedGift(db, sec, date, 10, 1000);
  assign(db, donationId, [{ acquisitionTransactionId: lotTxn, quantity: 10 }]);
  return { sec, lotTxn, donationId };
}
