/**
 * Cash deploy leaves an expired option out (bug 9), as the What-if already
 * does (tests/compute/exposure-delta-expired-options.test.ts). The holdings
 * read goes through `liveOptionExpirationSql`, the one reader of a stored
 * option expiry.
 *
 * Synthetic symbols and round figures only. Vanguard scope = account 1,
 * benchmark VTI.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { todayET } from "@/lib/calendar/date-utils";
import { measureLongOnlyBook, suggestAllocation } from "@/lib/compute/cash-deploy";
import { computeExposureDelta } from "@/lib/compute/exposure-delta";

let db: Database.Database;
const today = todayET();

function seed() {
  db.prepare(`INSERT INTO securities (id, symbol, security_type, sector, currency) VALUES (1, 'ZZT', 'Stock', 'Technology', 'USD')`).run();
  db.prepare(`INSERT INTO securities (id, symbol, security_type, sector, currency) VALUES (2, 'ZZH', 'Stock', 'Healthcare', 'USD')`).run();
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, sector, currency, underlying_symbol, expiration_date, option_type, strike_price, multiplier)
     VALUES (3, 'ZZT   200117C00100000', 'Option', 'Technology', 'USD', 'ZZT', '2020-01-17', 'CALL', 100, 100)`,
  ).run();
  const price = db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')`);
  price.run(1, today, 100);
  price.run(2, today, 100);
  price.run(3, today, 5);
  const hold = db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, ?, ?, ?)`,
  );
  hold.run(1, today, 100, "ex-zzt"); // 10,000
  hold.run(2, today, 500, "ex-zzh"); // 50,000
  hold.run(3, today, 100, "ex-call"); // 100 x 5 x 100 = 50,000, expired
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("DELETE FROM watchlist").run();
  seed();
});

describe("bug 9: Cash deploy and an expired option", () => {
  it("leaves the expired call out of the total and the weights, matching the What-if", () => {
    const CASH = 1_000;
    const r = suggestAllocation(db, "vanguard", [1], CASH);
    const book = measureLongOnlyBook(db, "vanguard", [1], CASH);
    const wi = computeExposureDelta(db, "vanguard", [1], []);
    expect(wi.before.totalValue).toBeCloseTo(60_000, 6);
    expect(book.gapBasisTotal).toBeCloseTo(60_000 + CASH, 6);
    const tech = r.gaps.find((g) => g.sector === "Technology")!;
    const techDollars = tech.currentWeight * book.gapBasisTotal;
    expect(techDollars).toBeCloseTo(10_000, 6);
    expect(techDollars).toBeCloseTo(wi.before.sectorWeights.Technology * wi.before.totalValue, 6);
    expect(techDollars / (book.gapBasisTotal - CASH)).toBeCloseTo(wi.before.sectorWeights.Technology, 9);
    expect(r.optionsAtMarketValue).toBe(0);
  });
});
