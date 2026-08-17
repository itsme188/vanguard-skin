import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  linkDonationLegs,
  unlinkDonationLegs,
  assignDonationLots,
  DonationLinkError,
  ARTIFACT_NOTE_SUFFIX,
} from "@/lib/mutations/donation-links";

function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

// Migration 002 seeds accounts 1='Vanguard Taxable', 2='Vanguard Roth IRA', 3='IBKR' — reuse those ids.

function seedSecurity(db: Database.Database, id: number, symbol: string, currency?: string) {
  if (currency) {
    db.prepare("INSERT INTO securities (id, symbol, currency) VALUES (?, ?, ?)").run(id, symbol, currency);
  } else {
    db.prepare("INSERT INTO securities (id, symbol) VALUES (?, ?)").run(id, symbol);
  }
}

interface TxnSeed {
  id: number;
  accountId: number;
  securityId: number | null;
  tradeDate: string;
  type: string;
  quantity: number | null;
  amount?: number | null;
  notes?: string | null;
  isExternalFlow?: number;
}
function seedTxn(db: Database.Database, t: TxnSeed) {
  db.prepare(
    `INSERT INTO transactions (id, account_id, security_id, trade_date, type, quantity, amount, is_external_flow, notes, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    t.id,
    t.accountId,
    t.securityId,
    t.tradeDate,
    t.type,
    t.quantity,
    t.amount ?? null,
    t.isExternalFlow ?? 1,
    t.notes ?? null,
    `txn-${t.id}`
  );
}

function getTxn(db: Database.Database, id: number) {
  return db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as {
    id: number;
    is_external_flow: number;
    notes: string | null;
    amount: number | null;
  };
}

interface DonationSeed {
  id: number;
  sourceKey?: string;
  kind: "stock" | "cash";
  securityId: number | null;
  quantity: number | null;
  fmvUsd: number;
  receivedDate?: string;
  reversedDate?: string | null;
}
function seedDonation(db: Database.Database, d: DonationSeed) {
  db.prepare(
    `INSERT INTO donations (id, source_key, kind, security_id, quantity, fmv_usd, received_date, reversed_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    d.id,
    d.sourceKey ?? `donation-${d.id}`,
    d.kind,
    d.securityId,
    d.quantity,
    d.fmvUsd,
    d.receivedDate ?? "2026-01-05",
    d.reversedDate ?? null
  );
}

interface TaxLotSeed {
  id: number;
  accountId: number;
  securityId: number;
  acquisitionTxnId: number;
  acquisitionDate: string;
  quantityAcquired: number;
  quantityRemaining: number;
  costBasis: number;
}
function seedTaxLot(db: Database.Database, l: TaxLotSeed) {
  db.prepare(
    `INSERT INTO tax_lots (id, account_id, security_id, acquisition_transaction_id, acquisition_date,
       acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    l.id,
    l.accountId,
    l.securityId,
    l.acquisitionTxnId,
    l.acquisitionDate,
    l.costBasis / l.quantityAcquired,
    l.quantityAcquired,
    l.quantityRemaining,
    l.costBasis
  );
}

function getDonationLinks(db: Database.Database, donationId: number) {
  return db
    .prepare("SELECT donation_id, transaction_id, role FROM donation_leg_links WHERE donation_id = ? ORDER BY role")
    .all(donationId) as { donation_id: number; transaction_id: number; role: string }[];
}

function getDonationLots(db: Database.Database, donationId: number) {
  return db
    .prepare(
      "SELECT acquisition_transaction_id, quantity FROM donation_lots WHERE donation_id = ? ORDER BY acquisition_transaction_id"
    )
    .all(donationId) as { acquisition_transaction_id: number; quantity: number }[];
}

describe("linkDonationLegs", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
    seedSecurity(db, 1, "AAPL"); // USD via column default
    seedSecurity(db, 2, "005930.KS", "KRW"); // non-USD

    // Base fixture: donation 1, quantity 10, security 1
    seedDonation(db, { id: 1, kind: "stock", securityId: 1, quantity: 10, fmvUsd: 1000 });
    // Base OUT leg matching donation 1 exactly
    seedTxn(db, { id: 101, accountId: 1, securityId: 1, tradeDate: "2026-01-05", type: "TRANSFER_OUT", quantity: 10 });
    // Base artifact leg matching the OUT leg exactly
    seedTxn(db, { id: 102, accountId: 1, securityId: 1, tradeDate: "2026-01-05", type: "TRANSFER_IN", quantity: 10 });
  });

  it("rejects when the donation does not exist", () => {
    expect(() => linkDonationLegs(db, { donationId: 999, outTransactionId: 101 })).toThrow(DonationLinkError);
    expect(() => linkDonationLegs(db, { donationId: 999, outTransactionId: 101 })).toThrow(/not found/);
  });

  it("rejects when the donation kind is not 'stock'", () => {
    seedDonation(db, { id: 2, kind: "cash", securityId: null, quantity: null, fmvUsd: 500 });
    expect(() => linkDonationLegs(db, { donationId: 2, outTransactionId: 101 })).toThrow(/stock/);
  });

  it("rejects when the donation has no security_id", () => {
    seedDonation(db, { id: 3, kind: "stock", securityId: null, quantity: 10, fmvUsd: 500 });
    expect(() => linkDonationLegs(db, { donationId: 3, outTransactionId: 101 })).toThrow(/security_id/);
  });

  it("rejects when the donation is reversed", () => {
    seedDonation(db, { id: 4, kind: "stock", securityId: 1, quantity: 10, fmvUsd: 500, reversedDate: "2026-01-10" });
    expect(() => linkDonationLegs(db, { donationId: 4, outTransactionId: 101 })).toThrow(/reversed/);
  });

  it("rejects when the security is not USD-denominated", () => {
    seedDonation(db, { id: 5, kind: "stock", securityId: 2, quantity: 10, fmvUsd: 500 });
    seedTxn(db, { id: 201, accountId: 1, securityId: 2, tradeDate: "2026-01-05", type: "TRANSFER_OUT", quantity: 10 });
    expect(() => linkDonationLegs(db, { donationId: 5, outTransactionId: 201 })).toThrow(/USD/);
  });

  it("rejects when the OUT transaction does not exist", () => {
    expect(() => linkDonationLegs(db, { donationId: 1, outTransactionId: 999 })).toThrow(/not found/);
  });

  it("rejects when the OUT transaction type is not TRANSFER_OUT", () => {
    seedTxn(db, { id: 103, accountId: 1, securityId: 1, tradeDate: "2026-01-05", type: "SELL", quantity: 10 });
    expect(() => linkDonationLegs(db, { donationId: 1, outTransactionId: 103 })).toThrow(/TRANSFER_OUT/);
  });

  it("rejects when the OUT transaction is a different security than the donation", () => {
    seedTxn(db, { id: 104, accountId: 1, securityId: 2, tradeDate: "2026-01-05", type: "TRANSFER_OUT", quantity: 10 });
    expect(() => linkDonationLegs(db, { donationId: 1, outTransactionId: 104 })).toThrow(/different security/);
  });

  it("rejects when the OUT transaction quantity is null", () => {
    seedTxn(db, { id: 105, accountId: 1, securityId: 1, tradeDate: "2026-01-05", type: "TRANSFER_OUT", quantity: null });
    expect(() => linkDonationLegs(db, { donationId: 1, outTransactionId: 105 })).toThrow(/quantity/);
  });

  it("rejects when the OUT transaction quantity does not match the donation quantity", () => {
    seedTxn(db, { id: 106, accountId: 1, securityId: 1, tradeDate: "2026-01-05", type: "TRANSFER_OUT", quantity: 7 });
    expect(() => linkDonationLegs(db, { donationId: 1, outTransactionId: 106 })).toThrow(/quantity/);
  });

  it("accepts OUT quantity within 1e-9 tolerance of the donation quantity", () => {
    seedTxn(db, { id: 199, accountId: 1, securityId: 1, tradeDate: "2026-01-05", type: "TRANSFER_OUT", quantity: 10 + 1e-10 });
    expect(() => linkDonationLegs(db, { donationId: 1, outTransactionId: 199 })).not.toThrow();
  });

  it("rejects when the artifact transaction does not exist", () => {
    expect(() =>
      linkDonationLegs(db, { donationId: 1, outTransactionId: 101, artifactTransactionId: 999 })
    ).toThrow(/not found/);
  });

  it("rejects when the artifact transaction type is not TRANSFER_IN", () => {
    seedTxn(db, { id: 107, accountId: 1, securityId: 1, tradeDate: "2026-01-05", type: "BUY", quantity: 10 });
    expect(() =>
      linkDonationLegs(db, { donationId: 1, outTransactionId: 101, artifactTransactionId: 107 })
    ).toThrow(/TRANSFER_IN/);
  });

  it("rejects when the artifact transaction is a different security than the OUT leg", () => {
    seedTxn(db, { id: 108, accountId: 1, securityId: 2, tradeDate: "2026-01-05", type: "TRANSFER_IN", quantity: 10 });
    expect(() =>
      linkDonationLegs(db, { donationId: 1, outTransactionId: 101, artifactTransactionId: 108 })
    ).toThrow(/different security/);
  });

  it("rejects when the artifact transaction is in a different account than the OUT leg", () => {
    seedTxn(db, { id: 109, accountId: 2, securityId: 1, tradeDate: "2026-01-05", type: "TRANSFER_IN", quantity: 10 });
    expect(() =>
      linkDonationLegs(db, { donationId: 1, outTransactionId: 101, artifactTransactionId: 109 })
    ).toThrow(/different account/);
  });

  it("rejects when the artifact transaction trade_date differs from the OUT leg", () => {
    seedTxn(db, { id: 110, accountId: 1, securityId: 1, tradeDate: "2026-01-06", type: "TRANSFER_IN", quantity: 10 });
    expect(() =>
      linkDonationLegs(db, { donationId: 1, outTransactionId: 101, artifactTransactionId: 110 })
    ).toThrow(/trade date/);
  });

  it("rejects when the OUT/artifact quantities are not zero-net", () => {
    seedTxn(db, { id: 111, accountId: 1, securityId: 1, tradeDate: "2026-01-05", type: "TRANSFER_IN", quantity: 8 });
    expect(() =>
      linkDonationLegs(db, { donationId: 1, outTransactionId: 101, artifactTransactionId: 111 })
    ).toThrow(/zero-net/);
  });

  it("rejects when the OUT transaction is already linked to another donation", () => {
    seedDonation(db, { id: 6, kind: "stock", securityId: 1, quantity: 10, fmvUsd: 500 });
    db.prepare("INSERT INTO donation_leg_links (donation_id, transaction_id, role) VALUES (6, 101, 'out')").run();
    expect(() => linkDonationLegs(db, { donationId: 1, outTransactionId: 101 })).toThrow(/already linked/);
  });

  it("rejects when the artifact transaction is already linked to another donation", () => {
    seedDonation(db, { id: 6, kind: "stock", securityId: 1, quantity: 10, fmvUsd: 500 });
    db.prepare("INSERT INTO donation_leg_links (donation_id, transaction_id, role) VALUES (6, 102, 'routing_artifact')").run();
    expect(() =>
      linkDonationLegs(db, { donationId: 1, outTransactionId: 101, artifactTransactionId: 102 })
    ).toThrow(/already linked/);
  });

  it("rejects when outTransactionId and artifactTransactionId are the same transaction", () => {
    expect(() =>
      linkDonationLegs(db, { donationId: 1, outTransactionId: 101, artifactTransactionId: 101 })
    ).toThrow(DonationLinkError);
    expect(() =>
      linkDonationLegs(db, { donationId: 1, outTransactionId: 101, artifactTransactionId: 101 })
    ).toThrow(/must differ/);
  });

  it("links OUT + artifact legs, demotes the artifact leg, and stamps the OUT amount", () => {
    linkDonationLegs(db, { donationId: 1, outTransactionId: 101, artifactTransactionId: 102, amountForOutLeg: 950 });

    const links = getDonationLinks(db, 1);
    expect(links).toEqual([
      { donation_id: 1, transaction_id: 101, role: "out" },
      { donation_id: 1, transaction_id: 102, role: "routing_artifact" },
    ]);

    const artifact = getTxn(db, 102);
    expect(artifact.is_external_flow).toBe(0);
    expect(artifact.notes).toBe(ARTIFACT_NOTE_SUFFIX.trim());

    const out = getTxn(db, 101);
    expect(out.amount).toBe(950);
  });

  it("appends the note suffix to existing artifact notes rather than overwriting them", () => {
    seedTxn(db, {
      id: 112,
      accountId: 1,
      securityId: 1,
      tradeDate: "2026-01-05",
      type: "TRANSFER_IN",
      quantity: 10,
      notes: "Some existing note",
    });
    linkDonationLegs(db, { donationId: 1, outTransactionId: 101, artifactTransactionId: 112 });
    const artifact = getTxn(db, 112);
    expect(artifact.notes).toBe(`Some existing note${ARTIFACT_NOTE_SUFFIX}`);
  });

  it("links an OUT-only donation (no artifact leg) without touching is_external_flow", () => {
    linkDonationLegs(db, { donationId: 1, outTransactionId: 101 });
    const links = getDonationLinks(db, 1);
    expect(links).toEqual([{ donation_id: 1, transaction_id: 101, role: "out" }]);
    const out = getTxn(db, 101);
    expect(out.is_external_flow).toBe(1); // untouched, seeded default
  });

  it("does not stamp the OUT amount when amountForOutLeg is omitted", () => {
    seedTxn(db, { id: 113, accountId: 1, securityId: 1, tradeDate: "2026-01-05", type: "TRANSFER_OUT", quantity: 10, amount: 42 });
    linkDonationLegs(db, { donationId: 1, outTransactionId: 113 });
    expect(getTxn(db, 113).amount).toBe(42);
  });
});

describe("unlinkDonationLegs", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
    seedSecurity(db, 1, "AAPL");
    seedDonation(db, { id: 1, kind: "stock", securityId: 1, quantity: 10, fmvUsd: 1000 });
    seedTxn(db, { id: 101, accountId: 1, securityId: 1, tradeDate: "2026-01-05", type: "TRANSFER_OUT", quantity: 10 });
    seedTxn(db, { id: 102, accountId: 1, securityId: 1, tradeDate: "2026-01-05", type: "TRANSFER_IN", quantity: 10, notes: "Original note" });
  });

  it("restores is_external_flow and strips the note suffix on a demoted artifact leg", () => {
    linkDonationLegs(db, { donationId: 1, outTransactionId: 101, artifactTransactionId: 102, amountForOutLeg: 950 });
    unlinkDonationLegs(db, 1);

    expect(getDonationLinks(db, 1)).toHaveLength(0);
    const artifact = getTxn(db, 102);
    expect(artifact.is_external_flow).toBe(1);
    expect(artifact.notes).toBe("Original note");
  });

  it("does not touch amounts on unlink", () => {
    linkDonationLegs(db, { donationId: 1, outTransactionId: 101, artifactTransactionId: 102, amountForOutLeg: 950 });
    unlinkDonationLegs(db, 1);
    expect(getTxn(db, 101).amount).toBe(950);
  });

  it("restores a NULL-notes artifact leg back to NULL (not empty string)", () => {
    seedTxn(db, { id: 103, accountId: 1, securityId: 1, tradeDate: "2026-01-05", type: "TRANSFER_IN", quantity: 10 });
    linkDonationLegs(db, { donationId: 1, outTransactionId: 101, artifactTransactionId: 103 });
    unlinkDonationLegs(db, 1);
    expect(getTxn(db, 103).notes).toBeNull();
  });

  it("removes an OUT-only link without touching any flow flag", () => {
    linkDonationLegs(db, { donationId: 1, outTransactionId: 101 });
    unlinkDonationLegs(db, 1);
    expect(getDonationLinks(db, 1)).toHaveLength(0);
  });
});

describe("assignDonationLots", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
    seedSecurity(db, 1, "AAPL");
    seedSecurity(db, 2, "005930.KS", "KRW");

    // Donation 1: confirmed out link, quantity 10, security 1
    seedDonation(db, { id: 1, kind: "stock", securityId: 1, quantity: 10, fmvUsd: 1000, receivedDate: "2026-01-10" });
    seedTxn(db, { id: 101, accountId: 1, securityId: 1, tradeDate: "2026-01-10", type: "TRANSFER_OUT", quantity: 10 });
    linkDonationLegs(db, { donationId: 1, outTransactionId: 101 });

    // Acquisition lot: BUY on 2026-01-02, 10 shares, all remaining
    seedTxn(db, { id: 201, accountId: 1, securityId: 1, tradeDate: "2026-01-02", type: "BUY", quantity: 10 });
    seedTaxLot(db, {
      id: 301,
      accountId: 1,
      securityId: 1,
      acquisitionTxnId: 201,
      acquisitionDate: "2026-01-02",
      quantityAcquired: 10,
      quantityRemaining: 10,
      costBasis: 1500,
    });
  });

  it("rejects when the donation has no confirmed out link", () => {
    seedDonation(db, { id: 2, kind: "stock", securityId: 1, quantity: 10, fmvUsd: 500 });
    expect(() => assignDonationLots(db, 2, [{ acquisitionTransactionId: 201, quantity: 5 }])).toThrow(/out link/);
  });

  it("rejects when the donation's security is not USD-denominated", () => {
    // linkDonationLegs itself refuses to link a non-USD donation, so this exercises
    // assignDonationLots' own (redundant, defensive) USD guard directly — seed the
    // out link with a raw INSERT to simulate a link that predates that invariant.
    seedDonation(db, { id: 3, kind: "stock", securityId: 2, quantity: 10, fmvUsd: 500, receivedDate: "2026-01-10" });
    seedTxn(db, { id: 401, accountId: 1, securityId: 2, tradeDate: "2026-01-10", type: "TRANSFER_OUT", quantity: 10 });
    db.prepare("INSERT INTO donation_leg_links (donation_id, transaction_id, role) VALUES (3, 401, 'out')").run();

    seedTxn(db, { id: 402, accountId: 1, securityId: 2, tradeDate: "2026-01-02", type: "BUY", quantity: 10 });
    seedTaxLot(db, {
      id: 501,
      accountId: 1,
      securityId: 2,
      acquisitionTxnId: 402,
      acquisitionDate: "2026-01-02",
      quantityAcquired: 10,
      quantityRemaining: 10,
      costBasis: 1500,
    });

    expect(() => assignDonationLots(db, 3, [{ acquisitionTransactionId: 402, quantity: 5 }])).toThrow(/USD/);
  });

  it("rejects when the acquisition transaction is not a lot-creating type", () => {
    seedTxn(db, { id: 202, accountId: 1, securityId: 1, tradeDate: "2026-01-03", type: "DIVIDEND", quantity: null });
    expect(() => assignDonationLots(db, 1, [{ acquisitionTransactionId: 202, quantity: 5 }])).toThrow(/lot-creating/);
  });

  it("rejects when the acquisition transaction is a different security", () => {
    seedTxn(db, { id: 203, accountId: 1, securityId: 2, tradeDate: "2026-01-02", type: "BUY", quantity: 5 });
    expect(() => assignDonationLots(db, 1, [{ acquisitionTransactionId: 203, quantity: 5 }])).toThrow(/different security/);
  });

  it("rejects when the acquisition transaction is in a different account than the OUT leg", () => {
    seedTxn(db, { id: 204, accountId: 2, securityId: 1, tradeDate: "2026-01-02", type: "BUY", quantity: 5 });
    expect(() => assignDonationLots(db, 1, [{ acquisitionTransactionId: 204, quantity: 5 }])).toThrow(/different account/);
  });

  it("rejects when the acquisition transaction trade_date is not before the OUT leg trade_date", () => {
    seedTxn(db, { id: 205, accountId: 1, securityId: 1, tradeDate: "2026-01-10", type: "BUY", quantity: 5 });
    seedTaxLot(db, {
      id: 302,
      accountId: 1,
      securityId: 1,
      acquisitionTxnId: 205,
      acquisitionDate: "2026-01-10",
      quantityAcquired: 5,
      quantityRemaining: 5,
      costBasis: 750,
    });
    expect(() => assignDonationLots(db, 1, [{ acquisitionTransactionId: 205, quantity: 5 }])).toThrow(/trade date/);
  });

  it("rejects with a 'no lot' message when no tax_lots row exists for the acquisition transaction", () => {
    seedTxn(db, { id: 206, accountId: 1, securityId: 1, tradeDate: "2026-01-03", type: "BUY", quantity: 5 });
    expect(() => assignDonationLots(db, 1, [{ acquisitionTransactionId: 206, quantity: 3 }])).toThrow(/no lot/);
  });

  it("rejects when the requested quantity exceeds the lot's available quantity_remaining", () => {
    expect(() => assignDonationLots(db, 1, [{ acquisitionTransactionId: 201, quantity: 15 }])).toThrow(/available/);
  });

  it("rejects when the sum of assigned quantities exceeds the donation's quantity", () => {
    seedTxn(db, { id: 207, accountId: 1, securityId: 1, tradeDate: "2026-01-03", type: "BUY", quantity: 20 });
    seedTaxLot(db, {
      id: 303,
      accountId: 1,
      securityId: 1,
      acquisitionTxnId: 207,
      acquisitionDate: "2026-01-03",
      quantityAcquired: 20,
      quantityRemaining: 20,
      costBasis: 3000,
    });
    expect(() =>
      assignDonationLots(db, 1, [
        { acquisitionTransactionId: 201, quantity: 6 },
        { acquisitionTransactionId: 207, quantity: 6 },
      ])
    ).toThrow(/exceeds/);
  });

  it("rejects when the same acquisitionTransactionId appears more than once in one call", () => {
    // Donation quantity (20) and per-entry availability (lot capacity 10, 8 each) are both
    // generous enough that only the duplicate-id check — not the sum check or the per-entry
    // availability check — can catch this.
    seedDonation(db, { id: 5, kind: "stock", securityId: 1, quantity: 20, fmvUsd: 2000, receivedDate: "2026-01-10" });
    seedTxn(db, { id: 501, accountId: 1, securityId: 1, tradeDate: "2026-01-10", type: "TRANSFER_OUT", quantity: 20 });
    linkDonationLegs(db, { donationId: 5, outTransactionId: 501 });

    const duplicateAssignments = [
      { acquisitionTransactionId: 201, quantity: 8 },
      { acquisitionTransactionId: 201, quantity: 8 },
    ];
    expect(() => assignDonationLots(db, 5, duplicateAssignments)).toThrow(DonationLinkError);
    expect(() => assignDonationLots(db, 5, duplicateAssignments)).toThrow(/more than once/);
    // No partial write from the rejected call.
    expect(getDonationLots(db, 5)).toEqual([]);
  });

  it("assigns lots within quantity, replaces on a second call, and clears with an empty array", () => {
    assignDonationLots(db, 1, [{ acquisitionTransactionId: 201, quantity: 5 }]);
    expect(getDonationLots(db, 1)).toEqual([{ acquisition_transaction_id: 201, quantity: 5 }]);

    // Replace: still allowed because "own existing assignment" (5) is added back to available capacity.
    assignDonationLots(db, 1, [{ acquisitionTransactionId: 201, quantity: 8 }]);
    expect(getDonationLots(db, 1)).toEqual([{ acquisition_transaction_id: 201, quantity: 8 }]);

    // Clear.
    assignDonationLots(db, 1, []);
    expect(getDonationLots(db, 1)).toEqual([]);
  });

  it("two-donations-one-lot: donation B's assignable quantity shrinks by donation A's consumption", () => {
    // Donation A (donation 1 fixture) assigns 5 from the lot (quantity_remaining 10).
    assignDonationLots(db, 1, [{ acquisitionTransactionId: 201, quantity: 5 }]);

    // Simulate a recompute that consumed A's 5 units from the shared lot.
    db.prepare("UPDATE tax_lots SET quantity_remaining = 5 WHERE id = 301").run();

    // Donation B: separate donation + its own out link, same security/account.
    seedDonation(db, { id: 4, kind: "stock", securityId: 1, quantity: 10, fmvUsd: 800, receivedDate: "2026-01-12" });
    seedTxn(db, { id: 401, accountId: 1, securityId: 1, tradeDate: "2026-01-12", type: "TRANSFER_OUT", quantity: 10 });
    linkDonationLegs(db, { donationId: 4, outTransactionId: 401 });

    // Over-asking (6 of the remaining 5) rejects.
    expect(() => assignDonationLots(db, 4, [{ acquisitionTransactionId: 201, quantity: 6 }])).toThrow(/available/);

    // Asking exactly what's left (5) succeeds.
    assignDonationLots(db, 4, [{ acquisitionTransactionId: 201, quantity: 5 }]);
    expect(getDonationLots(db, 4)).toEqual([{ acquisition_transaction_id: 201, quantity: 5 }]);
  });

  it("accepts cross-donation over-assignment at write time — engine clamp is the authority", () => {
    // Design boundary (reversed 2026-08-17 after proving the alternative — an other-donations
    // subtraction — permanently double-counts any already-recomputed claim, which is strictly
    // worse): assignDonationLots' availability check is best-effort against tax_lots' state as
    // of the last recompute. It does NOT consult other donations' pending (not-yet-recomputed)
    // donation_lots claims, so two donations can legitimately over-commit the same lot between
    // recomputes at write time. computeTaxLots is the authoritative guard — it clamps the
    // over-committed lot to 0 and emits a replay warning naming the donation
    // (tests/compute/tax-lots-donations.test.ts case 7: "defensive clamp"). In practice this
    // window is closed by the route-level recompute-after-write (Task 12), which reruns
    // computeTaxLots immediately after every assignDonationLots write.
    seedTxn(db, { id: 601, accountId: 1, securityId: 1, tradeDate: "2026-01-01", type: "BUY", quantity: 100 });
    seedTaxLot(db, {
      id: 601,
      accountId: 1,
      securityId: 1,
      acquisitionTxnId: 601,
      acquisitionDate: "2026-01-01",
      quantityAcquired: 100,
      quantityRemaining: 100,
      costBasis: 10000,
    });

    // Donation A assigns 60 of the 100-lot. NO recompute afterward — quantity_remaining stays 100.
    seedDonation(db, { id: 20, kind: "stock", securityId: 1, quantity: 60, fmvUsd: 6000, receivedDate: "2026-01-15" });
    seedTxn(db, { id: 701, accountId: 1, securityId: 1, tradeDate: "2026-01-15", type: "TRANSFER_OUT", quantity: 60 });
    linkDonationLegs(db, { donationId: 20, outTransactionId: 701 });
    expect(() => assignDonationLots(db, 20, [{ acquisitionTransactionId: 601, quantity: 60 }])).not.toThrow();

    // Donation B targets the same lot with NO recompute between the two writes. Its own
    // per-entry check only sees the stale quantity_remaining (100), so 50 (which, combined
    // with A's 60, over-commits the 100-share lot by 10) is sanctioned to succeed here.
    seedDonation(db, { id: 21, kind: "stock", securityId: 1, quantity: 50, fmvUsd: 5000, receivedDate: "2026-01-16" });
    seedTxn(db, { id: 702, accountId: 1, securityId: 1, tradeDate: "2026-01-16", type: "TRANSFER_OUT", quantity: 50 });
    linkDonationLegs(db, { donationId: 21, outTransactionId: 702 });
    expect(() => assignDonationLots(db, 21, [{ acquisitionTransactionId: 601, quantity: 50 }])).not.toThrow();

    expect(getDonationLots(db, 20)).toEqual([{ acquisition_transaction_id: 601, quantity: 60 }]);
    expect(getDonationLots(db, 21)).toEqual([{ acquisition_transaction_id: 601, quantity: 50 }]);
  });
});
