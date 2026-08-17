import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { linkDonationLegs, assignDonationLots } from "@/lib/mutations/donation-links";
import { insertDonation, markDonationReversed } from "@/lib/mutations/donations";

// ── Seeding helpers ───────────────────────────────────────────────────────
// Copied from tests/compute/tax-lots-splits.test.ts (same engine, sibling
// suite) so the two replay suites seed identically; insertTxn additionally
// returns the new transaction id, which donation linking/assignment needs.

function setup() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // Migrations seed default accounts, including one named 'IBKR' — reuse it
  // rather than inserting a duplicate (accounts.name is UNIQUE). 'Roth' is
  // distinct from the seeded 'Vanguard Roth IRA', so it's inserted fresh.
  db.prepare("INSERT INTO accounts (name) VALUES ('Roth')").run();
  db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
  const ibkr = (db.prepare("SELECT id FROM accounts WHERE name='IBKR'").get() as { id: number }).id;
  const roth = (db.prepare("SELECT id FROM accounts WHERE name='Roth'").get() as { id: number }).id;
  const sec = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
  return { db, ibkr, roth, sec };
}

function insertTxn(db: Database.Database, accountId: number, secId: number,
  date: string, type: string, qty: number, price: number, key: string): number {
  const r = db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(accountId, secId, date, type, qty, price, qty * price, key);
  return r.lastInsertRowid as number;
}

function insertSplit(db: Database.Database, secId: number, accountId: number | null,
  date: string, num: number, den: number, delta: number | null, source = "import") {
  db.prepare(
    `INSERT INTO corporate_actions
       (security_id, account_id, action_type, effective_date, ratio_numerator, ratio_denominator,
        applied, source, source_key, quantity_delta)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  ).run(secId, accountId, num >= den ? "SPLIT" : "REVERSE_SPLIT", date, num, den, source,
        source === "import" ? `ibkr:ca:split:${date}:AAAA:${num}:${den}` : null, delta);
}

// Mirrors tests/compute/tax-lots-reconcile-close.test.ts's seed helpers —
// the RECONCILE_CLOSE pass only fires for stocks/ETFs, so the security must
// be typed for these tests.
function seedHolding(db: Database.Database, accountId: number, secId: number,
  quantity: number, asOfDate: string) {
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, 0, ?, ?)`,
  ).run(accountId, secId, quantity, asOfDate, `test-hold-${accountId}-${secId}-${asOfDate}`);
}

function seedPrice(db: Database.Database, secId: number, date: string, price: number) {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')",
  ).run(secId, date, price);
}

let donationSeq = 0;

/**
 * Seeds the confirmed half of a stock donation: the outbound TRANSFER_OUT leg,
 * the donations row, and the `out` leg link. Lot assignment is deliberately NOT
 * done here — `assignDonationLots` validates against `tax_lots.quantity_remaining`,
 * so callers must run computeTaxLots() once to materialize lots, then assign,
 * then recompute to observe consumption.
 */
function seedDonationLeg(db: Database.Database, opts: {
  accountId: number; secId: number; date: string; quantity: number;
}): { donationId: number; outTxnId: number } {
  donationSeq++;
  const outTxnId = insertTxn(db, opts.accountId, opts.secId, opts.date, "TRANSFER_OUT",
    opts.quantity, 0, `donation-out-${donationSeq}`);
  const donationId = insertDonation(db, {
    sourceKey: `daf:donation:${donationSeq}`,
    kind: "stock",
    securityId: opts.secId,
    symbolRaw: "AAAA",
    quantity: opts.quantity,
    fmvUsd: 1000,
    unitValuation: null,
    createdDate: null,
    receivedDate: opts.date,
    completedDate: null,
    notes: null,
  }, null);
  linkDonationLegs(db, { donationId, outTransactionId: outTxnId });
  return { donationId, outTxnId };
}

function lots(db: Database.Database) {
  return db
    .prepare("SELECT id, acquisition_transaction_id, quantity_remaining, acquisition_price FROM tax_lots ORDER BY acquisition_date, id")
    .all() as Array<{ id: number; acquisition_transaction_id: number; quantity_remaining: number; acquisition_price: number }>;
}

function saleRows(db: Database.Database) {
  return db
    .prepare("SELECT quantity_sold, cost_basis_allocated, realized_gain_loss FROM tax_lot_sales ORDER BY id")
    .all() as Array<{ quantity_sold: number; cost_basis_allocated: number; realized_gain_loss: number }>;
}

describe("computeTaxLots: donation-consumption replay events", () => {
  it("1. basic: a donated lot's quantity_remaining drops with no sale row and no realized gain", () => {
    const { db, ibkr, sec } = setup();
    const buyId = insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");
    const { donationId } = seedDonationLeg(db, { accountId: ibkr, secId: sec, date: "2026-07-01", quantity: 40 });

    computeTaxLots(db); // materialize lots so the assignment can validate
    assignDonationLots(db, donationId, [{ acquisitionTransactionId: buyId, quantity: 40 }]);
    const result = computeTaxLots(db);

    expect(lots(db)[0].quantity_remaining).toBeCloseTo(60);
    expect(result.donationsConsumed).toBe(1);
    expect(saleRows(db)).toHaveLength(0);
    expect(result.totalRealizedGain).toBeCloseTo(0);
    expect(result.replayWarnings).toHaveLength(0);
  });

  it("2. partial multi-lot: assignments consume each named lot independently", () => {
    const { db, ibkr, sec } = setup();
    const buyA = insertTxn(db, ibkr, sec, "2026-05-01", "BUY", 50, 300, "k1");
    const buyB = insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 50, 400, "k2");
    const { donationId } = seedDonationLeg(db, { accountId: ibkr, secId: sec, date: "2026-07-01", quantity: 50 });

    computeTaxLots(db);
    assignDonationLots(db, donationId, [
      { acquisitionTransactionId: buyA, quantity: 30 },
      { acquisitionTransactionId: buyB, quantity: 20 },
    ]);
    const result = computeTaxLots(db);

    const byTxn = new Map(lots(db).map((l) => [l.acquisition_transaction_id, l.quantity_remaining]));
    expect(byTxn.get(buyA)).toBeCloseTo(20);
    expect(byTxn.get(buyB)).toBeCloseTo(30);
    expect(result.donationsConsumed).toBe(2);
    expect(saleRows(db)).toHaveLength(0);
  });

  it("3. same-day ordering: the sell processes first, then the donation consumes what's left", () => {
    const { db, ibkr, sec } = setup();
    const buyId = insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");
    insertTxn(db, ibkr, sec, "2026-07-01", "SELL", 30, 420, "k2");
    const { donationId } = seedDonationLeg(db, { accountId: ibkr, secId: sec, date: "2026-07-01", quantity: 40 });

    computeTaxLots(db);
    // Post-sell remaining is 70, so a 40-share assignment is valid at write time.
    assignDonationLots(db, donationId, [{ acquisitionTransactionId: buyId, quantity: 40 }]);
    const result = computeTaxLots(db);

    const sales = saleRows(db);
    expect(sales).toHaveLength(1);
    expect(sales[0].quantity_sold).toBeCloseTo(30);          // sell saw the full 100-share lot
    expect(sales[0].cost_basis_allocated).toBeCloseTo(12000);
    expect(lots(db)[0].quantity_remaining).toBeCloseTo(30);  // 100 − 30 sold − 40 donated
    expect(result.donationsConsumed).toBe(1);
  });

  it("4. split BEFORE the donation: consumption comes out of post-split units", () => {
    const { db, ibkr, sec } = setup();
    const buyId = insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");
    insertSplit(db, sec, ibkr, "2026-07-01", 2, 1, null);
    const { donationId } = seedDonationLeg(db, { accountId: ibkr, secId: sec, date: "2026-08-01", quantity: 40 });

    computeTaxLots(db);
    assignDonationLots(db, donationId, [{ acquisitionTransactionId: buyId, quantity: 40 }]);
    const result = computeTaxLots(db);

    const lot = lots(db)[0];
    expect(lot.quantity_remaining).toBeCloseTo(160);         // (100 × 2) − 40
    expect(lot.acquisition_price).toBeCloseTo(200);
    expect(result.donationsConsumed).toBe(1);
  });

  it("5. split ON the donation date: sell then donation process pre-split, then the split doubles the remainder", () => {
    const { db, ibkr, sec } = setup();
    const buyId = insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");
    insertTxn(db, ibkr, sec, "2026-07-01", "SELL", 30, 420, "k2");
    const { donationId } = seedDonationLeg(db, { accountId: ibkr, secId: sec, date: "2026-07-01", quantity: 20 });
    // Broker's stated share delta: the 50 shares still open after the same-day
    // sell + donation gain 50 more when the 2:1 split applies at end of day.
    insertSplit(db, sec, ibkr, "2026-07-01", 2, 1, 50);

    computeTaxLots(db);
    assignDonationLots(db, donationId, [{ acquisitionTransactionId: buyId, quantity: 20 }]);
    const result = computeTaxLots(db);

    const sales = saleRows(db);
    expect(sales).toHaveLength(1);
    expect(sales[0].quantity_sold).toBeCloseTo(30);          // pre-split units
    expect(sales[0].cost_basis_allocated).toBeCloseTo(12000);
    const lot = lots(db)[0];
    expect(lot.quantity_remaining).toBeCloseTo(100);         // (100 − 30 − 20) × 2
    expect(lot.acquisition_price).toBeCloseTo(200);
    expect(result.donationsConsumed).toBe(1);
    const ca = db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null };
    expect(ca.reconcile_delta).toBeNull();                   // cross-check saw the post-consumption 50
    expect(result.replayWarnings).toHaveLength(0);
  });

  it("6. split AFTER the donation: cross-check delta stays clean because preOpen is post-consumption", () => {
    const { db, ibkr, sec } = setup();
    const buyId = insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");
    const { donationId } = seedDonationLeg(db, { accountId: ibkr, secId: sec, date: "2026-07-01", quantity: 40 });
    insertSplit(db, sec, ibkr, "2026-08-01", 2, 1, 60);      // 60 open × (2 − 1) = 60

    computeTaxLots(db);
    assignDonationLots(db, donationId, [{ acquisitionTransactionId: buyId, quantity: 40 }]);
    const result = computeTaxLots(db);

    expect(lots(db)[0].quantity_remaining).toBeCloseTo(120); // (100 − 40) × 2
    const ca = db.prepare("SELECT reconcile_delta FROM corporate_actions").get() as { reconcile_delta: number | null };
    expect(ca.reconcile_delta).toBeNull();
    expect(result.replayWarnings).toHaveLength(0);
    expect(result.donationsConsumed).toBe(1);
  });

  it("7. defensive clamp: an assignment larger than what the lot still holds warns and clamps", () => {
    const { db, ibkr, sec } = setup();
    const buyId = insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");
    const { donationId } = seedDonationLeg(db, { accountId: ibkr, secId: sec, date: "2026-07-01", quantity: 80 });

    computeTaxLots(db);
    assignDonationLots(db, donationId, [{ acquisitionTransactionId: buyId, quantity: 80 }]); // valid: 80 ≤ 100
    // Historical drift: a 30-share sell dated BEFORE the donation lands later.
    insertTxn(db, ibkr, sec, "2026-06-15", "SELL", 30, 420, "k2");
    const result = computeTaxLots(db);

    expect(lots(db)[0].quantity_remaining).toBeCloseTo(0);   // 70 available, 80 assigned → clamped
    expect(result.replayWarnings.join("\n")).toContain("clamped");
    expect(result.replayWarnings.join("\n")).toContain(`donation ${donationId}`);
    expect(result.donationsConsumed).toBe(1);
    expect(saleRows(db)).toHaveLength(1);                    // the sell still recorded normally
  });

  it("8. reversed donation: consumes nothing on recompute", () => {
    const { db, ibkr, sec } = setup();
    const buyId = insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");
    const { donationId } = seedDonationLeg(db, { accountId: ibkr, secId: sec, date: "2026-07-01", quantity: 40 });

    computeTaxLots(db);
    assignDonationLots(db, donationId, [{ acquisitionTransactionId: buyId, quantity: 40 }]);
    markDonationReversed(db, donationId, "2026-07-15");
    const result = computeTaxLots(db);

    expect(lots(db)[0].quantity_remaining).toBeCloseTo(100);
    expect(result.donationsConsumed).toBe(0);
    expect(result.replayWarnings).toHaveLength(0);
  });

  it("9. bounce inertness: an unlinked TRANSFER_OUT changes nothing", () => {
    const { db, ibkr, sec } = setup();
    insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");
    insertTxn(db, ibkr, sec, "2026-07-01", "TRANSFER_OUT", 40, 0, "bounce-1");

    const result = computeTaxLots(db);

    expect(lots(db)[0].quantity_remaining).toBeCloseTo(100);
    expect(result.donationsConsumed).toBe(0);
    expect(saleRows(db)).toHaveLength(0);
    expect(result.replayWarnings).toHaveLength(0);
  });

  it("10. RECONCILE_CLOSE: a donation-consumed lot that matches the broker's held quantity is not an orphan", () => {
    const { db, ibkr, sec } = setup();
    db.prepare("UPDATE securities SET security_type = 'Stock' WHERE id = ?").run(sec);
    const buyId = insertTxn(db, ibkr, sec, "2026-06-01", "BUY", 100, 400, "k1");
    const { donationId } = seedDonationLeg(db, { accountId: ibkr, secId: sec, date: "2026-07-01", quantity: 40 });
    seedHolding(db, ibkr, sec, 60, "2026-07-01");            // broker still holds 60 after the gift
    seedPrice(db, sec, "2026-07-01", 420);

    computeTaxLots(db);
    assignDonationLots(db, donationId, [{ acquisitionTransactionId: buyId, quantity: 40 }]);
    const result = computeTaxLots(db);

    expect(lots(db)[0].quantity_remaining).toBeCloseTo(60);  // ledger now agrees with the broker
    const synth = db.prepare("SELECT * FROM transactions WHERE type = 'RECONCILE_CLOSE'").all();
    expect(synth).toHaveLength(0);
    expect(saleRows(db)).toHaveLength(0);
    expect(result.salesProcessed).toBe(0);
  });
});
