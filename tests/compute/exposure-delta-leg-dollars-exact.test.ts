import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeExposureDelta } from "@/lib/compute/exposure-delta";
import { todayET } from "@/lib/calendar/date-utils";

// Analysis tab fix wave 2026-11-15, unit A.
// A1: a leg's dollar amount must move holdings value by exactly that many USD
//     for EVERY security type. A bond leg was applied at 1/100 of its amount
//     (shares were sized as dollars / price, then marketValue() divided the
//     bond by 100 for its per-100-face quote).
// A2: the true before weight of every symbol in the after top list.
// A3: a blank sector is "Unknown"; "Diversified" never trips the sector cap.
// Synthetic symbols and round figures only.

function seed(db: Database.Database, today: string) {
  const sec = db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector, currency, multiplier) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const price = db.prepare(
    `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`,
  );
  const hold = db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, ?, ?, ?, ?)`,
  );
  // Held stock: 100 sh @ 50 = 5,000
  sec.run(1, "ZZA", "Stock", "Technology", "USD", null);
  price.run(1, today, 50);
  hold.run(1, today, 100, "t-zza");
  // Held bond: 10,000 face @ 98 = 9,800
  sec.run(2, "ZZBOND1", "Bond", "Fixed Income", "USD", null);
  price.run(2, today, 98);
  hold.run(2, today, 10_000, "t-bond");
  // Held option: 2 contracts @ 5 × 100 = 1,000
  sec.run(3, "ZZA   270115C00050000", "Option", "Technology", "USD", 100);
  price.run(3, today, 5);
  hold.run(3, today, 2, "t-opt");
  // Held non-USD stock: 100 sh @ 1,000 EUR-ish at 0.5 USD = 50,000
  sec.run(4, "ZZFX", "Stock", "Industrials", "ZZC", null);
  price.run(4, today, 1_000);
  hold.run(4, today, 100, "t-fx");
  db.prepare(
    `INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('ZZC', 0.5, ?, 'test')`,
  ).run(today);
  // NOT held: a bond, an option, a non-USD stock, for the synthetic-leg path.
  sec.run(5, "ZZBOND2", "Bond", "Fixed Income", "USD", null);
  price.run(5, today, 99.5);
  sec.run(6, "ZZB   270115P00040000", "Option", "Technology", "USD", 100);
  price.run(6, today, 2.5);
  sec.run(7, "ZZFX2", "Stock", "Industrials", "ZZC", null);
  price.run(7, today, 400);
  sec.run(8, "ZZN", "Stock", "Healthcare", "USD", null);
  price.run(8, today, 25);
}

describe("What-if leg dollars (A1)", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seed(db, todayET());
  });

  const AMOUNT = 1_000;
  const cases: Array<[string, string]> = [
    ["held stock", "ZZA"],
    ["held bond", "ZZBOND1"],
    ["held option (multiplier 100)", "ZZA 270115C00050000"],
    ["held non-USD stock", "ZZFX"],
  ];
  for (const [label, symbol] of cases) {
    it(`a buy of a ${label} moves holdings value by exactly the leg amount`, () => {
      const r = computeExposureDelta(db, "all", undefined, [{ symbol, action: "buy", dollarAmount: AMOUNT }]);
      expect(r.droppedLegs).toEqual([]);
      expect(r.after.totalValue - r.before.totalValue).toBeCloseTo(AMOUNT, 6);
    });
    it(`a sell of a ${label} moves holdings value by exactly minus the leg amount`, () => {
      const r = computeExposureDelta(db, "all", undefined, [{ symbol, action: "sell", dollarAmount: AMOUNT }]);
      expect(r.droppedLegs).toEqual([]);
      expect(r.after.totalValue - r.before.totalValue).toBeCloseTo(-AMOUNT, 6);
    });
  }

  for (const [label, symbol] of [
    ["bond", "ZZBOND2"],
    ["option (multiplier 100)", "ZZB 270115P00040000"],
    ["non-USD stock", "ZZFX2"],
    ["stock", "ZZN"],
  ] as const) {
    it(`a buy of a NOT-held ${label} adds exactly the leg amount`, () => {
      const r = computeExposureDelta(db, "all", undefined, [{ symbol, action: "buy", dollarAmount: AMOUNT }]);
      expect(r.droppedLegs).toEqual([]);
      expect(r.after.totalValue - r.before.totalValue).toBeCloseTo(AMOUNT, 6);
    });
  }

  it("a sell larger than a held bond clamps at the bond's full value", () => {
    const r = computeExposureDelta(db, "all", undefined, [
      { symbol: "ZZBOND1", action: "sell", dollarAmount: 50_000 },
    ]);
    expect(r.droppedLegs).toEqual([
      { symbol: "ZZBOND1", reason: "clamped_sell", requestedDollars: 50_000, appliedDollars: 9_800 },
    ]);
    expect(r.after.totalValue - r.before.totalValue).toBeCloseTo(-9_800, 6);
    expect(r.after.topConcentrations.find((c) => c.symbol === "ZZBOND1")).toBeUndefined();
  });

  it("a sell smaller than a held bond does NOT clamp", () => {
    const r = computeExposureDelta(db, "all", undefined, [
      { symbol: "ZZBOND1", action: "sell", dollarAmount: 9_000 },
    ]);
    expect(r.droppedLegs).toEqual([]);
    expect(r.after.totalValue - r.before.totalValue).toBeCloseTo(-9_000, 6);
  });
});

describe("What-if before weight of every after-top symbol (A2)", () => {
  it("returns the true before weight for a name outside the before top 10", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const today = todayET();
    // Eleven names at 1,000 each, and one small name at 100 (12th, outside top 10).
    for (let i = 1; i <= 12; i++) {
      db.prepare(
        `INSERT INTO securities (id, symbol, security_type, sector) VALUES (?, ?, 'Stock', 'Technology')`,
      ).run(i, `ZZ${String(i).padStart(2, "0")}`);
      db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 10, 'tws')`).run(i, today);
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, ?, ?, ?, ?)`,
      ).run(i, today, i === 12 ? 10 : 100, `k${i}`);
    }
    const r = computeExposureDelta(db, "all", undefined, [
      { symbol: "ZZ12", action: "buy", dollarAmount: 10_000 },
    ]);
    expect(r.before.topConcentrations.find((c) => c.symbol === "ZZ12")).toBeUndefined();
    expect(r.after.topConcentrations[0].symbol).toBe("ZZ12");
    // before total 11,100; ZZ12 was 100 of it.
    expect(r.beforeWeightBySymbol["ZZ12"]).toBeCloseTo(100 / 11_100, 9);
    for (const c of r.after.topConcentrations) {
      expect(r.beforeWeightBySymbol).toHaveProperty(c.symbol);
    }
  });

  it("a brand-new name has a before weight of exactly zero", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    seed(db, todayET());
    const r = computeExposureDelta(db, "all", undefined, [{ symbol: "ZZN", action: "buy", dollarAmount: 1_000 }]);
    expect(r.beforeWeightBySymbol["ZZN"]).toBe(0);
  });
});

describe("What-if sector buckets and the sector-cap flag (A3)", () => {
  function sectorDb(sectors: Array<string | null>) {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const today = todayET();
    sectors.forEach((sector, idx) => {
      const id = idx + 1;
      db.prepare(
        `INSERT INTO securities (id, symbol, security_type, sector) VALUES (?, ?, 'ETF', ?)`,
      ).run(id, `ZZS${id}`, sector);
      db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 10, 'tws')`).run(id, today);
      db.prepare(
        `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, ?, ?, 100, ?)`,
      ).run(id, today, `s${id}`);
    });
    return db;
  }

  it("folds a blank or whitespace sector into Unknown", () => {
    const db = sectorDb(["", "   ", null, "Technology"]);
    const r = computeExposureDelta(db, "all", undefined, []);
    expect(Object.keys(r.before.sectorWeights).sort()).toEqual(["Technology", "Unknown"]);
    expect(r.before.sectorWeights["Unknown"]).toBeCloseTo(0.75, 9);
  });

  it("never raises the sector-cap flag for Diversified (or a blank sector)", () => {
    const db = sectorDb(["Diversified", "Diversified", "Diversified", "", "Technology"]);
    const r = computeExposureDelta(db, "all", undefined, []);
    expect(r.before.sectorWeights["Diversified"]).toBeCloseTo(0.6, 9);
    expect(r.flags.filter((f) => f.metric.startsWith("sector:"))).toEqual([]);
  });

  it("still raises the sector-cap flag for a real sector over the cap", () => {
    const db = sectorDb(["Technology", "Technology", "Diversified"]);
    const r = computeExposureDelta(db, "all", undefined, []);
    expect(r.flags.map((f) => f.metric)).toContain("sector:Technology");
  });

  it("every flag that prints a weight carries it as weightPct, in the printed form (A4)", () => {
    const db = sectorDb(["Technology", "Technology", "Diversified"]);
    const r = computeExposureDelta(db, "all", undefined, []);
    const weighted = r.flags.filter((f) => f.metric !== "beta");
    expect(weighted.map((f) => f.metric).sort()).toEqual(["sector:Technology", "top1", "top3"]);
    for (const f of weighted) {
      expect(f.weightPct).toBeDefined();
      expect(f.message).toContain(`${(f.weightPct! * 100).toFixed(1)}%`);
    }
  });
});
