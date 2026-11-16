/**
 * Giving, review round 2 (2026-11-15): a lot opened by only PART of an IBKR
 * mixed open/close trade, since closed, with a split after the gift.
 *
 * The engine opens such a lot with the residual of the trade (the trade's
 * quantity minus what it covered), so the acquisition transaction's quantity
 * times the splits the lot took never equals the stored figure, and the view
 * cannot put the lot on the gift date's share basis. It used to keep the
 * stored (post-split) figure: the basis came out halved after a 2:1 split,
 * the avoided gain was overstated and the drawer offered double capacity.
 * Now the row shows no figure, is left out of the year total and counted,
 * and the drawer offers none of the lot.
 *
 * Every figure here is synthetic.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { ibkrTradeDirectionNote } from "@/lib/import/ibkr-trade-direction";
import { linkDonationLegs, assignDonationLots } from "@/lib/mutations/donation-links";
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
  const txn = (date: string, type: string, qty: number, price: number, code = "") =>
    db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, notes, source_key)
         VALUES (?,?,?,?,?,?,?,0,?,?)`
      )
      .run(
        acct,
        sec,
        date,
        type,
        qty,
        price,
        type === "SELL" ? qty * price : -qty * price,
        ibkrTradeDirectionNote(code, `${date}, 12:00:00`) ?? null,
        `t${++n}`
      ).lastInsertRowid as number;
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
  const view = () => getGivingView(db);
  const row = (id: number) =>
    view()
      .years.flatMap((y) => y.donations)
      .find((d) => d.donation.id === id)!;
  return { db, txn, gift, split, view, row };
}

/**
 * A short of 50, then a mixed BUY of 150 that covers it and opens a long lot
 * of 100. A gift of 30 from that lot, a 2:1 split after the gift, and a sale
 * that closes the lot.
 */
function mixedLotScenario(withSplit: boolean) {
  const f = fresh();
  f.txn("2024-01-02", "SELL", 50, 10, "O");
  const mixed = f.txn("2024-02-01", "BUY", 150, 10, "C;O");
  const plainBuy = f.txn("2024-02-05", "BUY", 100, 10);
  const did = f.gift("2025-03-03", 30, 600);
  computeTaxLots(f.db);
  assignDonationLots(f.db, did, [{ acquisitionTransactionId: mixed, quantity: 30 }]);
  if (withSplit) f.split("2025-04-01", 2, 1);
  // Close every share of both lots after the gift (post-split units when split).
  f.txn("2025-06-02", "SELL", withSplit ? (70 + 100) * 2 : 70 + 100, 20, "C");
  computeTaxLots(f.db);
  return { ...f, mixed, plainBuy, did };
}

describe("a closed lot opened by part of a mixed trade, split after the gift", () => {
  it("the engine opened the lot with the trade's residual (the setup is real)", () => {
    const f = mixedLotScenario(true);
    const lot = f.db
      .prepare("SELECT quantity_acquired AS qa, quantity_remaining AS qr FROM tax_lots WHERE acquisition_transaction_id = ?")
      .get(f.mixed) as { qa: number; qr: number };
    // 100 opened, doubled by the split before it closed.
    expect(lot).toEqual({ qa: 200, qr: 0 });
  });

  it("without the split the row has its true basis (control)", () => {
    const f = mixedLotScenario(false);
    const r = f.row(f.did);
    expect(r.basis).toBeCloseTo(300, 9);
    expect(r.basisUnestablished).toBe(false);
  });

  it("shows no basis or gain avoided, and is flagged as needing review", () => {
    const f = mixedLotScenario(true);
    const r = f.row(f.did);
    expect(r.basis).toBeNull();
    expect(r.gainAvoided).toBeNull();
    expect(r.basisUnestablished).toBe(true);
    expect(r.basisImplausible).toBe(true);
    // A marker cannot fix split units, so no verify control is offered.
    expect(r.flaggedLots).toEqual([]);
    // The lots are assigned: the row is not "pending lots".
    expect(r.needsLots).toBe(false);
    expect(r.longTermQuantity! + r.shortTermQuantity!).toBeCloseTo(30, 9);
  });

  it("is left out of the year total and counted, and does not hold the year pending", () => {
    const f = mixedLotScenario(true);
    const y = f.view().years.find((x) => x.year === "2025")!;
    expect(y.gainAvoided).toBe(0);
    expect(y.gainAvoidedRowsCounted).toBe(0);
    expect(y.gainAvoidedRowsLeftOut).toBe(1);
  });

  it("a second gift in the year with an ordinary lot is still counted", () => {
    const f = mixedLotScenario(true);
    const other = f.gift("2025-03-10", 10, 300);
    computeTaxLots(f.db);
    assignDonationLots(f.db, other, [{ acquisitionTransactionId: f.plainBuy, quantity: 10 }]);
    computeTaxLots(f.db);
    const y = f.view().years.find((x) => x.year === "2025")!;
    expect(y.gainAvoided).toBeCloseTo(300 - 100, 9);
    expect(y.gainAvoidedRowsCounted).toBe(1);
    expect(y.gainAvoidedRowsLeftOut).toBe(1);
  });

  it("the drawer offers no capacity and no gain per share for that lot", () => {
    const f = mixedLotScenario(true);
    const lots = getOpenLotsForDonation(f.db, f.did);
    const mixedLot = lots.find((l) => l.acquisitionTransactionId === f.mixed)!;
    expect(mixedLot.quantityUnestablished).toBe(true);
    expect(mixedLot.remainingAsOfDonationDate).toBe(0);
    expect(mixedLot.gainPerShare).toBeNull();
    expect(mixedLot.suggestedQuantity).toBe(0);
    // The ordinary lot is unaffected: 100 shares on the gift date.
    const plain = lots.find((l) => l.acquisitionTransactionId === f.plainBuy)!;
    expect(plain.quantityUnestablished).toBe(false);
    expect(plain.remainingAsOfDonationDate).toBeCloseTo(100, 9);
  });
});
