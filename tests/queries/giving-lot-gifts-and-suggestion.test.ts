/**
 * Two Giving fixes (sprint 2026-10-08, unit 23):
 *
 *  1. A "basis verified" marker belongs to a LOT, and one lot can feed several
 *     gifts. Each flagged lot now carries the gifts it is flagged on, so the
 *     verify dialog can say how many rows one save changes.
 *  2. The lot drawer's suggestion no longer prefers a lot whose basis the 1%
 *     rule flags. Such a lot is taken last within its holding period, and it
 *     is still taken when the other lots cannot cover the gift.
 *
 * Real migrations, the real engine (`computeTaxLots`), the real view and the
 * real mutations on an in-memory database. Every lot here is opened by the
 * engine from a seeded transaction; none is inserted by hand. Fixtures are
 * synthetic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getGivingView, getOpenLotsForDonation } from "@/lib/queries/giving-view";
import { markLotBasisVerified } from "@/lib/mutations/lot-basis-verifications";
import { markDonationReversed } from "@/lib/mutations/donations";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";
import { assign, seedGift, seedSecurity, seedTxn } from "../helpers/giving-basis-fixture";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function row(donationId: number) {
  for (const y of getGivingView(db).years) {
    const found = y.donations.find((gd) => gd.donation.id === donationId);
    if (found) return found;
  }
  throw new Error(`no donation ${donationId}`);
}

function yearSection(y: string) {
  const found = getGivingView(db).years.find((x) => x.year === y);
  if (!found) throw new Error(`no ${y} section`);
  return found;
}

/** Everything the tax-lot ledger stores, as one string. */
function ledgerDigest(): string {
  return JSON.stringify({
    lots: db.prepare("SELECT * FROM tax_lots ORDER BY id").all(),
    sales: db.prepare("SELECT * FROM tax_lot_sales ORDER BY id").all(),
    donationLots: db.prepare("SELECT * FROM donation_lots ORDER BY id").all(),
    transactions: db.prepare("SELECT * FROM transactions ORDER BY id").all(),
  });
}

// ── 1. The gifts a flagged lot feeds ───────────────────────────────────────

describe("a flagged lot lists the gifts it is flagged on", () => {
  /** One penny lot (100 shares, whole basis 1) feeding three gifts in three years. */
  function seedSharedPennyLot() {
    const sec = seedSecurity(db, "ZZBB");
    const penny = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 100, 0.01);
    const g2024 = seedGift(db, sec, "2024-03-01", 10, 1000);
    const g2025 = seedGift(db, sec, "2025-03-03", 10, 1000);
    const g2026 = seedGift(db, sec, "2026-03-02", 10, 1000);
    assign(db, g2024, [{ acquisitionTransactionId: penny, quantity: 10 }]);
    assign(db, g2025, [{ acquisitionTransactionId: penny, quantity: 10 }]);
    assign(db, g2026, [{ acquisitionTransactionId: penny, quantity: 10 }]);
    return { sec, penny, g2024, g2025, g2026 };
  }

  it("every row that draws on the lot names all three gifts, oldest first", () => {
    const { penny, g2024, g2025, g2026 } = seedSharedPennyLot();
    const expected = [
      { donationId: g2024, receivedDate: "2024-03-01" },
      { donationId: g2025, receivedDate: "2025-03-03" },
      { donationId: g2026, receivedDate: "2026-03-02" },
    ];
    for (const id of [g2024, g2025, g2026]) {
      const flagged = row(id).flaggedLots;
      expect(flagged.map((l) => l.acquisitionTransactionId)).toEqual([penny]);
      expect(flagged[0].giftsFed, `gift ${id}`).toEqual(expected);
    }
  });

  it("a lot that feeds one gift lists that one gift", () => {
    const sec = seedSecurity(db, "ZZBB");
    const penny = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 100, 0.01);
    const gift = seedGift(db, sec, "2026-03-02", 10, 1000);
    assign(db, gift, [{ acquisitionTransactionId: penny, quantity: 10 }]);
    expect(row(gift).flaggedLots[0].giftsFed).toEqual([{ donationId: gift, receivedDate: "2026-03-02" }]);
  });

  it("a reversed gift is not listed: it is out of every total already", () => {
    const { g2024, g2025, g2026 } = seedSharedPennyLot();
    markDonationReversed(db, g2025, "2025-04-01");
    computeTaxLots(db);
    expect(row(g2024).flaggedLots[0].giftsFed.map((g) => g.donationId)).toEqual([g2024, g2026]);
    expect(row(g2026).flaggedLots[0].giftsFed.map((g) => g.donationId)).toEqual([g2024, g2026]);
  });

  it("a gift on which the same lot is NOT flagged is not listed: nothing about it changes", () => {
    const sec = seedSecurity(db, "ZZBB");
    const penny = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 100, 0.01);
    // Given at 0.50 a share: a cent a share is 2% of that, so the rule does not fire.
    const cheap = seedGift(db, sec, "2024-03-01", 10, 5);
    const dear = seedGift(db, sec, "2026-03-02", 10, 1000);
    assign(db, cheap, [{ acquisitionTransactionId: penny, quantity: 10 }]);
    assign(db, dear, [{ acquisitionTransactionId: penny, quantity: 10 }]);
    expect(row(cheap).flaggedLots).toEqual([]);
    expect(row(dear).flaggedLots[0].giftsFed).toEqual([{ donationId: dear, receivedDate: "2026-03-02" }]);
  });

  it("one mark flips every listed gift, and writes nothing but the marker", () => {
    const { penny, g2024, g2025, g2026 } = seedSharedPennyLot();
    const listed = row(g2026).flaggedLots[0].giftsFed.map((g) => g.donationId);
    expect(listed).toEqual([g2024, g2025, g2026]);
    for (const y of ["2024", "2025", "2026"]) {
      expect(yearSection(y).gainAvoidedRowsLeftOut, y).toBe(1);
      expect(yearSection(y).gainAvoided, y).toBe(0);
    }
    const ledgerBefore = ledgerDigest();
    const generationBefore = getTaxInputGeneration(db);

    markLotBasisVerified(db, { acquisitionTransactionId: penny, sourceNote: "synthetic source" });

    // The rows that changed are exactly the rows the lot listed beforehand.
    for (const id of listed) {
      expect(row(id).basisImplausible, `gift ${id}`).toBe(false);
      expect(row(id).flaggedLots[0].state).toBe("verified");
      expect(row(id).flaggedLots[0].giftsFed.map((g) => g.donationId)).toEqual(listed);
    }
    // 10 shares at 100 against a cent a share: 1,000 - 0.10 avoided, per gift.
    for (const y of ["2024", "2025", "2026"]) {
      expect(yearSection(y).gainAvoidedRowsLeftOut, y).toBe(0);
      expect(yearSection(y).gainAvoided, y).toBeCloseTo(999.9, 6);
    }
    expect(ledgerDigest()).toBe(ledgerBefore);
    expect(getTaxInputGeneration(db)).toBe(generationBefore);
  });
});

// ── 2. The drawer's suggestion ─────────────────────────────────────────────

describe("the suggestion takes a lot with an implausible basis last", () => {
  function suggestion(donationId: number): Record<number, number> {
    const picked: Record<number, number> = {};
    for (const lot of getOpenLotsForDonation(db, donationId)) {
      // The two flags must agree: a suggested lot has a quantity, any other has none.
      expect(lot.suggested).toBe(lot.suggestedQuantity > 0);
      if (lot.suggested) picked[lot.acquisitionTransactionId] = lot.suggestedQuantity;
    }
    return picked;
  }

  const total = (picked: Record<number, number>) => Object.values(picked).reduce((a, b) => a + b, 0);

  it("an ordinary long-term lot is suggested ahead of a penny-basis lot with a bigger gain", () => {
    const sec = seedSecurity(db, "ZZBB");
    const penny = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 100, 0.01);
    const ordinary = seedTxn(db, sec, "2015-01-12", "BUY", 100, 40);
    const gift = seedGift(db, sec, "2026-03-02", 10, 1000);
    computeTaxLots(db);

    const lots = getOpenLotsForDonation(db, gift);
    const byId = new Map(lots.map((l) => [l.acquisitionTransactionId, l]));
    // The penny lot's gain per share is the larger one: ranking by gain alone picked it.
    expect(byId.get(penny)!.gainPerShare).toBeCloseTo(99.99, 6);
    expect(byId.get(ordinary)!.gainPerShare).toBeCloseTo(60, 6);
    expect(byId.get(penny)!.basisState).toBe("implausible");
    expect(byId.get(ordinary)!.basisState).toBe("plausible");

    expect(suggestion(gift)).toEqual({ [ordinary]: 10 });
  });

  it("still covers the whole gift: the penny lot fills what the ordinary lot cannot", () => {
    const sec = seedSecurity(db, "ZZBB");
    const penny = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 100, 0.01);
    const ordinary = seedTxn(db, sec, "2015-01-12", "BUY", 6, 40);
    const gift = seedGift(db, sec, "2026-03-02", 10, 1000);
    computeTaxLots(db);

    const picked = suggestion(gift);
    expect(picked).toEqual({ [ordinary]: 6, [penny]: 4 });
    expect(total(picked)).toBe(10);
  });

  it("only implausible lots remain: they are suggested, and the whole gift is covered", () => {
    const sec = seedSecurity(db, "ZZBB");
    const older = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 7, 0.01);
    const newer = seedTxn(db, sec, "2012-01-10", "TRANSFER_IN", 100, 0.02);
    const gift = seedGift(db, sec, "2026-03-02", 10, 1000);
    computeTaxLots(db);

    const lots = getOpenLotsForDonation(db, gift);
    expect(lots.map((l) => l.basisState)).toEqual(["implausible", "implausible"]);
    const picked = suggestion(gift);
    // Among flagged lots the old order holds: the higher gain per share first.
    expect(picked).toEqual({ [older]: 7, [newer]: 3 });
    expect(total(picked)).toBe(10);
  });

  it("a lot whose small basis the owner verified ranks by its gain again", () => {
    const sec = seedSecurity(db, "ZZBB");
    const penny = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 100, 0.01);
    const ordinary = seedTxn(db, sec, "2015-01-12", "BUY", 100, 40);
    const first = seedGift(db, sec, "2025-03-03", 10, 1000);
    assign(db, first, [{ acquisitionTransactionId: penny, quantity: 10 }]);
    const second = seedGift(db, sec, "2026-03-02", 10, 1000);
    computeTaxLots(db);

    expect(suggestion(second)).toEqual({ [ordinary]: 10 });
    markLotBasisVerified(db, { acquisitionTransactionId: penny, sourceNote: "synthetic source" });
    const lots = getOpenLotsForDonation(db, second);
    expect(lots.find((l) => l.acquisitionTransactionId === penny)!.basisState).toBe("verified");
    expect(suggestion(second)).toEqual({ [penny]: 10 });
  });

  it("a marker gone stale puts the lot back at the end", () => {
    const sec = seedSecurity(db, "ZZBB");
    const penny = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 100, 0.01);
    const ordinary = seedTxn(db, sec, "2015-01-12", "BUY", 100, 40);
    const first = seedGift(db, sec, "2025-03-03", 10, 1000);
    assign(db, first, [{ acquisitionTransactionId: penny, quantity: 10 }]);
    const second = seedGift(db, sec, "2026-03-02", 10, 1000);
    computeTaxLots(db);
    markLotBasisVerified(db, { acquisitionTransactionId: penny, sourceNote: "synthetic source" });
    expect(suggestion(second)).toEqual({ [penny]: 10 });

    // The acquisition row's price moves (still far under 1%), and the engine rebuilds the lot.
    db.prepare("UPDATE transactions SET price_per_share = 0.02, amount = 2 WHERE id = ?").run(penny);
    computeTaxLots(db);
    const lots = getOpenLotsForDonation(db, second);
    expect(lots.find((l) => l.acquisitionTransactionId === penny)!.basisState).toBe("verified-stale");
    expect(suggestion(second)).toEqual({ [ordinary]: 10 });
  });

  it("holding period still comes first: a flagged long-term lot is taken before a short-term lot", () => {
    const sec = seedSecurity(db, "ZZBB");
    const penny = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 100, 0.01);
    const recent = seedTxn(db, sec, "2025-12-01", "BUY", 100, 40);
    const gift = seedGift(db, sec, "2026-03-02", 10, 1000);
    computeTaxLots(db);

    const lots = getOpenLotsForDonation(db, gift);
    expect(lots.find((l) => l.acquisitionTransactionId === recent)!.isLongTerm).toBe(false);
    expect(suggestion(gift)).toEqual({ [penny]: 10 });
  });
});
