/**
 * scripts/repair-donated-lot-basis.ts — the owner-run correction of a donated
 * lot's acquisition date and basis (owner ruling 2026-10-06).
 *
 * Runs the real planner and applier on a fully migrated in-memory database,
 * then the real engine and the real Giving view, so the test proves the whole
 * chain: wrong row → flagged → repaired → recomputed → no longer flagged.
 * Every figure is synthetic.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getGivingView } from "@/lib/queries/giving-view";
import { linkDonationLegs, assignDonationLots } from "@/lib/mutations/donation-links";
import { insertDonation } from "@/lib/mutations/donations";
import { bumpTaxInputGeneration, getTaxConventionState } from "@/lib/compute/tax-convention";
import {
  applyDonatedLotBasisRepair,
  describeChange,
  planDonatedLotBasisRepair,
  validateConfig,
  type DonatedLotBasisConfig,
} from "@/scripts/repair-donated-lot-basis";

let db: Database.Database;
let seq = 0;
const ACCOUNT = "Vanguard Taxable"; // migration 002, id 1

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function security(symbol: string, type = "Stock", multiplier: number | null = null): number {
  return db
    .prepare("INSERT INTO securities (symbol, currency, security_type, multiplier) VALUES (?, 'USD', ?, ?)")
    .run(symbol, type, multiplier).lastInsertRowid as number;
}

function txn(
  sec: number,
  date: string,
  type: string,
  qty: number,
  price: number,
  opts: { amount?: number | null; fees?: number; sourceKey?: string; accountId?: number } = {}
): number {
  seq++;
  return db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'opening transfer')`
    )
    .run(
      opts.accountId ?? 1,
      sec,
      date,
      type,
      qty,
      price,
      opts.amount === undefined ? qty * price : opts.amount,
      opts.fees ?? 0,
      opts.sourceKey ?? `repair-${seq}`
    ).lastInsertRowid as number;
}

/** A linked gift of `quantity` shares worth 100 a share, assigned to `lotTxn`. */
function giftFrom(sec: number, lotTxn: number, date: string, quantity: number): number {
  seq++;
  const out = txn(sec, date, "TRANSFER_OUT", quantity, 0);
  const id = insertDonation(
    db,
    {
      sourceKey: `repair-don-${seq}`,
      kind: "stock",
      securityId: sec,
      symbolRaw: "ZZAA",
      quantity,
      fmvUsd: quantity * 100,
      unitValuation: null,
      createdDate: null,
      receivedDate: date,
      completedDate: null,
      notes: null,
    },
    null
  );
  linkDonationLegs(db, { donationId: id, outTransactionId: out });
  computeTaxLots(db);
  assignDonationLots(db, id, [{ acquisitionTransactionId: lotTxn, quantity }]);
  computeTaxLots(db);
  return id;
}

/** The defect: 100 shares "acquired" in 2011 at a cent a share, 10 of them given in 2025. */
function seedDefect() {
  const sec = security("ZZAA");
  const lotTxn = txn(sec, "2011-02-03", "TRANSFER_IN", 100, 0.01);
  const donationId = giftFrom(sec, lotTxn, "2025-06-16", 10);
  return { sec, lotTxn, donationId };
}

function config(lotTxn: number, over: Partial<DonatedLotBasisConfig["lots"][number]> = {}): DonatedLotBasisConfig {
  return {
    source: "synthetic statement, page 1",
    lots: [
      {
        account: ACCOUNT,
        symbol: "ZZAA",
        acquisitionTransactionId: lotTxn,
        currentAcquisitionDate: "2011-02-03",
        acquisitionDate: "2021-04-07",
        basisPerShare: 40,
        ...over,
      },
    ],
  };
}

function row(id: number) {
  return db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as {
    trade_date: string;
    price_per_share: number;
    amount: number;
    notes: string;
    source_key: string;
    quantity: number;
  };
}

function everything(): string {
  return JSON.stringify(
    ["transactions", "tax_lots", "tax_lot_sales", "donations", "donation_lots", "donation_leg_links", "settings"].map(
      (t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()
    )
  );
}

function givingRow(donationId: number) {
  for (const y of getGivingView(db).years) {
    const found = y.donations.find((gd) => gd.donation.id === donationId);
    if (found) return { row: found, year: y };
  }
  throw new Error("donation not in view");
}

describe("validateConfig", () => {
  const good = config(1);

  it("accepts the documented shape", () => {
    expect(validateConfig(good)).toEqual(good);
  });

  it("rejects a malformed config with a reason", () => {
    expect(() => validateConfig(null)).toThrow(/object/);
    expect(() => validateConfig({ ...good, source: "" })).toThrow(/source/);
    expect(() => validateConfig({ ...good, lots: [] })).toThrow(/non-empty/);
    const bad = (over: Record<string, unknown>) => () => validateConfig({ ...good, lots: [{ ...good.lots[0], ...over }] });
    expect(bad({ acquisitionDate: "04/07/2021" })).toThrow(/acquisitionDate/);
    expect(bad({ acquisitionDate: "2021-02-30" })).toThrow(/acquisitionDate/);
    expect(bad({ currentAcquisitionDate: "2010" })).toThrow(/currentAcquisitionDate/);
    expect(bad({ basisPerShare: 0 })).toThrow(/basisPerShare/);
    expect(bad({ basisPerShare: -1 })).toThrow(/basisPerShare/);
    expect(bad({ basisPerShare: NaN })).toThrow(/basisPerShare/);
    expect(bad({ basisPerShare: "40" })).toThrow(/basisPerShare/);
    expect(bad({ acquisitionTransactionId: 1.5 })).toThrow(/acquisitionTransactionId/);
    expect(bad({ account: "" })).toThrow(/account/);
  });

  it("accepts the two acknowledgement flags only as booleans", () => {
    const withFlags = { ...good, lots: [{ ...good.lots[0], acknowledgeSalesAffected: true, acknowledgeValuedHistory: false }] };
    expect(validateConfig(withFlags)).toEqual(withFlags);
    for (const flag of ["acknowledgeSalesAffected", "acknowledgeValuedHistory"]) {
      for (const value of ["true", 1, null]) {
        expect(() => validateConfig({ ...good, lots: [{ ...good.lots[0], [flag]: value }] })).toThrow(new RegExp(flag));
      }
    }
  });

  it("rejects the same transaction named twice", () => {
    expect(() => validateConfig({ ...good, lots: [good.lots[0], { ...good.lots[0] }] })).toThrow(/more than once/);
  });
});

describe("planDonatedLotBasisRepair", () => {
  it("plans the correction and writes nothing", () => {
    const { lotTxn } = seedDefect();
    const before = everything();
    const plan = planDonatedLotBasisRepair(db, config(lotTxn));
    expect(plan.ok).toBe(true);
    expect(plan.lots).toHaveLength(1);
    expect(plan.lots[0]).toMatchObject({
      status: "repair",
      transactionId: lotTxn,
      dateChanges: true,
      basisChanges: true,
      donationsAssigned: 1,
    });
    expect(everything()).toBe(before);
  });

  const refusals: [string, (lotTxn: number, sec: number) => DonatedLotBasisConfig, RegExp][] = [
    ["an unknown transaction", () => config(999999), /not found/],
    ["a different account than the config names", (t) => config(t, { account: "IBKR" }), /account or symbol/],
    ["a different symbol than the config names", (t) => config(t, { symbol: "ZZBB" }), /account or symbol/],
    [
      "a row that is not in the state the config describes",
      (t) => config(t, { currentAcquisitionDate: "2011-01-01" }),
      /currentAcquisitionDate/,
    ],
    [
      "a new date on or after the gift it funded",
      (t) => config(t, { acquisitionDate: "2025-06-16" }),
      /before every donation/,
    ],
  ];
  for (const [name, build, reason] of refusals) {
    it(`refuses ${name}`, () => {
      const { lotTxn, sec } = seedDefect();
      const before = everything();
      const plan = planDonatedLotBasisRepair(db, build(lotTxn, sec));
      expect(plan.ok).toBe(false);
      expect(plan.lots[0].status).toBe("refused");
      expect(plan.lots[0].reason).toMatch(reason);
      expect(() => applyDonatedLotBasisRepair(db, plan, "2026-10-07")).toThrow(/refused/);
      expect(everything()).toBe(before);
    });
  }

  it("refuses a lot that no donation draws on (it only repairs donated lots)", () => {
    const sec = security("ZZAA");
    const lotTxn = txn(sec, "2011-02-03", "TRANSFER_IN", 100, 0.01);
    const plan = planDonatedLotBasisRepair(db, config(lotTxn));
    expect(plan.lots[0].reason).toMatch(/no donation/);
  });

  it("refuses a short-opening row, a sale and an outbound transfer", () => {
    const sec = security("ZZAA");
    for (const type of ["SHORT_SELL", "SELL_TO_OPEN", "SELL", "TRANSFER_OUT"]) {
      const id = txn(sec, "2011-02-03", type, 100, 0.01);
      // Force an assignment row so the type check is what refuses.
      const don = db
        .prepare(
          `INSERT INTO donations (source_key, kind, security_id, quantity, fmv_usd, received_date)
           VALUES (?, 'stock', ?, 10, 1000, '2025-06-16')`
        )
        .run(`short-${type}`, sec).lastInsertRowid as number;
      db.prepare("INSERT INTO donation_lots (donation_id, acquisition_transaction_id, quantity) VALUES (?, ?, 10)").run(don, id);
      const plan = planDonatedLotBasisRepair(db, config(id));
      expect(plan.lots[0].status).toBe("refused");
      expect(plan.lots[0].reason).toMatch(/not a long share acquisition/);
    }
  });

  it("refuses a bond or an option (basis is not shares times price there)", () => {
    for (const [symbol, type, multiplier] of [
      ["ZZBOND", "Bond", null],
      ["ZZOPT", "Option", 100],
    ] as const) {
      const sec = security(symbol, type, multiplier);
      const id = txn(sec, "2011-02-03", "BUY", 100, 0.01);
      const don = db
        .prepare(
          `INSERT INTO donations (source_key, kind, security_id, quantity, fmv_usd, received_date)
           VALUES (?, 'stock', ?, 10, 1000, '2025-06-16')`
        )
        .run(`unit-${symbol}`, sec).lastInsertRowid as number;
      db.prepare("INSERT INTO donation_lots (donation_id, acquisition_transaction_id, quantity) VALUES (?, ?, 10)").run(don, id);
      const plan = planDonatedLotBasisRepair(db, config(id, { symbol }));
      expect(plan.lots[0].status).toBe("refused");
      expect(plan.lots[0].reason).toMatch(/plain shares/);
    }
  });

  it("refuses a row that carries fees (the engine would add them on top of the stated basis)", () => {
    const sec = security("ZZAA");
    const lotTxn = txn(sec, "2011-02-03", "BUY", 100, 0.01, { fees: 5 });
    giftFrom(sec, lotTxn, "2025-06-16", 10);
    const plan = planDonatedLotBasisRepair(db, config(lotTxn));
    expect(plan.lots[0].reason).toMatch(/fees/);
  });

  it("refuses a row with no share count", () => {
    const { lotTxn } = seedDefect();
    db.prepare("UPDATE transactions SET quantity = NULL WHERE id = ?").run(lotTxn);
    expect(planDonatedLotBasisRepair(db, config(lotTxn)).lots[0].reason).toMatch(/share count/);
    db.prepare("UPDATE transactions SET quantity = 0 WHERE id = ?").run(lotTxn);
    expect(planDonatedLotBasisRepair(db, config(lotTxn)).lots[0].reason).toMatch(/share count/);
  });

  it("refuses a lot that sales already closed part of, unless the config acknowledges it", () => {
    const sec = security("ZZAA");
    const lotTxn = txn(sec, "2011-02-03", "TRANSFER_IN", 100, 0.01);
    txn(sec, "2018-02-01", "SELL", 20, 50);
    txn(sec, "2018-03-01", "SELL", 5, 50);
    giftFrom(sec, lotTxn, "2025-06-16", 10);
    const before = everything();

    // Basis-only, and a date move that stays before the first sale: both refused without the flag.
    for (const acquisitionDate of ["2011-02-03", "2018-01-31"]) {
      const plan = planDonatedLotBasisRepair(db, config(lotTxn, { acquisitionDate }));
      expect(plan.ok).toBe(false);
      expect(plan.lots[0].salesAffected).toBe(2);
      expect(plan.lots[0].reason).toMatch(/2 sale row\(s\) already closed part of this lot/);
      expect(plan.lots[0].reason).toMatch(/realized gain will change/);
      expect(plan.lots[0].reason).toMatch(/acknowledgeSalesAffected/);
      expect(() => applyDonatedLotBasisRepair(db, plan, "2026-10-07")).toThrow(/refused/);
    }
    // false is not an acknowledgement.
    expect(planDonatedLotBasisRepair(db, config(lotTxn, { acquisitionDate: "2018-01-31", acknowledgeSalesAffected: false })).ok).toBe(false);
    expect(everything()).toBe(before);

    const acked = planDonatedLotBasisRepair(db, config(lotTxn, { acquisitionDate: "2018-01-31", acknowledgeSalesAffected: true }));
    expect(acked.ok).toBe(true);
    expect(acked.lots[0]).toMatchObject({ status: "repair", salesAffected: 2 });
    const realizedBefore = db.prepare("SELECT SUM(realized_gain_loss) AS g FROM tax_lot_sales").get() as { g: number };
    applyDonatedLotBasisRepair(db, acked, "2026-10-07");
    computeTaxLots(db);
    const realizedAfter = db.prepare("SELECT SUM(realized_gain_loss) AS g FROM tax_lot_sales").get() as { g: number };
    // The warning is true: 25 shares sold at 50, basis 0.01 before and 40 after.
    expect(realizedBefore.g).toBeCloseTo(25 * (50 - 0.01), 6);
    expect(realizedAfter.g).toBeCloseTo(25 * (50 - 40), 6);
  });

  it("even with the acknowledgement, the new date must be before every sale that closed part of the lot", () => {
    const sec = security("ZZAA");
    const lotTxn = txn(sec, "2011-02-03", "TRANSFER_IN", 100, 0.01);
    txn(sec, "2018-02-01", "SELL", 20, 50);
    giftFrom(sec, lotTxn, "2025-06-16", 10);
    for (const acquisitionDate of ["2021-04-07", "2018-02-01"]) {
      const plan = planDonatedLotBasisRepair(db, config(lotTxn, { acquisitionDate, acknowledgeSalesAffected: true }));
      expect(plan.lots[0].status).toBe("refused");
      expect(plan.lots[0].reason).toMatch(/not before every sale/);
    }
  });

  it("a lot no sale has touched needs no acknowledgement and reports zero", () => {
    const { lotTxn } = seedDefect();
    const plan = planDonatedLotBasisRepair(db, config(lotTxn));
    expect(plan.ok).toBe(true);
    expect(plan.lots[0].salesAffected).toBe(0);
  });

  it("prints each row's date and basis before and after (terminal only)", () => {
    const { lotTxn } = seedDefect();
    const plan = planDonatedLotBasisRepair(db, config(lotTxn));
    expect(describeChange(plan.lots[0])).toEqual([
      "acquisition date  2011-02-03 -> 2021-04-07",
      "basis per share   0.01 -> 40",
      "amount on the row 1 -> 4000  (100 shares)",
    ]);
    const refused = planDonatedLotBasisRepair(db, config(999999));
    expect(describeChange(refused.lots[0])).toEqual([]);
  });

  it("refuses a move across a corporate action on the security", () => {
    const { sec, lotTxn } = seedDefect();
    db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, source)
       VALUES (?, 'SPLIT', '2015-06-01', 2, 1, 'import')`
    ).run(sec);
    const plan = planDonatedLotBasisRepair(db, config(lotTxn));
    expect(plan.lots[0].status).toBe("refused");
    expect(plan.lots[0].reason).toMatch(/corporate action/);
    // A move that stays on one side of it, and a basis-only fix, are allowed.
    expect(planDonatedLotBasisRepair(db, config(lotTxn, { acquisitionDate: "2014-05-10" })).ok).toBe(true);
    expect(planDonatedLotBasisRepair(db, config(lotTxn, { acquisitionDate: "2011-02-03" })).ok).toBe(true);
  });

  it("refuses to touch a row inside the account's valued history", () => {
    const { lotTxn } = seedDefect();
    db.prepare(
      "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value) VALUES (1, '2018-12-31', 1000)"
    ).run();
    // New date lands inside the valued history.
    const plan = planDonatedLotBasisRepair(db, config(lotTxn));
    expect(plan.lots[0].status).toBe("refused");
    expect(plan.lots[0].reason).toMatch(/valued history/);
    // The refusal says why and how to proceed; the named override (and only `true`) lifts it.
    expect(plan.lots[0].reason).toMatch(/valuation and return history/);
    expect(plan.lots[0].reason).toMatch(/acknowledgeValuedHistory/);
    expect(planDonatedLotBasisRepair(db, config(lotTxn, { acknowledgeValuedHistory: false })).ok).toBe(false);
    expect(planDonatedLotBasisRepair(db, config(lotTxn, { acknowledgeValuedHistory: true })).ok).toBe(true);
    // Both dates before the first valuation: allowed.
    expect(planDonatedLotBasisRepair(db, config(lotTxn, { acquisitionDate: "2018-05-10" })).ok).toBe(true);
    // Another account's snapshots do not matter.
    db.prepare("DELETE FROM monthly_snapshots").run();
    db.prepare(
      "INSERT INTO monthly_snapshots (account_id, month_end_date, total_value) VALUES (2, '2005-12-31', 1000)"
    ).run();
    expect(planDonatedLotBasisRepair(db, config(lotTxn)).ok).toBe(true);
  });

  it("refuses to repair on a stale ledger, and still reports an already-repaired row", () => {
    const sec = security("ZZAA");
    const lotTxn = txn(sec, "2011-02-03", "TRANSFER_IN", 100, 0.01);
    giftFrom(sec, lotTxn, "2025-06-16", 10);
    // A sale lands and the generation moves, but nobody has recomputed: the
    // stored ledger shows no sale on this lot.
    txn(sec, "2018-02-01", "SELL", 20, 50);
    bumpTaxInputGeneration(db);
    const before = everything();
    const plan = planDonatedLotBasisRepair(db, config(lotTxn, { acquisitionDate: "2018-01-31" }));
    expect(plan.ok).toBe(false);
    expect(plan.lots[0].salesAffected).toBe(0); // the stale ledger's answer, which is why it must not be trusted
    expect(plan.lots[0].reason).toMatch(/waiting on a recompute/);
    expect(plan.lots[0].reason).toMatch(/recompute first/);
    expect(() => applyDonatedLotBasisRepair(db, plan, "2026-10-07")).toThrow(/refused/);
    expect(everything()).toBe(before);

    // After the recompute the sale is seen and the ordinary sales refusal applies.
    computeTaxLots(db);
    const fresh = planDonatedLotBasisRepair(db, config(lotTxn, { acquisitionDate: "2018-01-31" }));
    expect(fresh.lots[0].salesAffected).toBe(1);
    expect(fresh.lots[0].reason).toMatch(/acknowledgeSalesAffected/);

    // Applying leaves the ledger stale by design; the re-run still says "already repaired".
    const acked = config(lotTxn, { acquisitionDate: "2018-01-31", acknowledgeSalesAffected: true });
    applyDonatedLotBasisRepair(db, planDonatedLotBasisRepair(db, acked), "2026-10-07");
    const again = planDonatedLotBasisRepair(db, acked);
    expect(again.ok).toBe(true);
    expect(again.lots[0].status).toBe("already-repaired");
  });

  it("one refused lot refuses the whole config", () => {
    const sec = security("ZZAA");
    const good = txn(sec, "2011-02-03", "TRANSFER_IN", 100, 0.01);
    giftFrom(sec, good, "2025-06-16", 10);
    const cfg = config(good);
    cfg.lots.push({ ...cfg.lots[0], acquisitionTransactionId: 999999 });
    const before = everything();
    const plan = planDonatedLotBasisRepair(db, cfg);
    expect(plan.ok).toBe(false);
    expect(plan.lots.map((l) => l.status)).toEqual(["repair", "refused"]);
    expect(() => applyDonatedLotBasisRepair(db, plan, "2026-10-07")).toThrow(/refused/);
    expect(everything()).toBe(before);
  });
});

describe("applyDonatedLotBasisRepair", () => {
  it("corrects only the named row, bumps the tax generation once, and a recompute clears the flag", () => {
    const { sec, lotTxn, donationId } = seedDefect();
    const bystander = txn(sec, "2011-01-10", "BUY", 50, 0.02);
    expect(givingRow(donationId).row.basisImplausible).toBe(true);
    expect(givingRow(donationId).year.gainAvoidedRowsLeftOut).toBe(1);
    const others = () =>
      JSON.stringify(db.prepare("SELECT * FROM transactions WHERE id != ? ORDER BY id").all(lotTxn));
    const othersBefore = others();
    const genBefore = getTaxConventionState(db).recomputeCurrent;
    expect(genBefore).toBe(true);

    const plan = planDonatedLotBasisRepair(db, config(lotTxn));
    const result = applyDonatedLotBasisRepair(db, plan, "2026-10-07");
    expect(result).toEqual({ updated: 1 });

    const r = row(lotTxn);
    expect(r.trade_date).toBe("2021-04-07");
    expect(r.price_per_share).toBe(40);
    expect(r.amount).toBe(4000);
    expect(r.quantity).toBe(100);
    expect(r.notes).toContain("opening transfer");
    expect(r.notes).toContain("2026-10-07");
    expect(r.notes).toContain("synthetic statement, page 1");
    expect(others()).toBe(othersBefore);
    expect(row(bystander).price_per_share).toBe(0.02);
    // The donation's assignment still points at the same transaction.
    const assignment = db.prepare("SELECT acquisition_transaction_id FROM donation_lots WHERE donation_id = ?").get(donationId);
    expect(assignment).toEqual({ acquisition_transaction_id: lotTxn });
    // Lots are stale until the owner recomputes; the script does not recompute.
    expect(getTaxConventionState(db).recomputeCurrent).toBe(false);
    expect(givingRow(donationId).row.basisImplausible).toBe(true);

    computeTaxLots(db);
    const after = givingRow(donationId);
    expect(after.row.basisImplausible).toBe(false);
    expect(after.row.basis).toBeCloseTo(400, 6);
    expect(after.row.gainAvoided).toBeCloseTo(600, 6);
    expect(after.year.gainAvoidedRowsLeftOut).toBe(0);
    expect(after.year.gainAvoided).toBeCloseTo(600, 6);
    expect(after.row.longTermQuantity).toBe(10);
  });

  it("is idempotent: a second run plans nothing, writes nothing and does not bump the generation", () => {
    const { lotTxn } = seedDefect();
    applyDonatedLotBasisRepair(db, planDonatedLotBasisRepair(db, config(lotTxn)), "2026-10-07");
    const after = everything();
    const again = planDonatedLotBasisRepair(db, config(lotTxn));
    expect(again.ok).toBe(true);
    expect(again.lots[0].status).toBe("already-repaired");
    expect(applyDonatedLotBasisRepair(db, again, "2026-10-08")).toEqual({ updated: 0 });
    expect(everything()).toBe(after);
  });

  it("keeps a negative (cash-out) amount negative", () => {
    const sec = security("ZZAA");
    const lotTxn = txn(sec, "2011-02-03", "BUY", 100, 0.01, { amount: -1 });
    giftFrom(sec, lotTxn, "2025-06-16", 10);
    applyDonatedLotBasisRepair(db, planDonatedLotBasisRepair(db, config(lotTxn)), "2026-10-07");
    expect(row(lotTxn).amount).toBe(-4000);
    computeTaxLots(db);
    const lot = db.prepare("SELECT cost_basis FROM tax_lots WHERE acquisition_transaction_id = ?").get(lotTxn);
    expect(lot).toEqual({ cost_basis: 4000 });
  });

  it("a basis-only correction leaves the date alone", () => {
    const { lotTxn } = seedDefect();
    const plan = planDonatedLotBasisRepair(db, config(lotTxn, { acquisitionDate: "2011-02-03" }));
    expect(plan.lots[0]).toMatchObject({ status: "repair", dateChanges: false, basisChanges: true });
    applyDonatedLotBasisRepair(db, plan, "2026-10-07");
    expect(row(lotTxn).trade_date).toBe("2011-02-03");
    expect(row(lotTxn).amount).toBe(4000);
  });

  it("rewrites a canonical-file source key to the corrected row's key, and keeps any other key", () => {
    const sec = security("ZZAA");
    const canonical = txn(sec, "2011-02-03", "TRANSFER_IN", 100, 0.01, {
      sourceKey: `canonical:txn:${ACCOUNT}:ZZAA:2011-02-03:TRANSFER_IN:100`,
    });
    giftFrom(sec, canonical, "2025-06-16", 10);
    const plan = planDonatedLotBasisRepair(db, config(canonical));
    expect(plan.lots[0].sourceKeyChanges).toBe(true);
    applyDonatedLotBasisRepair(db, plan, "2026-10-07");
    expect(row(canonical).source_key).toBe(`canonical:txn:${ACCOUNT}:ZZAA:2021-04-07:TRANSFER_IN:400000`);

    const sec2 = security("ZZBB");
    const other = txn(sec2, "2011-02-03", "TRANSFER_IN", 100, 0.01, { sourceKey: "statement:abc" });
    giftFrom(sec2, other, "2025-06-16", 10);
    const plan2 = planDonatedLotBasisRepair(db, config(other, { symbol: "ZZBB" }));
    expect(plan2.lots[0].sourceKeyChanges).toBe(false);
    applyDonatedLotBasisRepair(db, plan2, "2026-10-07");
    expect(row(other).source_key).toBe("statement:abc");
  });

  it("refuses when the corrected canonical key already belongs to another row", () => {
    const sec = security("ZZAA");
    const canonical = txn(sec, "2011-02-03", "TRANSFER_IN", 100, 0.01, {
      sourceKey: `canonical:txn:${ACCOUNT}:ZZAA:2011-02-03:TRANSFER_IN:100`,
    });
    txn(sec, "2021-04-07", "TRANSFER_IN", 100, 40, {
      sourceKey: `canonical:txn:${ACCOUNT}:ZZAA:2021-04-07:TRANSFER_IN:400000`,
    });
    giftFrom(sec, canonical, "2025-06-16", 10);
    const plan = planDonatedLotBasisRepair(db, config(canonical));
    expect(plan.ok).toBe(false);
    expect(plan.lots[0].reason).toMatch(/already exists/);
  });

  it("rolls back every row when one update fails", () => {
    const secA = security("ZZAA");
    const secB = security("ZZBB");
    const a = txn(secA, "2011-02-03", "TRANSFER_IN", 100, 0.01);
    const b = txn(secB, "2011-02-03", "TRANSFER_IN", 100, 0.01);
    giftFrom(secA, a, "2025-06-16", 10);
    giftFrom(secB, b, "2025-06-16", 10);
    const cfg = config(a);
    cfg.lots.push({ ...cfg.lots[0], symbol: "ZZBB", acquisitionTransactionId: b });
    const plan = planDonatedLotBasisRepair(db, cfg);
    expect(plan.ok).toBe(true);
    db.exec(
      `CREATE TRIGGER repair_boom BEFORE UPDATE ON transactions WHEN NEW.id = ${b}
       BEGIN SELECT RAISE(ABORT, 'write boom'); END`
    );
    const before = everything();
    expect(() => applyDonatedLotBasisRepair(db, plan, "2026-10-07")).toThrow(/write boom/);
    expect(everything()).toBe(before);
  });

  it("refuses to apply a plan made before the row changed underneath it", () => {
    const { lotTxn } = seedDefect();
    const plan = planDonatedLotBasisRepair(db, config(lotTxn));
    db.prepare("UPDATE transactions SET trade_date = '2012-01-01' WHERE id = ?").run(lotTxn);
    const before = everything();
    expect(() => applyDonatedLotBasisRepair(db, plan, "2026-10-07")).toThrow(/changed since/);
    expect(everything()).toBe(before);
  });
});
