/**
 * Owner ruling 14 (2026-11-16): "Gain avoided" on the Giving page is split
 * by holding period, per donated LOT (acquisition date vs the gift date, by
 * the engine's own `isLongTermHolding`). Long-term, short-term and
 * "holding period unknown" always add up to the old single figure, per row
 * and per year, to the cent. Each holding period is split into its gain and
 * loss parts (a lot given below cost is a loss, never a negative gain), and
 * an over-assigned gift's excess is reported apart, never as a negative
 * "unknown" part.
 *
 * Everything is synthetic: ZZ* tickers and round invented numbers.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getGivingView, type GivingDonation, type GivingYear } from "@/lib/queries/giving-view";

function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

interface LotSpec {
  date: string;
  quantityAcquired: number;
  basis: number;
  given: number;
}

let seq = 0;

/** One linked stock gift from account 1 with the given lots assigned. */
function seedGift(
  db: Database.Database,
  opts: { giftDate: string; quantity: number | null; fmv: number; lots: LotSpec[]; currency?: string }
): number {
  seq += 1;
  const secId = db
    .prepare(`INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'Stock', ?)`)
    .run(`ZZ${seq}`, `ZZ test ${seq}`, opts.currency ?? "USD").lastInsertRowid as number;
  const outTxn = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, source_key)
       VALUES (1, ?, ?, 'TRANSFER_OUT', ?, ?)`
    )
    .run(secId, opts.giftDate, opts.quantity ?? 0, `t:out:${seq}`).lastInsertRowid as number;
  const donationId = db
    .prepare(
      `INSERT INTO donations (source_key, kind, security_id, symbol_raw, quantity, fmv_usd, received_date)
       VALUES (?, 'stock', ?, ?, ?, ?, ?)`
    )
    .run(`t:don:${seq}`, secId, `ZZ${seq}`, opts.quantity, opts.fmv, opts.giftDate).lastInsertRowid as number;
  db.prepare(`INSERT INTO donation_leg_links (donation_id, transaction_id, role) VALUES (?, ?, 'out')`).run(
    donationId,
    outTxn
  );
  opts.lots.forEach((lot, i) => {
    const acq = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, source_key)
         VALUES (1, ?, ?, 'BUY', ?, ?, ?)`
      )
      .run(
        secId,
        lot.date === "" ? "2020-01-01" : lot.date,
        lot.quantityAcquired,
        lot.basis / lot.quantityAcquired,
        `t:acq:${seq}:${i}`
      ).lastInsertRowid as number;
    db.prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_transaction_id, acquisition_date,
         acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      secId,
      acq,
      lot.date,
      lot.basis / lot.quantityAcquired,
      lot.quantityAcquired,
      lot.quantityAcquired - lot.given,
      lot.basis
    );
    db.prepare(`INSERT INTO donation_lots (donation_id, acquisition_transaction_id, quantity) VALUES (?, ?, ?)`).run(
      donationId,
      acq,
      lot.given
    );
  });
  return donationId;
}

function row(view: { years: GivingYear[] }, donationId: number): GivingDonation {
  for (const y of view.years) {
    const found = y.donations.find((gd) => gd.donation.id === donationId);
    if (found) return found;
  }
  throw new Error(`no row ${donationId}`);
}

const cents = (n: number) => Math.round(n * 100);

describe("Giving: gain avoided split by holding period (ruling 14)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = fresh();
  });

  it("splits a mixed gift per lot: long-term and short-term parts, nothing unknown", () => {
    // 10 shares at 100 a share. LT lot: 6 shares at 50 → 300. ST lot: 4 at 80 → 80.
    const id = seedGift(db, {
      giftDate: "2026-03-02",
      quantity: 10,
      fmv: 1000,
      lots: [
        { date: "2024-01-10", quantityAcquired: 6, basis: 300, given: 6 },
        { date: "2025-09-01", quantityAcquired: 4, basis: 320, given: 4 },
      ],
    });
    const view = getGivingView(db);
    const gd = row(view, id);
    expect(gd.gainAvoided).toBeCloseTo(380, 6);
    expect(gd.gainAvoidedLongTermGain).toBeCloseTo(300, 6);
    expect(gd.gainAvoidedShortTermGain).toBeCloseTo(80, 6);
    expect(gd.gainAvoidedHoldingUnknown).toBe(0);
    const [year] = view.years;
    expect(year.gainAvoidedLongTermGain).toBeCloseTo(300, 6);
    expect(year.gainAvoidedShortTermGain).toBeCloseTo(80, 6);
    expect(year.gainAvoidedHoldingUnknown).toBe(0);
    expect(year.gainAvoidedRowsWithShortTerm).toBe(1);
    expect(year.gainAvoidedRowsHoldingUnknown).toBe(0);
  });

  it("long-term only when given AFTER the first anniversary (the engine's own test)", () => {
    const onAnniversary = seedGift(db, {
      giftDate: "2026-03-02",
      quantity: 1,
      fmv: 100,
      lots: [{ date: "2025-03-02", quantityAcquired: 1, basis: 40, given: 1 }],
    });
    const dayAfter = seedGift(db, {
      giftDate: "2026-03-02",
      quantity: 1,
      fmv: 100,
      lots: [{ date: "2025-03-01", quantityAcquired: 1, basis: 40, given: 1 }],
    });
    const view = getGivingView(db);
    expect(row(view, onAnniversary).gainAvoidedShortTermGain).toBeCloseTo(60, 6);
    expect(row(view, onAnniversary).gainAvoidedLongTermGain).toBe(0);
    expect(row(view, dayAfter).gainAvoidedLongTermGain).toBeCloseTo(60, 6);
    expect(row(view, dayAfter).gainAvoidedShortTermGain).toBe(0);
    expect(view.years[0].gainAvoidedRowsWithShortTerm).toBe(1);
  });

  it("a lot with no readable acquisition date goes under 'holding period unknown' and is counted", () => {
    const id = seedGift(db, {
      giftDate: "2026-03-02",
      quantity: 10,
      fmv: 1000,
      lots: [
        { date: "2024-01-10", quantityAcquired: 5, basis: 250, given: 5 },
        { date: "", quantityAcquired: 5, basis: 200, given: 5 },
      ],
    });
    const view = getGivingView(db);
    const gd = row(view, id);
    expect(gd.gainAvoidedLongTermGain).toBeCloseTo(250, 6);
    expect(gd.gainAvoidedShortTermGain).toBe(0);
    expect(gd.gainAvoidedHoldingUnknown).toBeCloseTo(300, 6);
    expect(gd.longTermQuantity).toBe(5);
    expect(gd.shortTermQuantity).toBe(0);
    expect(view.years[0].gainAvoidedRowsHoldingUnknown).toBe(1);
    expect(view.years[0].gainAvoidedRowsWithShortTerm).toBe(0);
  });

  it("shares given but not assigned to a lot are 'holding period unknown', not long-term", () => {
    const id = seedGift(db, {
      giftDate: "2026-03-02",
      quantity: 10,
      fmv: 1000,
      lots: [{ date: "2024-01-10", quantityAcquired: 6, basis: 300, given: 6 }],
    });
    const gd = row(getGivingView(db), id);
    // Old single figure: 1000 - 300 = 700. LT part 6 × (100 - 50) = 300; 4 shares unassigned.
    expect(gd.gainAvoided).toBeCloseTo(700, 6);
    expect(gd.gainAvoidedLongTermGain).toBeCloseTo(300, 6);
    expect(gd.gainAvoidedHoldingUnknown).toBeCloseTo(400, 6);
  });

  it("left-out rows (implausible basis, non-USD) stay out of every split figure and stay counted", () => {
    const counted = seedGift(db, {
      giftDate: "2026-03-02",
      quantity: 10,
      fmv: 1000,
      lots: [{ date: "2025-12-01", quantityAcquired: 10, basis: 500, given: 10 }],
    });
    // Penny basis: under 1% of the gift's per-share value.
    seedGift(db, {
      giftDate: "2026-03-02",
      quantity: 10,
      fmv: 1000,
      lots: [{ date: "2020-01-10", quantityAcquired: 10, basis: 0.1, given: 10 }],
    });
    seedGift(db, {
      giftDate: "2026-03-02",
      quantity: 10,
      fmv: 1000,
      currency: "CAD",
      lots: [{ date: "2025-12-01", quantityAcquired: 10, basis: 100, given: 10 }],
    });
    const view = getGivingView(db);
    const [year] = view.years;
    expect(year.gainAvoidedRowsLeftOut).toBe(1);
    expect(year.gainAvoidedRowsUnsupported).toBe(1);
    expect(year.gainAvoided).toBeCloseTo(500, 6);
    expect(year.gainAvoidedShortTermGain).toBeCloseTo(500, 6);
    expect(year.gainAvoidedLongTermGain).toBe(0);
    expect(year.gainAvoidedRowsWithShortTerm).toBe(1);
    expect(row(view, counted).gainAvoidedShortTermGain).toBeCloseTo(500, 6);
  });

  it("a pending year (a row with no lots) has no split figures either", () => {
    seedGift(db, { giftDate: "2026-03-02", quantity: 10, fmv: 1000, lots: [] });
    const [year] = getGivingView(db).years;
    expect(year.gainAvoided).toBeNull();
    expect(year.gainAvoidedLongTermGain).toBeNull();
    expect(year.gainAvoidedShortTermGain).toBeNull();
    expect(year.gainAvoidedHoldingUnknown).toBeNull();
  });

  it("a lot given below its cost is a LOSS part, never a negative gain (both holding periods)", () => {
    // 10 shares at 100. LT gain lot: 4 at 50. LT loss lot: 2 at 150. ST gain lot: 1 at 60. ST loss lot: 3 at 130.
    const id = seedGift(db, {
      giftDate: "2026-03-02",
      quantity: 10,
      fmv: 1000,
      lots: [
        { date: "2020-01-10", quantityAcquired: 4, basis: 200, given: 4 },
        { date: "2021-01-10", quantityAcquired: 2, basis: 300, given: 2 },
        { date: "2025-10-01", quantityAcquired: 1, basis: 60, given: 1 },
        { date: "2025-11-01", quantityAcquired: 3, basis: 390, given: 3 },
      ],
    });
    const view = getGivingView(db);
    const gd = row(view, id);
    expect(gd.gainAvoided).toBeCloseTo(50, 6); // 1000 - 950
    expect(gd.gainAvoidedLongTermGain).toBeCloseTo(200, 6);
    expect(gd.gainAvoidedLongTermLoss).toBeCloseTo(-100, 6);
    expect(gd.gainAvoidedShortTermGain).toBeCloseTo(40, 6);
    expect(gd.gainAvoidedShortTermLoss).toBeCloseTo(-90, 6);
    expect(gd.gainAvoidedHoldingUnknown).toBe(0);
    expect(gd.gainAvoidedOverAssigned).toBe(0);
    const [year] = view.years;
    expect(year.gainAvoidedLongTermGain).toBeCloseTo(200, 6);
    expect(year.gainAvoidedLongTermLoss).toBeCloseTo(-100, 6);
    expect(year.gainAvoidedShortTermGain).toBeCloseTo(40, 6);
    expect(year.gainAvoidedShortTermLoss).toBeCloseTo(-90, 6);
  });

  it("an all-loss short-term gift has a zero gain part and its loss apart", () => {
    const id = seedGift(db, {
      giftDate: "2026-03-02",
      quantity: 5,
      fmv: 400,
      lots: [{ date: "2025-12-01", quantityAcquired: 5, basis: 500, given: 5 }],
    });
    const gd = row(getGivingView(db), id);
    expect(gd.gainAvoided).toBeCloseTo(-100, 6);
    expect(gd.gainAvoidedShortTermGain).toBe(0);
    expect(gd.gainAvoidedShortTermLoss).toBeCloseTo(-100, 6);
    expect(gd.hasShortTermShares).toBe(true);
    expect(gd.hasLongTermShares).toBe(false);
  });

  it("an over-assigned gift reports its excess apart, never a negative 'holding period unknown', and is counted", () => {
    // 5 shares given at 100, 7 shares assigned (all long-term, basis 40 a share).
    const id = seedGift(db, {
      giftDate: "2026-03-02",
      quantity: 5,
      fmv: 500,
      lots: [{ date: "2020-01-10", quantityAcquired: 7, basis: 280, given: 7 }],
    });
    const view = getGivingView(db);
    const gd = row(view, id);
    expect(gd.gainAvoided).toBeCloseTo(220, 6); // old figure: 500 - 280
    expect(gd.gainAvoidedLongTermGain).toBeCloseTo(420, 6); // 7 × (100 - 40)
    expect(gd.gainAvoidedHoldingUnknown).toBe(0);
    expect(gd.gainAvoidedOverAssigned).toBeCloseTo(200, 6); // the 2 extra shares' value
    const [year] = view.years;
    expect(year.gainAvoidedRowsOverAssigned).toBe(1);
    expect(year.gainAvoidedOverAssigned).toBeCloseTo(200, 6);
    expect(year.gainAvoidedHoldingUnknown).toBe(0);
  });

  it("the row's short-term flag and the year's short-term count use the same threshold", () => {
    // A dust short-term assignment (below QUANTITY_EPS) is neither on the row nor in the year.
    const id = seedGift(db, {
      giftDate: "2026-03-02",
      quantity: 10,
      fmv: 1000,
      lots: [
        { date: "2020-01-10", quantityAcquired: 10, basis: 500, given: 10 },
        { date: "2025-12-01", quantityAcquired: 1, basis: 50, given: 1e-12 },
      ],
    });
    const view = getGivingView(db);
    const gd = row(view, id);
    expect(gd.shortTermQuantity!).toBeGreaterThan(0);
    expect(gd.hasShortTermShares).toBe(false);
    expect(view.years[0].gainAvoidedRowsWithShortTerm).toBe(0);
  });

  it("CONSERVATION: LT gain + LT loss + ST gain + ST loss + unknown == the old gain-avoided figure, to the cent, for every row and every year (over-assigned excess reported apart)", () => {
    // Awkward per-share figures so rounding is exercised.
    seedGift(db, {
      giftDate: "2026-03-02",
      quantity: 3,
      fmv: 1000.01,
      lots: [
        { date: "2024-01-10", quantityAcquired: 7, basis: 333.33, given: 1 },
        { date: "2025-11-30", quantityAcquired: 3, basis: 101.01, given: 1 },
        { date: "2025-12-31", quantityAcquired: 9, basis: 777.77, given: 1 },
      ],
    });
    seedGift(db, {
      giftDate: "2025-06-15",
      quantity: 7.5,
      fmv: 912.34,
      lots: [
        { date: "2023-02-28", quantityAcquired: 2.25, basis: 99.99, given: 2.25 },
        { date: "", quantityAcquired: 3, basis: 150, given: 3 },
      ],
    });
    seedGift(db, {
      giftDate: "2025-08-01",
      quantity: null,
      fmv: 500,
      lots: [{ date: "2024-01-10", quantityAcquired: 4, basis: 120, given: 4 }],
    });
    seedGift(db, {
      giftDate: "2026-04-01",
      quantity: 11,
      fmv: 1234.56,
      lots: [
        { date: "2025-04-01", quantityAcquired: 6, basis: 456.78, given: 6 },
        { date: "2025-04-02", quantityAcquired: 5, basis: 321.09, given: 5 },
      ],
    });
    // Loss lots in both holding periods, beside gain lots.
    seedGift(db, {
      giftDate: "2026-05-05",
      quantity: 9,
      fmv: 777.77,
      lots: [
        { date: "2022-05-05", quantityAcquired: 3, basis: 600.01, given: 3 },
        { date: "2023-05-05", quantityAcquired: 2, basis: 33.33, given: 2 },
        { date: "2026-01-05", quantityAcquired: 4, basis: 999.99, given: 4 },
      ],
    });
    // Over-assigned: 7 shares assigned to a 5-share gift.
    seedGift(db, {
      giftDate: "2025-10-10",
      quantity: 5,
      fmv: 523.45,
      lots: [
        { date: "2023-01-03", quantityAcquired: 4, basis: 123.45, given: 4 },
        { date: "2025-07-03", quantityAcquired: 3, basis: 210.12, given: 3 },
      ],
    });
    const view = getGivingView(db);
    expect(view.years.length).toBe(2);
    let rowsChecked = 0;
    let lossRows = 0;
    let overAssignedRows = 0;
    const parts = (x: GivingYear | GivingDonation) =>
      x.gainAvoidedLongTermGain! +
      x.gainAvoidedLongTermLoss! +
      x.gainAvoidedShortTermGain! +
      x.gainAvoidedShortTermLoss! +
      x.gainAvoidedHoldingUnknown!;
    for (const year of view.years) {
      expect(year.gainAvoided).not.toBeNull();
      expect(cents(parts(year))).toBe(cents(year.gainAvoided! + year.gainAvoidedOverAssigned!));
      for (const gd of year.donations) {
        if (gd.gainAvoided == null) continue;
        rowsChecked += 1;
        // Sign rules: a gain part is never negative, a loss part never positive.
        expect(gd.gainAvoidedLongTermGain!).toBeGreaterThanOrEqual(0);
        expect(gd.gainAvoidedShortTermGain!).toBeGreaterThanOrEqual(0);
        expect(gd.gainAvoidedLongTermLoss!).toBeLessThanOrEqual(0);
        expect(gd.gainAvoidedShortTermLoss!).toBeLessThanOrEqual(0);
        expect(gd.gainAvoidedOverAssigned!).toBeGreaterThanOrEqual(0);
        if (gd.gainAvoidedLongTermLoss! < 0 || gd.gainAvoidedShortTermLoss! < 0) lossRows += 1;
        if (gd.gainAvoidedOverAssigned! > 0) overAssignedRows += 1;
        // Without the over-assigned excess the parts are the old figure exactly.
        expect(cents(parts(gd))).toBe(cents(gd.gainAvoided + gd.gainAvoidedOverAssigned!));
      }
    }
    expect(rowsChecked).toBe(6);
    expect(lossRows).toBe(1);
    expect(overAssignedRows).toBe(1);
  });
});
