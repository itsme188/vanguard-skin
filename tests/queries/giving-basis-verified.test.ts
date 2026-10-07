/**
 * Owner request 2026-10-07: a donated lot whose basis trips the 1% rule can be
 * marked "basis verified" with the source the owner checked it against. A
 * verified lot stops keeping its gift out of the year's "Gain avoided".
 *
 * The marker records that a check happened. It never changes a tax figure and
 * never triggers the tax-lot recompute.
 *
 * Real migrations, the real engine (`computeTaxLots`), the real view and the
 * real mutations on an in-memory database. Fixtures are synthetic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getGivingView, donatedLotBasisState, type DonatedLotBasisStateInput } from "@/lib/queries/giving-view";
import {
  markLotBasisVerified,
  unmarkLotBasisVerified,
  LotBasisVerificationError,
  SOURCE_NOTE_MAX_LENGTH,
} from "@/lib/mutations/lot-basis-verifications";
import { assignDonationLots } from "@/lib/mutations/donation-links";
import { createImportBatch } from "@/lib/mutations/import-batches";
import { bumpTaxInputGeneration, isTaxConventionPending } from "@/lib/compute/tax-convention";
import { undoImport } from "@/lib/import/engine";
import { applyDonatedLotBasisRepair, planDonatedLotBasisRepair } from "@/scripts/repair-donated-lot-basis";
import {
  assign,
  seedFlaggedGift,
  seedGift,
  seedPlausibleGift,
  seedSecurity,
  seedTxn,
} from "../helpers/giving-basis-fixture";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function year(y = "2026") {
  const found = getGivingView(db).years.find((x) => x.year === y);
  if (!found) throw new Error(`no ${y} section`);
  return found;
}

function row(donationId: number, y = "2026") {
  const found = year(y).donations.find((gd) => gd.donation.id === donationId);
  if (!found) throw new Error(`no donation ${donationId}`);
  return found;
}

function states(donationId: number): string[] {
  return row(donationId).flaggedLots.map((l) => l.state);
}

function marker(lotTxn: number) {
  return db.prepare("SELECT * FROM lot_basis_verifications WHERE acquisition_transaction_id = ?").get(lotTxn) as
    | {
        id: number;
        source_note: string;
        verified_amount: number | null;
        verified_quantity: number | null;
        verified_at: string;
      }
    | undefined;
}

/** The view's own bookkeeping must agree with itself (conservation). */
function expectConserved(y = "2026") {
  const section = year(y);
  const active = section.donations.filter((gd) => gd.donation.kind === "stock" && gd.donation.reversed_date == null);
  const leftOut = active.filter((gd) =>
    gd.flaggedLots.some((l) => l.state === "implausible" || l.state === "verified-stale")
  );
  const included = active.filter((gd) => gd.basis != null && !leftOut.includes(gd));
  expect(section.gainAvoidedRowsLeftOut).toBe(leftOut.length);
  expect(section.gainAvoidedRowsCounted).toBe(included.length);
  expect(section.gainAvoided).toBeCloseTo(
    included.reduce((sum, gd) => sum + (gd.gainAvoided ?? 0), 0),
    6
  );
  // The row flag and the per-lot states are one rule, not two.
  for (const gd of active) expect(gd.basisImplausible).toBe(leftOut.includes(gd));
}

// ── The pure reader ─────────────────────────────────────────────────────────

describe("donatedLotBasisState: the one reader", () => {
  // 10 shares given at 100 a share; the lot is 100 shares.
  const flagged: DonatedLotBasisStateInput = {
    donationFmvUsd: 1000,
    donationQuantity: 10,
    lotCostBasis: 1,
    lotQuantityAcquired: 100,
    verification: null,
  };
  const marked = (verifiedAmount: number | null, verifiedQuantity: number | null) => ({
    ...flagged,
    verification: { verifiedAmount, verifiedQuantity },
  });

  it("no marker: implausible when the 1% rule fires, plausible when it does not", () => {
    expect(donatedLotBasisState(flagged)).toBe("implausible");
    expect(donatedLotBasisState({ ...flagged, lotCostBasis: 4000 })).toBe("plausible");
  });

  it("a marker whose snapshot still matches the row: verified", () => {
    expect(donatedLotBasisState(marked(1, 100))).toBe("verified");
  });

  it("a marker on a plausible lot is ignored", () => {
    expect(donatedLotBasisState({ ...marked(1, 100), lotCostBasis: 4000 })).toBe("plausible");
    expect(donatedLotBasisState({ ...marked(999, 7), lotCostBasis: 4000 })).toBe("plausible");
  });

  it("the snapshot is compared with the very figures the 1% rule reads", () => {
    // The lot's basis moved (still under 1%): what was verified is gone.
    expect(donatedLotBasisState({ ...marked(1, 100), lotCostBasis: 2 })).toBe("verified-stale");
    expect(donatedLotBasisState({ ...marked(1, 100), lotQuantityAcquired: 200 })).toBe("verified-stale");
  });

  it("the basis is compared in cents", () => {
    expect(donatedLotBasisState(marked(1.004, 100))).toBe("verified"); // same cent
    expect(donatedLotBasisState(marked(1.01, 100))).toBe("verified-stale");
    expect(donatedLotBasisState(marked(2, 100))).toBe("verified-stale");
  });

  it("the quantity is compared with the share tolerance", () => {
    expect(donatedLotBasisState(marked(1, 100 + 1e-12))).toBe("verified");
    expect(donatedLotBasisState(marked(1, 100.0001))).toBe("verified-stale");
  });

  it("a snapshot with a missing figure never matches a lot", () => {
    expect(donatedLotBasisState(marked(null, 100))).toBe("verified-stale");
    expect(donatedLotBasisState(marked(1, null))).toBe("verified-stale");
  });

  it("a marker whose lot is gone from the ledger is stale", () => {
    for (const gone of [null, undefined]) {
      expect(donatedLotBasisState({ ...marked(1, 100), lotCostBasis: gone, lotQuantityAcquired: gone })).toBe(
        "verified-stale"
      );
      // Even against a snapshot that is itself blank: no lot, nothing verified.
      expect(donatedLotBasisState({ ...marked(null, null), lotCostBasis: gone, lotQuantityAcquired: gone })).toBe(
        "verified-stale"
      );
    }
  });
});

// ── The view ────────────────────────────────────────────────────────────────

describe("getGivingView with a verified lot", () => {
  it("a single-lot flagged gift, once marked, is included: the count drops and the total rises by exactly its gain", () => {
    const good = seedPlausibleGift(db);
    const bad = seedFlaggedGift(db);

    expect(states(bad.donationId)).toEqual(["implausible"]);
    expect(states(good.donationId)).toEqual([]);
    const before = year();
    expect(before.gainAvoided).toBeCloseTo(600, 6);
    expect(before.gainAvoidedRowsLeftOut).toBe(1);
    expect(before.gainAvoidedRowsCounted).toBe(1);
    const rowGain = row(bad.donationId).gainAvoided as number;
    expect(rowGain).toBeCloseTo(999.9, 6);
    expectConserved();

    markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "synthetic source, 2020" });

    expect(states(bad.donationId)).toEqual(["verified"]);
    expect(row(bad.donationId).basisImplausible).toBe(false);
    const after = year();
    expect(after.gainAvoidedRowsLeftOut).toBe(0);
    expect(after.gainAvoidedRowsCounted).toBe(2);
    expect((after.gainAvoided as number) - (before.gainAvoided as number)).toBeCloseTo(rowGain, 6);
    // The row's own figures are untouched: the marker changes no number.
    expect(row(bad.donationId).gainAvoided).toBeCloseTo(rowGain, 6);
    expect(row(bad.donationId).basis).toBeCloseTo(0.1, 6);
    expectConserved();
  });

  it("the verified lot carries its note and date; an unmarked lot carries neither", () => {
    const bad = seedFlaggedGift(db);
    expect(row(bad.donationId).flaggedLots[0]).toMatchObject({
      acquisitionTransactionId: bad.lotTxn,
      acquisitionDate: "2010-01-10",
      state: "implausible",
      sourceNote: null,
      verifiedAt: null,
    });
    markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "synthetic source, 2020" });
    const lot = row(bad.donationId).flaggedLots[0];
    expect(lot.state).toBe("verified");
    expect(lot.sourceNote).toBe("synthetic source, 2020");
    expect(lot.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("a gift drawing on two flagged lots stays left out until BOTH are marked", () => {
    const sec = seedSecurity(db, "ZZCC");
    const lotA = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 5, 0.01);
    const lotB = seedTxn(db, sec, "2011-01-10", "TRANSFER_IN", 5, 0.02);
    const g = seedGift(db, sec, "2026-03-02", 10, 1000);
    assign(db, g, [
      { acquisitionTransactionId: lotA, quantity: 5 },
      { acquisitionTransactionId: lotB, quantity: 5 },
    ]);
    expect(states(g)).toEqual(["implausible", "implausible"]);
    expect(year().gainAvoidedRowsLeftOut).toBe(1);

    markLotBasisVerified(db, { acquisitionTransactionId: lotA, sourceNote: "synthetic source A" });
    expect(states(g)).toEqual(["verified", "implausible"]);
    expect(row(g).basisImplausible).toBe(true);
    expect(year().gainAvoidedRowsLeftOut).toBe(1);
    expect(year().gainAvoidedRowsCounted).toBe(0);
    expect(year().gainAvoided).toBe(0);
    expectConserved();

    markLotBasisVerified(db, { acquisitionTransactionId: lotB, sourceNote: "synthetic source B" });
    expect(states(g)).toEqual(["verified", "verified"]);
    expect(row(g).basisImplausible).toBe(false);
    expect(year().gainAvoidedRowsLeftOut).toBe(0);
    expect(year().gainAvoidedRowsCounted).toBe(1);
    expect(year().gainAvoided).toBeCloseTo(1000 - (5 * 0.01 + 5 * 0.02), 6);
    expectConserved();
  });

  it("a flagged lot beside an ordinary lot: only the flagged one is listed, and marking it includes the row", () => {
    const sec = seedSecurity(db, "ZZCC");
    const penny = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 5, 0.01);
    const real = seedTxn(db, sec, "2020-01-10", "BUY", 5, 40);
    const g = seedGift(db, sec, "2026-03-02", 10, 1000);
    assign(db, g, [
      { acquisitionTransactionId: penny, quantity: 5 },
      { acquisitionTransactionId: real, quantity: 5 },
    ]);
    expect(row(g).flaggedLots.map((l) => l.acquisitionTransactionId)).toEqual([penny]);
    markLotBasisVerified(db, { acquisitionTransactionId: penny, sourceNote: "synthetic source" });
    expect(year().gainAvoidedRowsLeftOut).toBe(0);
    expect(year().gainAvoided).toBeCloseTo(1000 - 200.05, 6);
    expectConserved();
  });

  it("one marker covers every gift that draws on the lot", () => {
    const first = seedFlaggedGift(db);
    const second = seedGift(db, first.sec, "2026-05-04", 20, 2000);
    assign(db, second, [{ acquisitionTransactionId: first.lotTxn, quantity: 20 }]);
    expect(year().gainAvoidedRowsLeftOut).toBe(2);

    markLotBasisVerified(db, { acquisitionTransactionId: first.lotTxn, sourceNote: "synthetic source" });
    expect(states(first.donationId)).toEqual(["verified"]);
    expect(states(second)).toEqual(["verified"]);
    expect(year().gainAvoidedRowsLeftOut).toBe(0);
    expect(year().gainAvoidedRowsCounted).toBe(2);
    expect(year().gainAvoided).toBeCloseTo(999.9 + 1999.8, 6);
    expectConserved();
  });

  it("stale by amount: the row is left out again, with its own state", () => {
    const bad = seedFlaggedGift(db);
    markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "synthetic source" });
    expect(year().gainAvoidedRowsLeftOut).toBe(0);

    db.prepare("UPDATE transactions SET amount = 2, price_per_share = 0.02 WHERE id = ?").run(bad.lotTxn);
    // The marker follows the LOT's basis, which moves when the ledger is recomputed.
    computeTaxLots(db);
    expect(states(bad.donationId)).toEqual(["verified-stale"]);
    expect(row(bad.donationId).basisImplausible).toBe(true);
    expect(row(bad.donationId).flaggedLots[0].sourceNote).toBe("synthetic source");
    expect(year().gainAvoidedRowsLeftOut).toBe(1);
    expect(year().gainAvoidedRowsCounted).toBe(0);
    expectConserved();

    // Verifying again takes a fresh snapshot.
    markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "synthetic source, checked again" });
    expect(states(bad.donationId)).toEqual(["verified"]);
    expect(marker(bad.lotTxn)?.verified_amount).toBe(2);
    expect(year().gainAvoidedRowsLeftOut).toBe(0);
  });

  it("stale by quantity", () => {
    const bad = seedFlaggedGift(db);
    markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "synthetic source" });
    db.prepare("UPDATE transactions SET quantity = 200 WHERE id = ?").run(bad.lotTxn);
    computeTaxLots(db);
    expect(states(bad.donationId)).toEqual(["verified-stale"]);
    expect(year().gainAvoidedRowsLeftOut).toBe(1);
    expectConserved();
  });

  it("unmark restores the flag and the exclusion", () => {
    const good = seedPlausibleGift(db);
    const bad = seedFlaggedGift(db);
    markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "synthetic source" });
    expect(year().gainAvoided).toBeCloseTo(1599.9, 6);

    expect(unmarkLotBasisVerified(db, bad.lotTxn)).toBe(true);
    expect(states(bad.donationId)).toEqual(["implausible"]);
    expect(states(good.donationId)).toEqual([]);
    expect(year().gainAvoided).toBeCloseTo(600, 6);
    expect(year().gainAvoidedRowsLeftOut).toBe(1);
    expect(unmarkLotBasisVerified(db, bad.lotTxn)).toBe(false);
    expectConserved();
  });

  it("a marker on a plausible lot changes nothing and is never shown", () => {
    const good = seedPlausibleGift(db);
    const before = JSON.stringify(getGivingView(db).years);
    markLotBasisVerified(db, { acquisitionTransactionId: good.lotTxn, sourceNote: "synthetic source" });
    expect(marker(good.lotTxn)).toBeDefined();
    expect(JSON.stringify(getGivingView(db).years)).toBe(before);
    expect(row(good.donationId).flaggedLots).toEqual([]);
    expect(year().gainAvoided).toBeCloseTo(600, 6);
  });

  it("a gift with no lots assigned still makes the year total pending, marker or not", () => {
    const bad = seedFlaggedGift(db);
    markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "synthetic source" });
    const sec = seedSecurity(db, "ZZDD");
    seedTxn(db, sec, "2020-01-10", "BUY", 100, 40);
    seedGift(db, sec, "2026-06-01", 10, 1000);
    computeTaxLots(db);
    expect(year().gainAvoided).toBeNull();
    expect(year().gainAvoidedRowsLeftOut).toBe(0);
  });
});

// ── The mutations ───────────────────────────────────────────────────────────

describe("markLotBasisVerified / unmarkLotBasisVerified", () => {
  function expectRefused(fn: () => unknown, code: string) {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(LotBasisVerificationError);
      expect((error as LotBasisVerificationError).code).toBe(code);
      return;
    }
    throw new Error("expected a refusal");
  }

  it("stores the trimmed note with a snapshot of the row's amount and quantity", () => {
    const bad = seedFlaggedGift(db);
    const result = markLotBasisVerified(db, {
      acquisitionTransactionId: bad.lotTxn,
      sourceNote: "   synthetic source, 2020 \n",
    });
    expect(result.sourceNote).toBe("synthetic source, 2020");
    expect(result.acquisitionTransactionId).toBe(bad.lotTxn);
    expect(marker(bad.lotTxn)).toMatchObject({
      source_note: "synthetic source, 2020",
      verified_amount: 1,
      verified_quantity: 100,
    });
    expect(result.verifiedAt).toBe(marker(bad.lotTxn)?.verified_at);
  });

  it("refuses an empty, a whitespace-only, an over-long and a non-text note", () => {
    const bad = seedFlaggedGift(db);
    const mark = (sourceNote: unknown) => () =>
      markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: sourceNote as string });
    expectRefused(mark(""), "invalid_note");
    expectRefused(mark("   \n\t "), "invalid_note");
    expectRefused(mark("x".repeat(SOURCE_NOTE_MAX_LENGTH + 1)), "invalid_note");
    expectRefused(mark(undefined), "invalid_note");
    expectRefused(mark(42), "invalid_note");
    expect(marker(bad.lotTxn)).toBeUndefined();
    expect(SOURCE_NOTE_MAX_LENGTH).toBe(200);
  });

  it("accepts exactly 200 characters, measured after trimming", () => {
    const bad = seedFlaggedGift(db);
    markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: `  ${"x".repeat(200)}  ` });
    expect(marker(bad.lotTxn)?.source_note).toHaveLength(200);
  });

  it("refuses an unknown transaction and a bad id", () => {
    expectRefused(() => markLotBasisVerified(db, { acquisitionTransactionId: 999999, sourceNote: "s" }), "not_found");
    for (const id of [0, -1, 1.5, NaN]) {
      expectRefused(() => markLotBasisVerified(db, { acquisitionTransactionId: id, sourceNote: "s" }), "invalid_id");
    }
  });

  it("refuses a row that is not an acquisition, and an acquisition no donation draws on", () => {
    const bad = seedFlaggedGift(db);
    const outLeg = (
      db.prepare("SELECT id FROM transactions WHERE type = 'TRANSFER_OUT'").get() as { id: number }
    ).id;
    expectRefused(
      () => markLotBasisVerified(db, { acquisitionTransactionId: outLeg, sourceNote: "s" }),
      "not_acquisition"
    );
    const lonely = seedTxn(db, bad.sec, "2012-01-10", "TRANSFER_IN", 100, 0.01);
    expectRefused(() => markLotBasisVerified(db, { acquisitionTransactionId: lonely, sourceNote: "s" }), "not_donated");
    expect(db.prepare("SELECT COUNT(*) AS c FROM lot_basis_verifications").get()).toEqual({ c: 0 });
  });

  it("marking again replaces the one row: new note, new snapshot, same lot", () => {
    const bad = seedFlaggedGift(db);
    markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "first" });
    db.prepare("UPDATE lot_basis_verifications SET verified_at = '2020-01-01 00:00:00'").run();
    markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "second" });
    expect(db.prepare("SELECT COUNT(*) AS c FROM lot_basis_verifications").get()).toEqual({ c: 1 });
    expect(marker(bad.lotTxn)?.source_note).toBe("second");
    expect(marker(bad.lotTxn)?.verified_at).not.toBe("2020-01-01 00:00:00");
  });

  it("a mark and an unmark leave every tax input and the lot ledger exactly as they were", () => {
    const good = seedPlausibleGift(db);
    const bad = seedFlaggedGift(db);
    // A sale, so tax_lot_sales is not empty.
    seedTxn(db, good.sec, "2026-05-01", "SELL", 20, 90);
    computeTaxLots(db);
    const digest = () =>
      JSON.stringify(
        ["transactions", "tax_lots", "tax_lot_sales", "donation_lots", "settings"].map((t) =>
          db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()
        )
      );
    const before = digest();
    expect(db.prepare("SELECT COUNT(*) AS c FROM tax_lot_sales").get()).not.toEqual({ c: 0 });

    markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "synthetic source" });
    expect(digest()).toBe(before);
    markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "synthetic source, again" });
    expect(digest()).toBe(before);
    unmarkLotBasisVerified(db, bad.lotTxn);
    expect(digest()).toBe(before);
    unmarkLotBasisVerified(db, bad.lotTxn);
    expect(digest()).toBe(before);
  });
});

// ── The marker follows the lot's basis, through the real engine ─────────────

describe("any change to the lot's basis makes the marker stale", () => {
  function lotRow(lotTxn: number) {
    return db.prepare("SELECT id, cost_basis, quantity_acquired FROM tax_lots WHERE acquisition_transaction_id = ?").all(
      lotTxn
    ) as { id: number; cost_basis: number; quantity_acquired: number }[];
  }

  /** A flagged gift whose acquisition row is seeded with the given amount and fees. */
  function flagged(opts: { amount?: number | null; fees?: number }, type = "TRANSFER_IN") {
    const sec = seedSecurity(db, "ZZBB");
    const lotTxn = seedTxn(db, sec, "2010-01-10", type, 100, 0.01, null, opts);
    const donationId = seedGift(db, sec, "2026-04-02", 10, 1000);
    assign(db, donationId, [{ acquisitionTransactionId: lotTxn, quantity: 10 }]);
    expect(states(donationId)).toEqual(["implausible"]);
    markLotBasisVerified(db, { acquisitionTransactionId: lotTxn, sourceNote: "synthetic source" });
    expect(states(donationId)).toEqual(["verified"]);
    expect(year().gainAvoidedRowsLeftOut).toBe(0);
    return { sec, lotTxn, donationId };
  }

  function expectStaleAndLeftOut(donationId: number) {
    expect(states(donationId)).toEqual(["verified-stale"]);
    expect(row(donationId).basisImplausible).toBe(true);
    expect(year().gainAvoidedRowsLeftOut).toBe(1);
    expect(year().gainAvoidedRowsCounted).toBe(0);
    expectConserved();
  }

  it("the snapshot is the lot's cost basis and quantity acquired, the figures the view prices the gift from", () => {
    const bad = flagged({ fees: 0.25 });
    const lots = lotRow(bad.lotTxn);
    expect(lots).toHaveLength(1);
    expect(lots[0].cost_basis).toBeCloseTo(1.25, 9); // amount 1 plus the fee
    expect(marker(bad.lotTxn)).toMatchObject({
      verified_amount: lots[0].cost_basis,
      verified_quantity: lots[0].quantity_acquired,
    });
    // The view's basis for the 10 shares given comes from those same two figures.
    expect(row(bad.donationId).basis).toBeCloseTo((10 * lots[0].cost_basis) / lots[0].quantity_acquired, 9);
  });

  it("one acquisition transaction opens exactly one lot", () => {
    seedPlausibleGift(db);
    const bad = flagged({});
    seedTxn(db, bad.sec, "2026-05-01", "SELL", 20, 90);
    computeTaxLots(db);
    expect(
      db
        .prepare(
          "SELECT acquisition_transaction_id FROM tax_lots GROUP BY acquisition_transaction_id HAVING COUNT(*) > 1"
        )
        .all()
    ).toEqual([]);
    expect(lotRow(bad.lotTxn)).toHaveLength(1);
  });

  it("no amount on the row, and the price changes", () => {
    const bad = flagged({ amount: null });
    expect(lotRow(bad.lotTxn)[0].cost_basis).toBeCloseTo(1, 9);
    db.prepare("UPDATE transactions SET price_per_share = 0.02 WHERE id = ?").run(bad.lotTxn);
    computeTaxLots(db);
    expect(lotRow(bad.lotTxn)[0].cost_basis).toBeCloseTo(2, 9);
    expectStaleAndLeftOut(bad.donationId);
  });

  it("a zero amount on the row, and the price changes", () => {
    const bad = flagged({ amount: 0 });
    db.prepare("UPDATE transactions SET price_per_share = 0.02 WHERE id = ?").run(bad.lotTxn);
    computeTaxLots(db);
    expect(lotRow(bad.lotTxn)[0].cost_basis).toBeCloseTo(2, 9);
    expectStaleAndLeftOut(bad.donationId);
  });

  it("the fees change", () => {
    const bad = flagged({});
    db.prepare("UPDATE transactions SET fees = 0.5 WHERE id = ?").run(bad.lotTxn);
    computeTaxLots(db);
    expect(lotRow(bad.lotTxn)[0].cost_basis).toBeCloseTo(1.5, 9);
    expectStaleAndLeftOut(bad.donationId);
  });

  it("the row changed before the mark, and the recompute came after it", () => {
    const sec = seedSecurity(db, "ZZBB");
    const lotTxn = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 100, 0.01);
    const donationId = seedGift(db, sec, "2026-04-02", 10, 1000);
    assign(db, donationId, [{ acquisitionTransactionId: lotTxn, quantity: 10 }]);
    // A hand edit that did not announce itself: the ledger does not know it is behind.
    db.prepare("UPDATE transactions SET amount = 3, price_per_share = 0.03 WHERE id = ?").run(lotTxn);
    markLotBasisVerified(db, { acquisitionTransactionId: lotTxn, sourceNote: "synthetic source" });
    // What was verified is the basis the page showed: the lot's, not the edited row's.
    expect(marker(lotTxn)?.verified_amount).toBeCloseTo(1, 9);
    expect(states(donationId)).toEqual(["verified"]);
    computeTaxLots(db);
    expect(lotRow(lotTxn)[0].cost_basis).toBeCloseTo(3, 9);
    expectStaleAndLeftOut(donationId);
  });

  it("an exercised option's premium rolls into the lot's basis with no change to the acquisition row", () => {
    const bad = flagged({}, "BUY");
    const before = JSON.stringify(db.prepare("SELECT * FROM transactions WHERE id = ?").get(bad.lotTxn));
    // A call bought and exercised into those same shares: its premium belongs in their basis.
    const option = db
      .prepare(
        `INSERT INTO securities (symbol, currency, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
         VALUES ('ZZBB  100619C00000010', 'USD', 'option', 'ZZBB', 'CALL', 0.01, '2010-06-19', 100)`
      )
      .run().lastInsertRowid as number;
    seedTxn(db, option, "2009-12-01", "BUY_TO_OPEN", 1, 0.002, null, { amount: 0.2 });
    seedTxn(db, option, "2010-01-10", "EXERCISED", 1, 0.002, null, { amount: 0.2 });
    computeTaxLots(db);

    expect(JSON.stringify(db.prepare("SELECT * FROM transactions WHERE id = ?").get(bad.lotTxn))).toBe(before);
    expect(lotRow(bad.lotTxn)[0].cost_basis).toBeCloseTo(1.2, 9);
    expectStaleAndLeftOut(bad.donationId);
  });

  it("a recompute that leaves the lot's basis and quantity alone keeps it verified", () => {
    const bad = flagged({ fees: 0.25 });
    const firstId = lotRow(bad.lotTxn)[0].id;
    computeTaxLots(db);
    computeTaxLots(db);
    // The engine rebuilds every lot, so the lot's own id is new each time...
    expect(lotRow(bad.lotTxn)[0].id).not.toBe(firstId);
    // ...and the marker, keyed by the acquisition transaction, still applies.
    expect(states(bad.donationId)).toEqual(["verified"]);
    expect(year().gainAvoidedRowsLeftOut).toBe(0);

    // An unrelated trade and another recompute change nothing for this lot either.
    const other = seedPlausibleGift(db);
    seedTxn(db, other.sec, "2026-05-01", "SELL", 20, 90);
    computeTaxLots(db);
    expect(states(bad.donationId)).toEqual(["verified"]);
    expectConserved();
  });

  it("a lot that is gone from the ledger leaves its marker stale and the gift out", () => {
    const good = seedPlausibleGift(db);
    const bad = flagged({});
    db.prepare("DELETE FROM tax_lots WHERE acquisition_transaction_id = ?").run(bad.lotTxn);
    expect(states(bad.donationId)).toEqual(["verified-stale"]);
    expect(row(bad.donationId).basisImplausible).toBe(true);
    expect(row(bad.donationId).flaggedLots[0].acquisitionDate).toBe("2010-01-10");
    expect(states(good.donationId)).toEqual([]);
  });
});

describe("marking while the tax-lot ledger is waiting on a recompute", () => {
  it("is refused with a plain message and writes nothing", () => {
    const bad = seedFlaggedGift(db);
    bumpTaxInputGeneration(db);
    expect(isTaxConventionPending(db)).toBe(true);
    try {
      markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "synthetic source" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(LotBasisVerificationError);
      expect((error as LotBasisVerificationError).code).toBe("ledger_pending");
      expect((error as Error).message).toBe(
        "The tax-lot ledger is waiting on a recompute, so the basis shown may be out of date. Run Recompute on the Tax Lots page, then verify."
      );
    }
    expect(marker(bad.lotTxn)).toBeUndefined();

    computeTaxLots(db);
    expect(isTaxConventionPending(db)).toBe(false);
    expect(() =>
      markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "synthetic source" })
    ).not.toThrow();
  });

  it("an existing marker is left alone by a refused re-mark, and undo still works", () => {
    const bad = seedFlaggedGift(db);
    markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "first" });
    bumpTaxInputGeneration(db);
    expect(() => markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "second" })).toThrow(
      /waiting on a recompute/
    );
    expect(marker(bad.lotTxn)?.source_note).toBe("first");
    expect(unmarkLotBasisVerified(db, bad.lotTxn)).toBe(true);
  });

  it("the ordinary resting state is not pending: a freshly computed book can be marked", () => {
    const bad = seedFlaggedGift(db);
    expect(isTaxConventionPending(db)).toBe(false);
    expect(() =>
      markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "synthetic source" })
    ).not.toThrow();
  });
});

// ── The basis repair script ─────────────────────────────────────────────────

describe("scripts/repair-donated-lot-basis.ts against a verified lot", () => {
  it("a basis change makes the marker stale and the row is left out again", () => {
    const bad = seedFlaggedGift(db);
    markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "synthetic source" });
    expect(year().gainAvoidedRowsLeftOut).toBe(0);

    // A new basis that is still under 1% of the gift's value: the rule still
    // fires, and what was verified is no longer what the row says.
    const plan = planDonatedLotBasisRepair(db, {
      source: "synthetic statement, page 1",
      lots: [
        {
          account: "Vanguard Taxable",
          symbol: "ZZBB",
          acquisitionTransactionId: bad.lotTxn,
          currentAcquisitionDate: "2010-01-10",
          acquisitionDate: "2010-01-10",
          basisPerShare: 0.05,
        },
      ],
    });
    expect(plan.ok).toBe(true);
    expect(applyDonatedLotBasisRepair(db, plan, "2026-10-07")).toEqual({ updated: 1 });

    // The repair leaves the ledger waiting on a recompute. Until it runs, the
    // lot still shows the verified basis and nothing new can be verified.
    expect(() =>
      markLotBasisVerified(db, { acquisitionTransactionId: bad.lotTxn, sourceNote: "too early" })
    ).toThrow(/waiting on a recompute/);
    computeTaxLots(db);
    expect(states(bad.donationId)).toEqual(["verified-stale"]);
    expect(year().gainAvoidedRowsLeftOut).toBe(1);
    expect(year().gainAvoidedRowsCounted).toBe(0);
    expectConserved();
  });
});

// ── Import-batch undo ───────────────────────────────────────────────────────

describe("undoing the import batch that holds a verified acquisition row", () => {
  it("succeeds and takes the marker with it", () => {
    const batchId = createImportBatch(db, "canonical-csv", "synthetic.csv").id;
    const sec = seedSecurity(db, "ZZEE");
    const lotTxn = seedTxn(db, sec, "2010-01-10", "TRANSFER_IN", 100, 0.01, batchId);
    const g = seedGift(db, sec, "2026-04-02", 10, 1000);
    assign(db, g, [{ acquisitionTransactionId: lotTxn, quantity: 10 }]);
    markLotBasisVerified(db, { acquisitionTransactionId: lotTxn, sourceNote: "synthetic source" });

    // While a gift still draws on the lot the undo is refused, as before, and
    // the marker survives the refusal.
    expect(() => undoImport(db, batchId)).toThrow(/lot assignments reference this batch/);
    expect(marker(lotTxn)).toBeDefined();

    assignDonationLots(db, g, []);
    expect(marker(lotTxn)).toBeDefined();
    expect(() => undoImport(db, batchId)).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE id = ?").get(lotTxn)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM lot_basis_verifications").get()).toEqual({ c: 0 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
