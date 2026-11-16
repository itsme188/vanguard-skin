/**
 * Giving: three defects found in the 2026-11-15 Analysis-tab review.
 *
 * G1: a SHORT lot is never a source for a gift. You cannot donate a short
 *     position; its stored basis is the short sale's proceeds, so ranking it
 *     by gain per share put it first and the row then printed the proceeds
 *     as basis and called the whole gift long-term.
 * G2: a split AFTER a gift must not change the gift's figures. The lot
 *     engine multiplies every still-open lot's quantity at a split, while
 *     `donations.quantity` and `donation_lots.quantity` stay in gift-date
 *     units, so `cost_basis / quantity_acquired` halved the basis after a
 *     2:1 split and the drawer offered double capacity.
 * G3: a gift of a non-USD security ("unsupported") is left out of the
 *     year's "Gain avoided" and counted, like a row with an implausible basis.
 *
 * Every figure here is synthetic.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { linkDonationLegs, assignDonationLots, DonationLinkError } from "@/lib/mutations/donation-links";
import { insertDonation } from "@/lib/mutations/donations";
import { getGivingView, getOpenLotsForDonation } from "@/lib/queries/giving-view";

function fresh() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT INTO securities (symbol, security_type) VALUES ('ZZA','Stock')").run();
  const acct = (db.prepare("SELECT id FROM accounts WHERE name='IBKR'").get() as { id: number }).id;
  const sec = (db.prepare("SELECT id FROM securities WHERE symbol='ZZA'").get() as { id: number }).id;
  let n = 0;
  const txn = (date: string, type: string, qty: number, price: number) =>
    db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
         VALUES (?,?,?,?,?,?,?,0,?)`
      )
      .run(acct, sec, date, type, qty, price, type === "SELL_TO_OPEN" || type === "SELL" ? qty * price : -qty * price, `t${++n}`)
      .lastInsertRowid as number;
  const gift = (date: string, qty: number, fmv: number) => {
    const out = txn(date, "TRANSFER_OUT", qty, 0);
    const id = insertDonation(
      db,
      {
        sourceKey: `d${++n}`,
        kind: "stock",
        securityId: sec,
        symbolRaw: "ZZA",
        quantity: qty,
        fmvUsd: fmv,
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
  };
  const split = (date: string, num: number, den: number) =>
    db
      .prepare(
        `INSERT INTO corporate_actions (security_id, account_id, action_type, effective_date, ratio_numerator,
           ratio_denominator, applied, source, source_key, quantity_delta)
         VALUES (?,?,?,?,?,?,0,'import',?,NULL)`
      )
      .run(sec, acct, num >= den ? "SPLIT" : "REVERSE_SPLIT", date, num, den, `ca:${++n}`);
  const row = (donationId: number) =>
    getGivingView(db)
      .years.flatMap((y) => y.donations)
      .find((d) => d.donation.id === donationId)!;
  return { db, acct, sec, txn, gift, split, row };
}

describe("G1: a short lot is never a gift source", () => {
  function setup() {
    const f = fresh();
    const buy = f.txn("2023-01-03", "BUY", 10, 50);
    const sto = f.txn("2023-02-01", "SELL_TO_OPEN", 10, 10);
    const did = f.gift("2026-07-01", 10, 1000);
    computeTaxLots(f.db);
    return { ...f, buy, sto, did };
  }

  it("the drawer does not list a short lot, so the suggestion takes the long lot", () => {
    const { db, did, buy, sto } = setup();
    const lots = getOpenLotsForDonation(db, did);
    expect(lots.map((l) => l.acquisitionTransactionId)).toEqual([buy]);
    expect(lots.some((l) => l.acquisitionTransactionId === sto)).toBe(false);
    expect(lots[0].suggestedQuantity).toBe(10);
  });

  it("assigning a short lot is refused with a domain error, and nothing is written", () => {
    const { db, did, sto } = setup();
    expect(() => assignDonationLots(db, did, [{ acquisitionTransactionId: sto, quantity: 10 }])).toThrow(
      DonationLinkError
    );
    expect(() => assignDonationLots(db, did, [{ acquisitionTransactionId: sto, quantity: 10 }])).toThrow(/short/i);
    expect(db.prepare("SELECT COUNT(*) AS c FROM donation_lots").get()).toEqual({ c: 0 });
  });

  it("a long lot is still accepted", () => {
    const { db, did, buy, row } = setup();
    assignDonationLots(db, did, [{ acquisitionTransactionId: buy, quantity: 10 }]);
    computeTaxLots(db);
    expect(row(did).basis).toBeCloseTo(500, 9);
    expect(row(did).gainAvoided).toBeCloseTo(500, 9);
  });

  it("a gift already assigned to a short lot (written before this guard) shows as needing lots, not a figure", () => {
    const { db, did, sto, row } = setup();
    db.prepare("INSERT INTO donation_lots (donation_id, acquisition_transaction_id, quantity) VALUES (?, ?, 10)").run(
      did,
      sto
    );
    const r = row(did);
    expect(r.basis).toBeNull();
    expect(r.gainAvoided).toBeNull();
    expect(r.longTermQuantity).toBeNull();
    expect(r.needsLots).toBe(true);
    expect(r.status).toBe("pending-lots");
  });
});

describe("G2: a split after a gift leaves the gift's figures alone", () => {
  function baseline() {
    const f = fresh();
    const buy = f.txn("2024-06-01", "BUY", 100, 10);
    const did = f.gift("2026-07-01", 40, 2000);
    computeTaxLots(f.db);
    return { ...f, buy, did };
  }

  it("basis and gain avoided after a 2:1 split equal the figures with no split", () => {
    const noSplit = baseline();
    assignDonationLots(noSplit.db, noSplit.did, [{ acquisitionTransactionId: noSplit.buy, quantity: 40 }]);
    computeTaxLots(noSplit.db);
    const expected = noSplit.row(noSplit.did);
    expect(expected.basis).toBeCloseTo(400, 9);

    const f = baseline();
    f.split("2026-08-01", 2, 1);
    computeTaxLots(f.db);
    // Drawer before any assignment: true capacity in gift-date units, true cost per share.
    const lots = getOpenLotsForDonation(f.db, f.did);
    expect(lots[0].remainingAsOfDonationDate).toBeCloseTo(100, 9);
    expect(lots[0].quantityAcquired).toBeCloseTo(100, 9);
    expect(lots[0].gainPerShare).toBeCloseTo(50 - 10, 9);
    assignDonationLots(f.db, f.did, [{ acquisitionTransactionId: f.buy, quantity: 40 }]);
    computeTaxLots(f.db);
    // The engine itself is in post-split units: 60 left × 2.
    expect(f.db.prepare("SELECT quantity_remaining AS q FROM tax_lots").get()).toEqual({ q: 120 });
    const r = f.row(f.did);
    expect(r.basis).toBeCloseTo(expected.basis!, 9);
    expect(r.gainAvoided).toBeCloseTo(expected.gainAvoided!, 9);
    expect(r.basisImplausible).toBe(false);
    // The drawer still offers the true capacity for this gift (its own claim counts back).
    expect(getOpenLotsForDonation(f.db, f.did)[0].remainingAsOfDonationDate).toBeCloseTo(100, 9);
  });

  it("a later gift, after the split, sees the true remaining in its own (post-split) units", () => {
    const f = baseline();
    assignDonationLots(f.db, f.did, [{ acquisitionTransactionId: f.buy, quantity: 40 }]);
    f.split("2026-08-01", 2, 1);
    const later = f.gift("2026-09-01", 50, 1500);
    computeTaxLots(f.db);
    const lot = getOpenLotsForDonation(f.db, later)[0];
    expect(lot.remainingAsOfDonationDate).toBeCloseTo((100 - 40) * 2, 9);
    expect(lot.quantityAcquired).toBeCloseTo(200, 9);
    assignDonationLots(f.db, later, [{ acquisitionTransactionId: f.buy, quantity: 50 }]);
    computeTaxLots(f.db);
    expect(f.row(later).basis).toBeCloseTo(50 * 5, 9);
    expect(f.row(f.did).basis).toBeCloseTo(400, 9);
  });

  it("the write gate does not read post-split remaining as gift-date capacity", () => {
    const f = fresh();
    const buy = f.txn("2024-06-01", "BUY", 100, 10);
    const a = f.gift("2026-07-01", 60, 3000);
    const b = f.gift("2026-07-02", 60, 3000);
    computeTaxLots(f.db);
    assignDonationLots(f.db, a, [{ acquisitionTransactionId: buy, quantity: 60 }]);
    f.split("2026-08-01", 2, 1);
    computeTaxLots(f.db);
    // Only 40 shares were left on gift B's date. The ledger's 80 is post-split.
    expect(() => assignDonationLots(f.db, b, [{ acquisitionTransactionId: buy, quantity: 60 }])).toThrow(
      DonationLinkError
    );
    assignDonationLots(f.db, b, [{ acquisitionTransactionId: buy, quantity: 40 }]);
  });

  it("a reverse split after the gift leaves the figures alone too", () => {
    const f = baseline();
    assignDonationLots(f.db, f.did, [{ acquisitionTransactionId: f.buy, quantity: 40 }]);
    f.split("2026-08-01", 1, 2);
    computeTaxLots(f.db);
    expect(f.db.prepare("SELECT quantity_acquired AS q FROM tax_lots").get()).toEqual({ q: 50 });
    expect(f.row(f.did).basis).toBeCloseTo(400, 9);
    expect(f.row(f.did).gainAvoided).toBeCloseTo(1600, 9);
    expect(getOpenLotsForDonation(f.db, f.did)[0].remainingAsOfDonationDate).toBeCloseTo(100, 9);
  });

  it("a split ON the gift date counts as after it (the engine replays the gift first)", () => {
    const f = baseline();
    assignDonationLots(f.db, f.did, [{ acquisitionTransactionId: f.buy, quantity: 40 }]);
    f.split("2026-07-01", 2, 1);
    computeTaxLots(f.db);
    expect(f.db.prepare("SELECT quantity_remaining AS q FROM tax_lots").get()).toEqual({ q: 120 });
    expect(f.row(f.did).basis).toBeCloseTo(400, 9);
  });

  it("a lot sold out after the split still gives the gift its true basis", () => {
    const f = baseline();
    assignDonationLots(f.db, f.did, [{ acquisitionTransactionId: f.buy, quantity: 40 }]);
    f.split("2026-08-01", 2, 1);
    f.txn("2026-09-01", "SELL", 120, 30);
    computeTaxLots(f.db);
    expect(f.db.prepare("SELECT quantity_remaining AS q FROM tax_lots").get()).toEqual({ q: 0 });
    expect(f.row(f.did).basis).toBeCloseTo(400, 9);
    expect(getOpenLotsForDonation(f.db, f.did)[0].remainingAsOfDonationDate).toBeCloseTo(100, 9);
  });

  it("a split BEFORE the gift is unaffected: the gift is in post-split units", () => {
    const f = fresh();
    const buy = f.txn("2024-06-01", "BUY", 100, 10);
    f.split("2026-03-01", 2, 1);
    const did = f.gift("2026-07-01", 80, 2000);
    computeTaxLots(f.db);
    const lot = getOpenLotsForDonation(f.db, did)[0];
    expect(lot.remainingAsOfDonationDate).toBeCloseTo(200, 9);
    expect(lot.quantityAcquired).toBeCloseTo(200, 9);
    assignDonationLots(f.db, did, [{ acquisitionTransactionId: buy, quantity: 80 }]);
    computeTaxLots(f.db);
    expect(f.row(did).basis).toBeCloseTo(80 * 5, 9);
    expect(f.row(did).gainAvoided).toBeCloseTo(2000 - 400, 9);
  });

  it("a sale before an earlier split is counted in the gift's units", () => {
    const f = fresh();
    f.txn("2024-06-01", "BUY", 100, 10);
    f.txn("2026-02-01", "SELL", 30, 20);
    f.split("2026-03-01", 2, 1);
    const did = f.gift("2026-07-01", 80, 2000);
    computeTaxLots(f.db);
    // 70 shares left before the split = 140 after it.
    expect(getOpenLotsForDonation(f.db, did)[0].remainingAsOfDonationDate).toBeCloseTo(140, 9);
  });
});

describe("G3: an unsupported (non-USD) gift is left out of the year's gain avoided and counted", () => {
  it("leaves the non-USD row out, keeps the USD row, and counts the one left out", () => {
    const f = fresh();
    const buy = f.txn("2024-06-01", "BUY", 100, 10);
    const usd = f.gift("2026-07-01", 40, 2000);
    computeTaxLots(f.db);
    assignDonationLots(f.db, usd, [{ acquisitionTransactionId: buy, quantity: 40 }]);

    // A non-USD security: the link and lot writers refuse it, so seed the rows directly.
    const cad = f.db.prepare("INSERT INTO securities (symbol, security_type, currency) VALUES ('ZZB','Stock','CAD')").run()
      .lastInsertRowid as number;
    const cadBuy = f.db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
         VALUES (?,?,?,?,?,?,?,0,'cad-b')`
      )
      .run(f.acct, cad, "2024-06-01", "BUY", 10, 10, -100).lastInsertRowid as number;
    const cadOut = f.db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
         VALUES (?,?,?,?,?,0,1000,0,'cad-o')`
      )
      .run(f.acct, cad, "2026-08-01", "TRANSFER_OUT", 10).lastInsertRowid as number;
    const cadGift = f.db
      .prepare(
        `INSERT INTO donations (source_key, kind, security_id, quantity, fmv_usd, received_date)
         VALUES ('cad-d', 'stock', ?, 10, 1000, '2026-08-01')`
      )
      .run(cad).lastInsertRowid as number;
    f.db.prepare("INSERT INTO donation_leg_links (donation_id, transaction_id, role) VALUES (?, ?, 'out')").run(cadGift, cadOut);
    f.db
      .prepare("INSERT INTO donation_lots (donation_id, acquisition_transaction_id, quantity) VALUES (?, ?, 10)")
      .run(cadGift, cadBuy);
    computeTaxLots(f.db);

    const year = getGivingView(f.db).years.find((y) => y.year === "2026")!;
    expect(year.donations.find((d) => d.donation.id === cadGift)!.status).toBe("unsupported");
    expect(year.gainAvoided).toBeCloseTo(1600, 9);
    expect(year.gainAvoidedRowsCounted).toBe(1);
    expect(year.gainAvoidedRowsUnsupported).toBe(1);
    expect(year.gainAvoidedRowsLeftOut).toBe(0);
    // The year's money totals still include the gift's fair value.
    expect(year.stockGiven).toBeCloseTo(3000, 9);
  });

  it("an unsupported gift with no lots does not hold the year's total at 'pending lot assignment'", () => {
    const f = fresh();
    const buy = f.txn("2024-06-01", "BUY", 100, 10);
    const usd = f.gift("2026-07-01", 40, 2000);
    computeTaxLots(f.db);
    assignDonationLots(f.db, usd, [{ acquisitionTransactionId: buy, quantity: 40 }]);
    const cad = f.db.prepare("INSERT INTO securities (symbol, security_type, currency) VALUES ('ZZB','Stock','CAD')").run()
      .lastInsertRowid as number;
    f.db
      .prepare(
        `INSERT INTO donations (source_key, kind, security_id, quantity, fmv_usd, received_date)
         VALUES ('cad-d', 'stock', ?, 10, 1000, '2026-08-01')`
      )
      .run(cad);
    computeTaxLots(f.db);
    const year = getGivingView(f.db).years.find((y) => y.year === "2026")!;
    expect(year.gainAvoided).toBeCloseTo(1600, 9);
    expect(year.gainAvoidedRowsUnsupported).toBe(1);
  });
});
