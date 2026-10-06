import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computePositionRisk } from "@/lib/compute/risk";
import { computePortfolioGreeks } from "@/lib/compute/options-greeks";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import { buildOCCSymbol } from "@/lib/import/occ-symbol";

describe("compute functions over a two-account fixture", () => {
  let db: Database.Database;
  let today: string;
  let expiry: string;
  let occ: string;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    today = todayET();
    expiry = addDays(today, 180);
    occ = buildOCCSymbol("AAA", expiry, "CALL", 100);

    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (10, 'AAA', 'Stock')`).run();
    db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (11, 'BBB', 'Stock')`).run();
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
       VALUES (100, ?, 'Option', 'CALL', 100, ?, 'AAA', 100)`
    ).run(occ, expiry);
    for (const [id, px] of [[10, 50], [11, 100], [100, 6]] as const) {
      db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`).run(id, today, px);
    }
    // AAA held in accounts 1 and 2 (10 + 30 sh), BBB only in account 3 (20 sh).
    const h = db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (?, ?, ?, ?, ?)`
    );
    h.run(1, 10, today, 10, "a1");
    h.run(2, 10, today, 30, "a2");
    h.run(3, 11, today, 20, "a3");
    // Same call option held in accounts 1 and 2.
    h.run(1, 100, today, 1, "o1");
    h.run(2, 100, today, 2, "o2");
  });

  it("position-risk combines a security held in two accounts into one row over the combined book", () => {
    const r = computePositionRisk(db, { accountIds: [1, 2, 3], topN: 10 });
    const aaa = r.positions.filter((p) => p.symbol === "AAA");
    expect(aaa).toHaveLength(1);
    // AAA 40 sh * 50 = 2000; BBB 20 * 100 = 2000; option 3 * 100 * 6 = 1800.
    const total = 2000 + 2000 + 1800;
    expect(aaa[0].weight).toBeCloseTo(2000 / total, 6);
    // Narrowing to one account changes the book, so weights are over that book.
    const solo = computePositionRisk(db, { accountIds: [3], topN: 10 });
    expect(solo.positions.map((p) => p.symbol)).toEqual(["BBB"]);
    expect(solo.positions[0].weight).toBeCloseTo(1, 6);
  });

  it("greeks over [1,2] sums both accounts; single account equals the legacy accountId call", () => {
    const both = computePortfolioGreeks(db, { accountIds: [1, 2] });
    const a1 = computePortfolioGreeks(db, { accountId: 1 });
    const a1Set = computePortfolioGreeks(db, { accountIds: [1] });
    const a2 = computePortfolioGreeks(db, { accountId: 2 });
    expect(a1Set).toEqual(a1);
    expect(both.positions.length).toBe(2);
    expect(both.totalDelta).toBeCloseTo(a1.totalDelta + a2.totalDelta, 6);
    // account 2 holds twice account 1's contracts
    expect(a2.totalDelta).toBeCloseTo(2 * a1.totalDelta, 6);
    // account 3 holds no options: excluded from the set changes nothing
    const all = computePortfolioGreeks(db, { accountIds: [1, 2, 3] });
    expect(all.totalDelta).toBeCloseTo(both.totalDelta, 6);
  });
});
