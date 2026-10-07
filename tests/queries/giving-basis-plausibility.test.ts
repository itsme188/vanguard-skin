/**
 * Owner ruling 2026-10-06: a donated lot whose per-share basis is under 1% of
 * its per-share fair market value is flagged on its row and its avoided gain
 * is LEFT OUT of the year's "Gain avoided" total. One predicate
 * (`isDonatedLotBasisImplausible`) decides both.
 *
 * The view tests run the real engine (`computeTaxLots`) on real transactions
 * and the real `getGivingView`; nothing is stubbed. Fixtures are synthetic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getGivingView, isDonatedLotBasisImplausible } from "@/lib/queries/giving-view";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { linkDonationLegs, assignDonationLots } from "@/lib/mutations/donation-links";
import { insertDonation, markDonationReversed } from "@/lib/mutations/donations";

describe("isDonatedLotBasisImplausible — the 1% rule", () => {
  // 10 shares given at a fair market value of 1,000: 100 a share. 1% is 1.00 a share.
  const gift = { donationFmvUsd: 1000, donationQuantity: 10 };
  const lot = (basisPerShare: number) => ({
    ...gift,
    lotCostBasis: basisPerShare * 50,
    lotQuantityAcquired: 50,
  });

  it("just under 1% is implausible", () => {
    expect(isDonatedLotBasisImplausible(lot(0.99))).toBe(true);
  });

  it("exactly 1% is NOT implausible (the rule is strictly under)", () => {
    expect(isDonatedLotBasisImplausible(lot(1))).toBe(false);
  });

  it("just over 1% is not implausible", () => {
    expect(isDonatedLotBasisImplausible(lot(1.01))).toBe(false);
  });

  it("the boundary holds for a share price that does not divide evenly", () => {
    // 3 shares worth 100 in all: 33.33… a share; 1% of that is 0.3333… a share.
    const thirds = { donationFmvUsd: 100, donationQuantity: 3, lotQuantityAcquired: 3 };
    expect(isDonatedLotBasisImplausible({ ...thirds, lotCostBasis: 1 })).toBe(false); // exactly 1%
    expect(isDonatedLotBasisImplausible({ ...thirds, lotCostBasis: 0.99 })).toBe(true);
    expect(isDonatedLotBasisImplausible({ ...thirds, lotCostBasis: 1.01 })).toBe(false);
  });

  it("a zero or negative basis is implausible", () => {
    expect(isDonatedLotBasisImplausible(lot(0))).toBe(true);
    expect(isDonatedLotBasisImplausible(lot(-5))).toBe(true);
  });

  it("an ordinary basis, and a basis above the fair market value (a loss), are plausible", () => {
    expect(isDonatedLotBasisImplausible(lot(40))).toBe(false);
    expect(isDonatedLotBasisImplausible(lot(250))).toBe(false);
  });

  it("a zero, negative, missing or non-finite fair market value never flags and never divides by zero", () => {
    for (const fmv of [0, -100, null, undefined, NaN, Infinity]) {
      expect(
        isDonatedLotBasisImplausible({
          donationFmvUsd: fmv as number | null | undefined,
          donationQuantity: 10,
          lotCostBasis: 0,
          lotQuantityAcquired: 50,
        })
      ).toBe(false);
    }
  });

  it("a zero, negative, missing or non-finite gift quantity never flags (no per-share value to compare)", () => {
    for (const qty of [0, -1, null, undefined, NaN, Infinity]) {
      expect(
        isDonatedLotBasisImplausible({
          donationFmvUsd: 1000,
          donationQuantity: qty as number | null | undefined,
          lotCostBasis: 0,
          lotQuantityAcquired: 50,
        })
      ).toBe(false);
    }
  });

  it("a lot with no shares or a non-finite basis has no per-share basis at all: flagged, not divided", () => {
    for (const lotQuantityAcquired of [0, -10, NaN]) {
      expect(isDonatedLotBasisImplausible({ ...gift, lotCostBasis: 500, lotQuantityAcquired })).toBe(true);
    }
    for (const lotCostBasis of [NaN, Infinity, null as unknown as number]) {
      expect(isDonatedLotBasisImplausible({ ...gift, lotCostBasis, lotQuantityAcquired: 50 })).toBe(true);
    }
  });
});

// ── The view ────────────────────────────────────────────────────────────────

let db: Database.Database;
let seq = 0;
const ACCOUNT = 1; // migration 002: 'Vanguard Taxable'

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function security(symbol: string): number {
  return db.prepare("INSERT INTO securities (symbol, currency, security_type) VALUES (?, 'USD', 'Stock')").run(symbol)
    .lastInsertRowid as number;
}

function txn(sec: number, date: string, type: string, qty: number, price: number): number {
  seq++;
  return db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(ACCOUNT, sec, date, type, qty, price, qty * price, `plaus-${seq}`).lastInsertRowid as number;
}

/** A linked stock gift of `quantity` shares worth `fmvUsd`, not yet assigned to lots. */
function gift(sec: number, date: string, quantity: number | null, fmvUsd: number): number {
  seq++;
  const out = txn(sec, date, "TRANSFER_OUT", quantity ?? 10, 0);
  const id = insertDonation(
    db,
    {
      sourceKey: `plaus-don-${seq}`,
      kind: "stock",
      securityId: sec,
      symbolRaw: "ZZAA",
      quantity: quantity ?? 10,
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

function year(y: string) {
  const found = getGivingView(db).years.find((x) => x.year === y);
  if (!found) throw new Error(`no ${y} section`);
  return found;
}

function row(y: string, donationId: number) {
  const found = year(y).donations.find((gd) => gd.donation.id === donationId);
  if (!found) throw new Error(`no donation ${donationId}`);
  return found;
}

describe("getGivingView — implausible basis on a donated lot", () => {
  it("flags the penny-basis row and leaves its avoided gain out of the year total", () => {
    const good = security("ZZAA");
    const bad = security("ZZBB");
    const goodLot = txn(good, "2020-01-10", "BUY", 100, 40); // 40 a share
    const badLot = txn(bad, "2010-01-10", "TRANSFER_IN", 100, 0.01); // a cent a share
    const goodGift = gift(good, "2026-03-02", 10, 1000); // 100 a share
    const badGift = gift(bad, "2026-04-02", 10, 1000);
    computeTaxLots(db);
    assignDonationLots(db, goodGift, [{ acquisitionTransactionId: goodLot, quantity: 10 }]);
    assignDonationLots(db, badGift, [{ acquisitionTransactionId: badLot, quantity: 10 }]);
    computeTaxLots(db);

    expect(row("2026", goodGift).basisImplausible).toBe(false);
    expect(row("2026", goodGift).gainAvoided).toBeCloseTo(600, 6);
    expect(row("2026", badGift).basisImplausible).toBe(true);
    // The row keeps its own (wrong) figure next to the chip; only the total drops it.
    expect(row("2026", badGift).gainAvoided).toBeCloseTo(999.9, 6);

    const y = year("2026");
    expect(y.gainAvoided).toBeCloseTo(600, 6);
    expect(y.gainAvoidedRowsLeftOut).toBe(1);
    expect(y.gainAvoidedRowsCounted).toBe(1);
    // Total given is not a basis figure and still counts both gifts.
    expect(y.totalGiven).toBeCloseTo(2000, 6);
  });

  it("without a flagged row the total is every row and nothing is left out", () => {
    const a = security("ZZAA");
    const b = security("ZZBB");
    const lotA = txn(a, "2020-01-10", "BUY", 100, 40);
    const lotB = txn(b, "2020-01-10", "BUY", 100, 25);
    const giftA = gift(a, "2026-03-02", 10, 1000);
    const giftB = gift(b, "2026-04-02", 10, 1000);
    computeTaxLots(db);
    assignDonationLots(db, giftA, [{ acquisitionTransactionId: lotA, quantity: 10 }]);
    assignDonationLots(db, giftB, [{ acquisitionTransactionId: lotB, quantity: 10 }]);
    computeTaxLots(db);

    const y = year("2026");
    expect(y.gainAvoided).toBeCloseTo(600 + 750, 6);
    expect(y.gainAvoidedRowsLeftOut).toBe(0);
    expect(y.gainAvoidedRowsCounted).toBe(2);
  });

  it("a row at exactly 1% is counted; a cent under is left out", () => {
    const atLine = security("ZZAA");
    const under = security("ZZBB");
    const lotAt = txn(atLine, "2020-01-10", "BUY", 100, 1); // exactly 1% of 100
    const lotUnder = txn(under, "2020-01-10", "BUY", 100, 0.99);
    const giftAt = gift(atLine, "2026-03-02", 10, 1000);
    const giftUnder = gift(under, "2026-04-02", 10, 1000);
    computeTaxLots(db);
    assignDonationLots(db, giftAt, [{ acquisitionTransactionId: lotAt, quantity: 10 }]);
    assignDonationLots(db, giftUnder, [{ acquisitionTransactionId: lotUnder, quantity: 10 }]);
    computeTaxLots(db);

    expect(row("2026", giftAt).basisImplausible).toBe(false);
    expect(row("2026", giftUnder).basisImplausible).toBe(true);
    const y = year("2026");
    expect(y.gainAvoided).toBeCloseTo(990, 6);
    expect(y.gainAvoidedRowsLeftOut).toBe(1);
  });

  it("one penny lot among several flags the row even when the blended basis looks ordinary", () => {
    const sec = security("ZZAA");
    const penny = txn(sec, "2010-01-10", "TRANSFER_IN", 5, 0.01);
    const real = txn(sec, "2020-01-10", "BUY", 5, 40);
    const g = gift(sec, "2026-03-02", 10, 1000);
    computeTaxLots(db);
    assignDonationLots(db, g, [
      { acquisitionTransactionId: penny, quantity: 5 },
      { acquisitionTransactionId: real, quantity: 5 },
    ]);
    computeTaxLots(db);

    const r = row("2026", g);
    // Blended basis is about 20 a share, far above 1% of 100 — the lot is what is judged.
    expect(r.basis).toBeCloseTo(200.05, 6);
    expect(r.basisImplausible).toBe(true);
    expect(year("2026").gainAvoidedRowsLeftOut).toBe(1);
    expect(year("2026").gainAvoidedRowsCounted).toBe(0);
    expect(year("2026").gainAvoided).toBe(0);
  });

  it("a gift with no lots assigned is not flagged and still makes the year total pending", () => {
    const sec = security("ZZAA");
    txn(sec, "2020-01-10", "BUY", 100, 40);
    const g = gift(sec, "2026-03-02", 10, 1000);
    computeTaxLots(db);

    expect(row("2026", g).basis).toBeNull();
    expect(row("2026", g).basisImplausible).toBe(false);
    const y = year("2026");
    expect(y.gainAvoided).toBeNull();
    expect(y.gainAvoidedRowsLeftOut).toBe(0);
  });

  it("a reversed gift is neither counted nor reported as left out", () => {
    const sec = security("ZZAA");
    const penny = txn(sec, "2010-01-10", "TRANSFER_IN", 100, 0.01);
    const g = gift(sec, "2026-03-02", 10, 1000);
    computeTaxLots(db);
    assignDonationLots(db, g, [{ acquisitionTransactionId: penny, quantity: 10 }]);
    computeTaxLots(db);
    expect(year("2026").gainAvoidedRowsLeftOut).toBe(1);

    markDonationReversed(db, g, "2026-05-01");
    computeTaxLots(db);
    const y = year("2026");
    expect(y.gainAvoidedRowsLeftOut).toBe(0);
    expect(y.gainAvoidedRowsCounted).toBe(0);
    expect(row("2026", g).basisImplausible).toBe(false);
  });

  it("a cash gift and a year with no stock gifts are untouched by the rule", () => {
    insertDonation(
      db,
      {
        sourceKey: "plaus-cash",
        kind: "cash",
        securityId: null,
        symbolRaw: null,
        quantity: null,
        fmvUsd: 500,
        unitValuation: null,
        createdDate: null,
        receivedDate: "2025-06-01",
        completedDate: null,
        notes: null,
      },
      null
    );
    const y = year("2025");
    expect(y.gainAvoided).toBe(0);
    expect(y.gainAvoidedRowsLeftOut).toBe(0);
    expect(y.gainAvoidedRowsCounted).toBe(0);
    expect(y.donations[0].basisImplausible).toBe(false);
  });

  it("a gift stored with no share count is not flagged and does not throw", () => {
    const sec = security("ZZAA");
    const penny = txn(sec, "2010-01-10", "TRANSFER_IN", 100, 0.01);
    const g = gift(sec, "2026-03-02", 10, 1000);
    computeTaxLots(db);
    assignDonationLots(db, g, [{ acquisitionTransactionId: penny, quantity: 10 }]);
    computeTaxLots(db);
    db.prepare("UPDATE donations SET quantity = NULL WHERE id = ?").run(g);

    expect(row("2026", g).basisImplausible).toBe(false);
    expect(year("2026").gainAvoidedRowsLeftOut).toBe(0);
  });
});
