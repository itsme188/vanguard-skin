import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeExposureDelta } from "@/lib/compute/exposure-delta";
import { todayET } from "@/lib/calendar/date-utils";

// Review round 2 (2026-11-15), What-if legs:
//  - a security with multiplier 0 made the leg's quantity infinite and the
//    after total NaN: such a leg is dropped as "invalid_amount".
//  - selling exactly a position's value gave a false "capped" notice when
//    float rounding put the quantity a hair under zero: a sell within a
//    small relative tolerance of the whole position closes it, no notice.
// Synthetic symbols and round figures only.

let db: Database.Database;
const today = todayET();

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  const sec = db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector, currency, multiplier) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const price = db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`);
  const hold = db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, ?, ?, ?, ?)`
  );
  // 7 shares at 0.3: 7 × 0.3 / 0.3 is a hair over 7 in floating point.
  sec.run(1, "ZZA", "Stock", "Technology", "USD", null);
  price.run(1, today, 0.3);
  hold.run(1, today, 7, "t-zza");
  sec.run(2, "ZZB", "Stock", "Industrials", "USD", null);
  price.run(2, today, 50);
  hold.run(2, today, 100, "t-zzb");
  // An option with multiplier 0, held and not held.
  sec.run(3, "ZZA   270115C00050000", "Option", "Technology", "USD", 0);
  price.run(3, today, 2);
  hold.run(3, today, 1, "t-opt0");
  sec.run(4, "ZZB   270115C00050000", "Option", "Industrials", "USD", 0);
  price.run(4, today, 2);
});

const finite = (d: ReturnType<typeof computeExposureDelta>) =>
  [d.after.totalValue, d.after.beta, ...Object.values(d.after.sectorWeights)].every(Number.isFinite);

describe("multiplier 0", () => {
  it("a buy of a not-held multiplier-0 option is dropped as invalid_amount, and the after table stays finite", () => {
    const d = computeExposureDelta(db, "all", undefined, [{ symbol: "ZZB   270115C00050000", action: "buy", dollarAmount: 1000 }]);
    expect(d.droppedLegs).toEqual([{ symbol: "ZZB   270115C00050000", reason: "invalid_amount" }]);
    expect(finite(d)).toBe(true);
    expect(d.after.totalValue).toBeCloseTo(d.before.totalValue, 9);
  });

  it("a buy of a held multiplier-0 option is dropped the same way", () => {
    const d = computeExposureDelta(db, "all", undefined, [{ symbol: "ZZA   270115C00050000", action: "buy", dollarAmount: 1000 }]);
    expect(d.droppedLegs).toEqual([{ symbol: "ZZA   270115C00050000", reason: "invalid_amount" }]);
    expect(finite(d)).toBe(true);
  });
});

describe("selling exactly a position's value", () => {
  it("closes it with no capped notice, even when float rounding overshoots", () => {
    const d = computeExposureDelta(db, "all", undefined, [{ symbol: "ZZA", action: "sell", dollarAmount: 7 * 0.3 }]);
    expect(d.droppedLegs).toEqual([]);
    expect(d.before.totalValue - d.after.totalValue).toBeCloseTo(7 * 0.3, 9);
    expect(d.after.topConcentrations.some((c) => c.symbol === "ZZA" && c.weightPct !== 0)).toBe(false);
  });

  it("a sell clearly past the position is still capped and said so", () => {
    const d = computeExposureDelta(db, "all", undefined, [{ symbol: "ZZB", action: "sell", dollarAmount: 5001 }]);
    expect(d.droppedLegs).toMatchObject([{ symbol: "ZZB", reason: "clamped_sell", requestedDollars: 5001 }]);
    expect(d.droppedLegs[0].appliedDollars).toBeCloseTo(5000, 9);
  });
});
