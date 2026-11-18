import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getAnalysisTrustState } from "@/lib/queries/analysis-trust-state";
import { todayET } from "@/lib/calendar/date-utils";

/**
 * QA finding dashboard-analysis-scope-ibkr-and-all-trust-strip-stale-prices-drawer-
 * stale-prices-drawer-lists-the-expired-…: an expired contract is kept in the
 * holdings book by its statement row (the 2026-11-04 no-purge rule), but no
 * refresh can price it, so the Stale Prices drawer must not count it or list
 * it. Synthetic symbols and round figures only.
 */
function daysAgoET(days: number): string {
  const [y, m, d] = todayET().split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - days);
  return t.toISOString().slice(0, 10);
}

describe("trust strip: an expired option is not a stale price", () => {
  let db: Database.Database;
  const STOCK = 10;
  const EXPIRED = 11;
  const EXPIRED_COMPACT = 12;
  const LIVE = 13;
  const EXPIRED_UNPRICED = 14;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare(
      `INSERT INTO securities (id, symbol, security_type, underlying_symbol, expiration_date) VALUES
         (${STOCK}, 'AAA', 'Stock', NULL, NULL),
         (${EXPIRED}, 'AAA   200117C00100000', 'Option', 'AAA', '2020-01-17'),
         (${EXPIRED_COMPACT}, 'AAA   200221P00090000', 'Option', 'AAA', '20200221'),
         (${LIVE}, 'AAA   990115C00120000', 'Option', 'AAA', '2099-01-15'),
         (${EXPIRED_UNPRICED}, 'AAA   200320C00110000', 'Option', 'AAA', '2020-03-20')`,
    ).run();
    const h = db.prepare(
      `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (3, ?, '2026-06-01', 1, ?)`,
    );
    for (const id of [STOCK, EXPIRED, EXPIRED_COMPACT, LIVE, EXPIRED_UNPRICED]) h.run(id, `stmt-${id}`);
    const px = db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, 10, 'test')`);
    const stale = daysAgoET(7);
    for (const id of [STOCK, EXPIRED, EXPIRED_COMPACT, LIVE]) px.run(id, stale);
  });

  it("counts and lists only the stock and the live contract", () => {
    const state = getAnalysisTrustState(db, [3]);
    expect(state.stalePrices).toEqual({ count: 2, symbols: ["AAA", "AAA   990115C00120000"] });
  });

  it("leaves an expired contract out of the never-priced list too", () => {
    const state = getAnalysisTrustState(db, [3]);
    expect(state.neverPriced).toEqual({ count: 0, symbols: [] });
  });
});
