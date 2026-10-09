/**
 * The Fixed Income card reads each bond's duration through the SAME rule the
 * scenario rate leg uses (`estimateBondRateLeg`, lib/compute/bond-duration.ts).
 *
 * Before: the card read only `securities.duration_years`. A coupon bond or a
 * Treasury bill with no stored duration showed a dash and was left out of the
 * weighted average, while a scenario on the same page moved that same bond by
 * a duration worked out from its maturity, coupon and price. Two figures for
 * one bond on one tab.
 *
 * Synthetic symbols and round figures only.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { computeFixedIncomeExposure } from "@/lib/compute/fixed-income-exposure";
import { estimateBondRateLeg } from "@/lib/compute/bond-duration";
import { describeBondDuration } from "@/app/dashboard/components/FixedIncomeCard";

const TODAY = "2030-01-15";
const ACCOUNT = 1; // seeded by the migrations

let db: Database.Database;

function seedBond(
  symbol: string,
  opts: {
    name: string;
    faceQty: number;
    price: number | null;
    maturity: string | null;
    duration?: number | null;
    coupon?: number | null;
    type?: string;
  },
): number {
  const id = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, currency, duration_years, coupon_rate, maturity_date)
       VALUES (?, ?, ?, 'USD', ?, ?, ?)`,
    )
    .run(symbol, opts.name, opts.type ?? "Bond", opts.duration ?? null, opts.coupon ?? null, opts.maturity)
    .lastInsertRowid as number;
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, ?, ?)`,
  ).run(ACCOUNT, id, opts.faceQty, "2030-01-14", `hold-${symbol}`);
  if (opts.price != null) {
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, ?, ?)").run(id, "2030-01-14", opts.price);
  }
  return id;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

describe("computeFixedIncomeExposure: durations come from the scenario rate-leg rule", () => {
  it("a two-year 4% note at par on a coupon date: the duration is worked by hand", () => {
    // Four flows are left, six months apart: 2, 2, 2 and 102 per 100 face.
    // At par on a coupon date there is no accrued interest and the yield
    // equals the coupon: 4% a year, 2% a half-year.
    //   present values: 2/1.02 = 1.960784, 2/1.02^2 = 1.922338,
    //                   2/1.02^3 = 1.884645, 102/1.02^4 = 94.232233  (sum 100)
    //   time-weighted:  1(1.960784) + 2(1.922338) + 3(1.884645) + 4(94.232233)
    //                   = 388.388325
    //   Macaulay  = 388.388325 / 100 = 3.883883 half-years = 1.941942 years
    //   modified  = 1.941942 / 1.02  = 1.903864 years
    const BY_HAND = 1.903864;
    seedBond("ZZN", { name: "ZZ TREASURY NOTE 4.000% DUE 01/15/32", faceQty: 10_000, price: 100, maturity: "2032-01-15" });

    const out = computeFixedIncomeExposure(db, null, TODAY);
    expect(out.bonds).toHaveLength(1);
    const note = out.bonds[0];
    expect(note.durationYears).toBeCloseTo(BY_HAND, 5);
    // No coupon is stored, so it was read from the bond's name.
    expect(note.durationSource).toBe("coupon-yield-name");
    expect(note.couponSource).toBe("name");
    expect(note.unmodelledReason).toBeNull();
    expect(note.marketValue).toBeCloseTo(10_000, 6);
    expect(out.weightedAvgDuration).toBeCloseTo(BY_HAND, 5);
    expect(out.unmeasuredBondCount).toBe(0);
    expect(out.asOfDate).toBe(TODAY);
  });

  it("every row agrees with the scenario rule, and the average is value-weighted over modelled bonds", () => {
    // Stored duration: used as stored.
    seedBond("ZZS", { name: "ZZ Corp note", faceQty: 20_000, price: 100, maturity: "2036-01-15", duration: 5 });
    // The hand-worked note: 1.903864 years on 10,000.
    seedBond("ZZN", { name: "ZZ TREASURY NOTE 4.000% DUE 01/15/32", faceQty: 10_000, price: 100, maturity: "2032-01-15" });
    // A bill 73 days out: 73 / 365 = 0.2 years. 30,000 face at 98 = 29,400.
    seedBond("ZZB", { name: "ZZ TREASURY BILL DUE 03/29/30", faceQty: 30_000, price: 98, maturity: "2030-03-29" });

    const out = computeFixedIncomeExposure(db, null, TODAY);
    const by = new Map(out.bonds.map((b) => [b.symbol, b]));

    expect(by.get("ZZS")!.durationYears).toBe(5);
    expect(by.get("ZZS")!.durationSource).toBe("stored");
    expect(by.get("ZZB")!.durationYears).toBeCloseTo(0.2, 10);
    expect(by.get("ZZB")!.durationSource).toBe("bill-maturity");
    expect(by.get("ZZN")!.durationYears).toBeCloseTo(1.903864, 5);

    // The card and the scenario engine call one function with the same inputs.
    for (const b of out.bonds) {
      const row = db
        .prepare(
          `SELECT s.security_type, s.name AS security_name, s.sector, s.fund_category, s.duration_years,
                  s.maturity_date, s.coupon_rate, p.close_price AS bond_price
           FROM securities s JOIN prices p ON p.security_id = s.id WHERE s.symbol = ?`,
        )
        .get(b.symbol) as Parameters<typeof estimateBondRateLeg>[0];
      expect(b.durationYears, b.symbol).toBe(estimateBondRateLeg(row, 100, TODAY)!.durationYears);
    }

    const expected = (5 * 20_000 + 1.903864 * 10_000 + 0.2 * 29_400) / (20_000 + 10_000 + 29_400);
    expect(out.weightedAvgDuration).toBeCloseTo(expected, 5);
    expect(out.measuredBondValue).toBeCloseTo(59_400, 6);
    expect(out.unmeasuredBondValue).toBeCloseTo(0, 6);
    expect(out.totalBondValue).toBeCloseTo(59_400, 6);
  });

  it("a bond that cannot be modelled is listed and counted, with its reason, and is given no figure", () => {
    seedBond("ZZS", { name: "ZZ Corp note", faceQty: 10_000, price: 100, maturity: "2036-01-15", duration: 9 });
    // No stored duration, no stored coupon, and a bare number in the name.
    seedBond("ZZU", { name: "ZZ TREASURY NOTE 4.625 02/15/35 02/15/25", faceQty: 30_000, price: 100, maturity: "2035-02-15" });
    // No maturity date at all.
    seedBond("ZZM", { name: "ZZ Corp perpetual", faceQty: 5_000, price: 100, maturity: null });

    const out = computeFixedIncomeExposure(db, null, TODAY);
    const by = new Map(out.bonds.map((b) => [b.symbol, b]));

    expect(out.bonds).toHaveLength(3);
    expect(by.get("ZZU")!.durationYears).toBeNull();
    expect(by.get("ZZU")!.durationSource).toBeNull();
    expect(by.get("ZZU")!.unmodelledReason).toBe("no-coupon");
    expect(by.get("ZZM")!.durationYears).toBeNull();
    expect(by.get("ZZM")!.unmodelledReason).toBe("no-maturity");

    // Unknown is not zero: the average is over the one modelled bond.
    expect(out.weightedAvgDuration).toBeCloseTo(9, 10);
    expect(out.unmeasuredBondCount).toBe(2);
    expect(out.unmeasuredBondValue).toBeCloseTo(35_000, 6);
    expect(out.measuredBondValue).toBeCloseTo(10_000, 6);
    expect(out.totalBondValue).toBeCloseTo(45_000, 6);
  });

  it("with no bond modelled the average is null, never zero", () => {
    seedBond("ZZU", { name: "ZZ Corp note", faceQty: 30_000, price: 100, maturity: "2035-02-15" });
    const out = computeFixedIncomeExposure(db, null, TODAY);
    expect(out.weightedAvgDuration).toBeNull();
    expect(out.unmeasuredBondCount).toBe(1);
  });

  it("a note linked to an index is not read as a fixed coupon, so it is not modelled", () => {
    seedBond("ZZC", { name: "ZZ BANK CPI LINKED NOTE 3.000% DUE 01/15/36", faceQty: 10_000, price: 100, maturity: "2036-01-15" });
    seedBond("ZZK", { name: "ZZ BANK CMS NOTE 6.000% DUE 01/15/36", faceQty: 10_000, price: 100, maturity: "2036-01-15" });
    const out = computeFixedIncomeExposure(db, null, TODAY);
    for (const b of out.bonds) {
      expect(b.durationYears, b.symbol).toBeNull();
      expect(b.unmodelledReason, b.symbol).toBe("no-coupon");
    }
    expect(out.weightedAvgDuration).toBeNull();
  });

  it("'today' is the caller's date: a bond maturing today stays, one that matured yesterday is gone", () => {
    seedBond("ZZT", { name: "ZZ TREASURY BILL DUE 01/15/30", faceQty: 10_000, price: 100, maturity: TODAY });
    seedBond("ZZY", { name: "ZZ TREASURY BILL DUE 01/14/30", faceQty: 10_000, price: 100, maturity: "2030-01-14" });
    const symbols = computeFixedIncomeExposure(db, null, TODAY).bonds.map((b) => b.symbol);
    expect(symbols).toEqual(["ZZT"]);
    // One day later the first one has matured too.
    expect(computeFixedIncomeExposure(db, null, "2030-01-16").bonds).toHaveLength(0);
  });

  it("respects the account scope", () => {
    seedBond("ZZS", { name: "ZZ Corp note", faceQty: 10_000, price: 100, maturity: "2036-01-15", duration: 4 });
    expect(computeFixedIncomeExposure(db, [ACCOUNT], TODAY).bonds).toHaveLength(1);
    expect(computeFixedIncomeExposure(db, [999_999], TODAY).bonds).toHaveLength(0);
  });
});

describe("describeBondDuration: the card says where each duration came from", () => {
  const base = { durationYears: 2 as number | null, durationSource: null, unmodelledReason: null };

  it("a stored duration carries no mark", () => {
    const d = describeBondDuration({ ...base, durationSource: "stored" });
    expect(d.derived).toBe(false);
    expect(d.note).toBeNull();
  });

  it("each derived source is marked and explained in plain words", () => {
    for (const source of ["bill-maturity", "single-flow", "coupon-yield", "coupon-yield-name"] as const) {
      const d = describeBondDuration({ ...base, durationSource: source });
      expect(d.derived, source).toBe(true);
      expect(d.note, source).toBeTruthy();
    }
    expect(describeBondDuration({ ...base, durationSource: "coupon-yield-name" }).note).toMatch(/name/);
    expect(describeBondDuration({ ...base, durationSource: "bill-maturity" }).note).toMatch(/maturity/);
  });

  it("a bond that is not modelled says why and shows no figure", () => {
    const d = describeBondDuration({ durationYears: null, durationSource: null, unmodelledReason: "no-coupon" });
    expect(d.modelled).toBe(false);
    expect(d.note).toMatch(/coupon/);
    const unknown = describeBondDuration({ durationYears: null, durationSource: null, unmodelledReason: null });
    expect(unknown.modelled).toBe(false);
    expect(unknown.note).toBeTruthy();
  });
});

describe("wiring (source pins)", () => {
  const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");

  it("the route is a thin wrapper over the lib function and passes the Eastern date", () => {
    const src = read("app/api/compute/fixed-income/route.ts");
    expect(src).toContain("computeFixedIncomeExposure(db, accountIds, todayET())");
    expect(src).not.toMatch(/date\('now'\)/);
    expect(src).not.toMatch(/\.prepare\(/);
  });

  it("the lib function reads durations through estimateBondRateLeg and never the UTC clock", () => {
    const src = read("lib/compute/fixed-income-exposure.ts");
    expect(src).toContain("estimateBondRateLeg(");
    expect(src).not.toMatch(/date\('now'\)/);
    expect(src).not.toMatch(/new Date\(/);
  });

  it("the card renders each row through describeBondDuration", () => {
    const src = read("app/dashboard/components/FixedIncomeCard.tsx");
    expect(src).toContain("describeBondDuration(bond)");
  });
});
