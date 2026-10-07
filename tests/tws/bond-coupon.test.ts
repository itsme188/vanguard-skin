import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/tws/client", () => ({ getIbApi: vi.fn() }));
vi.mock("@/lib/tws/rate-limiter", () => ({
  RateLimiter: class {
    async waitForSlot() {}
  },
}));

import { getIbApi } from "@/lib/tws/client";
import { enrichSecurities } from "@/lib/tws/contracts";
import { assessBrokerCoupon, storeBrokerCoupon } from "@/lib/tws/bond-coupon";

const mockedGetIbApi = vi.mocked(getIbApi);

/** Synthetic figures only. */
describe("assessBrokerCoupon: the unit is an annual percent, and a doubtful figure is not stored", () => {
  it("stores a plain percent figure", () => {
    expect(assessBrokerCoupon(4.375, "ZZ Corp note")).toEqual({ store: true, couponRatePct: 4.375 });
    expect(assessBrokerCoupon(25, null)).toEqual({ store: true, couponRatePct: 25 });
  });

  it("refuses a missing, non-finite, negative or over-25 figure", () => {
    for (const raw of [undefined, null, "4.375", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(assessBrokerCoupon(raw, "ZZ Corp note")).toEqual({ store: false, reason: "absent" });
    }
    expect(assessBrokerCoupon(-1, "ZZ Corp note")).toEqual({ store: false, reason: "out-of-range" });
    expect(assessBrokerCoupon(25.01, "ZZ Corp note")).toEqual({ store: false, reason: "out-of-range" });
    expect(assessBrokerCoupon(437.5, "ZZ Corp note")).toEqual({ store: false, reason: "out-of-range" });
  });

  it("refuses a figure that is the name's coupon divided by 100 (a fraction, not a percent)", () => {
    expect(assessBrokerCoupon(0.04, "ZZ NOTE CPN 4.000% DUE 01/15/40")).toEqual({ store: false, reason: "unit-mismatch-with-name" });
  });

  it("refuses 0.25 or less when the name cannot confirm it: it could be a fraction", () => {
    expect(assessBrokerCoupon(0.04, "ZZ Corp note")).toEqual({ store: false, reason: "unit-ambiguous" });
    expect(assessBrokerCoupon(0.25, "ZZ Corp note")).toEqual({ store: false, reason: "unit-ambiguous" });
    // ...and stores it when the name states the same figure.
    expect(assessBrokerCoupon(0.125, "ZZ NOTE CPN 0.125% DUE 01/15/40")).toEqual({ store: true, couponRatePct: 0.125 });
  });

  it("stores a zero only when the name says bill or states a zero coupon", () => {
    expect(assessBrokerCoupon(0, "ZZ Corp note")).toEqual({ store: false, reason: "zero-unconfirmed" });
    expect(assessBrokerCoupon(0, null)).toEqual({ store: false, reason: "zero-unconfirmed" });
    expect(assessBrokerCoupon(0, "ZZ TREASURY BILL DUE 04/14/30")).toEqual({ store: true, couponRatePct: 0 });
    expect(assessBrokerCoupon(0, "ZZ STRIP CPN 0.00000  MTD 2040-01-13")).toEqual({ store: true, couponRatePct: 0 });
    // A zero from the broker against a positive coupon in the name is "not provided", never a zero coupon.
    expect(assessBrokerCoupon(0, "ZZ NOTE CPN 4.000% DUE 01/15/40")).toEqual({ store: false, reason: "zero-unconfirmed" });
  });

  it("the broker wins over a different coupon in the name (broker first)", () => {
    expect(assessBrokerCoupon(4.5, "ZZ NOTE CPN 4.000% DUE 01/15/40")).toEqual({ store: true, couponRatePct: 4.5 });
  });
});

describe("storeBrokerCoupon + enrichSecurities", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    vi.clearAllMocks();
  });

  function seed(symbol: string, type: string, name: string | null, coupon: number | null = null): number {
    return db
      .prepare("INSERT INTO securities (symbol, name, security_type, coupon_rate) VALUES (?, ?, ?, ?)")
      .run(symbol, name, type, coupon).lastInsertRowid as number;
  }
  const couponOf = (id: number) =>
    (db.prepare("SELECT coupon_rate FROM securities WHERE id = ?").get(id) as { coupon_rate: number | null }).coupon_rate;
  function mockDetails(detail: Record<string, unknown>) {
    const api = { getContractDetails: vi.fn().mockResolvedValue([{ contract: { conId: 900001 }, ...detail }]) };
    mockedGetIbApi.mockReturnValue(api as unknown as ReturnType<typeof getIbApi>);
    return api;
  }

  it("fills an empty coupon on a bond row and nothing else", () => {
    const bond = seed("ZZBOND1", "Bond", "ZZ Corp note");
    const stock = seed("ZZA", "Stock", "ZZ A Corp");
    expect(storeBrokerCoupon(db, bond, 4.375)).toBe(true);
    expect(couponOf(bond)).toBe(4.375);
    expect(storeBrokerCoupon(db, stock, 4.375)).toBe(false);
    expect(couponOf(stock)).toBeNull();
  });

  it("never replaces a coupon that is already stored", () => {
    const bond = seed("ZZBOND1", "bond", "ZZ Corp note", 3);
    expect(storeBrokerCoupon(db, bond, 4.375)).toBe(false);
    expect(couponOf(bond)).toBe(3);
  });

  it("refuses an out-of-range or non-finite figure at the write itself", () => {
    const bond = seed("ZZBOND1", "Bond", "ZZ Corp note");
    for (const bad of [Number.NaN, -0.5, 25.5, Number.POSITIVE_INFINITY]) expect(storeBrokerCoupon(db, bond, bad)).toBe(false);
    expect(couponOf(bond)).toBeNull();
  });

  it("enrichment stores the contract-details coupon for a bond, in percent", async () => {
    const bond = seed("ZZBOND1", "Bond", "ZZ Corp note");
    mockDetails({ coupon: 4.375 });
    const results = await enrichSecurities(db, [bond]);
    expect(results[0].enriched).toBe(true);
    expect(results[0].couponRatePct).toBe(4.375);
    expect(couponOf(bond)).toBe(4.375);
  });

  it("enrichment with no coupon in the details leaves a stored coupon alone (never null over a value)", async () => {
    const bond = seed("ZZBOND1", "Bond", "ZZ Corp note", 3);
    mockDetails({});
    const results = await enrichSecurities(db, [bond]);
    expect(results[0].enriched).toBe(true);
    expect(results[0].couponRatePct).toBeUndefined();
    expect(couponOf(bond)).toBe(3);
  });

  it("enrichment does not store a doubtful figure: zero on a coupon-bond name, a fraction, an over-range value", async () => {
    for (const [coupon, name] of [
      [0, "ZZ Corp note"],
      [0.04375, "ZZ Corp note"],
      [0.04, "ZZ NOTE CPN 4.000% DUE 01/15/40"],
      [437.5, "ZZ Corp note"],
    ] as const) {
      const bond = seed(`ZZBOND${coupon}${name.length}`, "Bond", name);
      mockDetails({ coupon });
      await enrichSecurities(db, [bond]);
      expect(couponOf(bond), `${coupon} / ${name}`).toBeNull();
    }
  });

  it("enrichment never writes a coupon onto a row that is not a bond", async () => {
    const stock = seed("ZZA", "Stock", "ZZ A Corp");
    mockDetails({ coupon: 4.375, industry: "Technology" });
    const results = await enrichSecurities(db, [stock]);
    expect(results[0].enriched).toBe(true);
    expect(couponOf(stock)).toBeNull();
  });

  it("a bill's zero coupon is stored when the name says bill", async () => {
    const bill = seed("ZZBILL1", "Bond", "ZZ TREASURY BILL DUE 04/14/30");
    mockDetails({ coupon: 0 });
    await enrichSecurities(db, [bill]);
    expect(couponOf(bill)).toBe(0);
  });
});
