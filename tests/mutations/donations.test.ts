import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getDonations,
  getDonationBySourceKey,
  getDonationsForYear,
} from "@/lib/queries/donations";
import type { DonationRow } from "@/lib/queries/donations";
import {
  insertDonation,
  upsertDonationMetadata,
  markDonationReversed,
  DonationIdentityConflictError,
} from "@/lib/mutations/donations";
import type { NewDonation } from "@/lib/mutations/donations";

function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function seedSecurity(db: Database.Database, symbol = "AAPL"): number {
  const r = db
    .prepare(`INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, ?)`)
    .run(symbol, `${symbol} Inc`, "Stock");
  return r.lastInsertRowid as number;
}

function stockDonation(overrides: Partial<NewDonation> = {}): NewDonation {
  return {
    sourceKey: "donation:2026-01-15:AAPL:10",
    kind: "stock",
    securityId: null,
    symbolRaw: "AAPL",
    quantity: 10,
    fmvUsd: 1750.5,
    unitValuation: 175.05,
    createdDate: "2026-01-10",
    receivedDate: "2026-01-15",
    completedDate: null,
    notes: null,
    ...overrides,
  };
}

describe("donations mutations + queries", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
  });

  it("1. insertDonation inserts a stock row and getDonationBySourceKey round-trips every field", () => {
    const securityId = seedSecurity(db);
    const d = stockDonation({ securityId });
    const id = insertDonation(db, d, null);
    expect(id).toBeGreaterThan(0);

    const row = getDonationBySourceKey(db, d.sourceKey);
    expect(row).not.toBeNull();
    const expected: DonationRow = {
      id,
      source_key: d.sourceKey,
      import_batch_id: null,
      kind: "stock",
      security_id: securityId,
      symbol_raw: "AAPL",
      quantity: 10,
      fmv_usd: 1750.5,
      unit_valuation: 175.05,
      created_date: "2026-01-10",
      received_date: "2026-01-15",
      completed_date: null,
      reversed_date: null,
      notes: null,
    };
    expect(row).toEqual(expected);
  });

  it("2. insertDonation with importBatchId null works (repair-path row)", () => {
    const d = stockDonation({
      sourceKey: "donation:2026-02-01:cash:500",
      kind: "cash",
      securityId: null,
      symbolRaw: null,
      quantity: null,
      fmvUsd: 500,
      unitValuation: null,
      receivedDate: "2026-02-01",
    });
    const id = insertDonation(db, d, null);
    const row = getDonationBySourceKey(db, d.sourceKey);
    expect(row).not.toBeNull();
    expect(row!.id).toBe(id);
    expect(row!.import_batch_id).toBeNull();
    expect(row!.kind).toBe("cash");
    expect(row!.fmv_usd).toBe(500);
  });

  it("3. upsertDonationMetadata fills completed_date -> 'updated'; repeat identical call -> 'unchanged'; import_batch_id unchanged", () => {
    const batch = db
      .prepare(`INSERT INTO import_batches (source_type) VALUES (?)`)
      .run("daf-contributions");
    const importBatchId = batch.lastInsertRowid as number;
    const d = stockDonation();
    insertDonation(db, d, importBatchId);

    const withCompletion: NewDonation = { ...d, completedDate: "2026-01-20", notes: "cleared" };
    const first = upsertDonationMetadata(db, withCompletion);
    expect(first).toBe("updated");

    const row1 = getDonationBySourceKey(db, d.sourceKey);
    expect(row1!.completed_date).toBe("2026-01-20");
    expect(row1!.notes).toBe("cleared");
    expect(row1!.import_batch_id).toBe(importBatchId);

    const second = upsertDonationMetadata(db, withCompletion);
    expect(second).toBe("unchanged");

    const row2 = getDonationBySourceKey(db, d.sourceKey);
    expect(row2!.import_batch_id).toBe(importBatchId);
  });

  it("4. upsertDonationMetadata with a different quantity throws DonationIdentityConflictError naming 'quantity'", () => {
    const d = stockDonation();
    insertDonation(db, d, null);

    const mutated: NewDonation = { ...d, quantity: 99 };
    expect(() => upsertDonationMetadata(db, mutated)).toThrow(DonationIdentityConflictError);
    try {
      upsertDonationMetadata(db, mutated);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(DonationIdentityConflictError);
      expect((err as DonationIdentityConflictError).field).toBe("quantity");
      expect((err as DonationIdentityConflictError).sourceKey).toBe(d.sourceKey);
    }
  });

  it("5. markDonationReversed sets reversed_date, deletes links + lots, and restores is_external_flow=1 on the routing_artifact leg", () => {
    const securityId = seedSecurity(db);
    const d = stockDonation({ securityId });
    const donationId = insertDonation(db, d, null);

    const outTxn = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, is_external_flow, source_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(1, securityId, "2026-01-15", "TRANSFER_OUT", -10, 0, 1, "txn:transfer-out:1");
    const outTxnId = outTxn.lastInsertRowid as number;

    const inTxn = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, is_external_flow, source_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(1, securityId, "2026-01-15", "TRANSFER_IN", 10, 0, 0, "txn:transfer-in:1");
    const inTxnId = inTxn.lastInsertRowid as number;

    db.prepare(
      `INSERT INTO donation_leg_links (donation_id, transaction_id, role) VALUES (?, ?, ?)`
    ).run(donationId, outTxnId, "out");
    db.prepare(
      `INSERT INTO donation_leg_links (donation_id, transaction_id, role) VALUES (?, ?, ?)`
    ).run(donationId, inTxnId, "routing_artifact");

    const acqTxn = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, source_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(1, securityId, "2025-06-01", "BUY", 10, -1000, "txn:buy:1");
    const acqTxnId = acqTxn.lastInsertRowid as number;
    db.prepare(
      `INSERT INTO donation_lots (donation_id, acquisition_transaction_id, quantity) VALUES (?, ?, ?)`
    ).run(donationId, acqTxnId, 10);

    markDonationReversed(db, donationId, "2026-01-25");

    const row = getDonationBySourceKey(db, d.sourceKey);
    expect(row!.reversed_date).toBe("2026-01-25");

    const links = db
      .prepare(`SELECT * FROM donation_leg_links WHERE donation_id = ?`)
      .all(donationId);
    expect(links).toHaveLength(0);

    const lots = db.prepare(`SELECT * FROM donation_lots WHERE donation_id = ?`).all(donationId);
    expect(lots).toHaveLength(0);

    const inTxnAfter = db
      .prepare(`SELECT is_external_flow FROM transactions WHERE id = ?`)
      .get(inTxnId) as { is_external_flow: number };
    expect(inTxnAfter.is_external_flow).toBe(1);
  });

  it("6. getDonationsForYear('2026') returns only 2026-received rows, newest first", () => {
    insertDonation(db, stockDonation({ sourceKey: "d:2025", receivedDate: "2025-12-20" }), null);
    insertDonation(db, stockDonation({ sourceKey: "d:2026-a", receivedDate: "2026-01-05" }), null);
    insertDonation(db, stockDonation({ sourceKey: "d:2026-b", receivedDate: "2026-06-30" }), null);
    insertDonation(db, stockDonation({ sourceKey: "d:2027", receivedDate: "2027-01-01" }), null);

    const rows = getDonationsForYear(db, "2026");
    expect(rows.map((r) => r.source_key)).toEqual(["d:2026-b", "d:2026-a"]);
  });

  it("getDonations returns all rows ordered by received_date DESC", () => {
    insertDonation(db, stockDonation({ sourceKey: "d:early", receivedDate: "2026-01-01" }), null);
    insertDonation(db, stockDonation({ sourceKey: "d:late", receivedDate: "2026-06-01" }), null);

    const rows = getDonations(db);
    expect(rows.map((r) => r.source_key)).toEqual(["d:late", "d:early"]);
  });

  it("getDonationBySourceKey returns null for unknown key", () => {
    expect(getDonationBySourceKey(db, "nope")).toBeNull();
  });
});
