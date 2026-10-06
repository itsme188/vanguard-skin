/**
 * U22 — UTC "today" sweep, query/chat lane.
 *
 * Every case runs with the clock frozen at 2026-03-10T01:30:00Z, which is
 * 21:30 ET on 2026-03-09: the UTC calendar day has already rolled over, the
 * Eastern one has not. A `new Date().toISOString().slice(0, 10)` reads
 * "2026-03-10" here; `todayET()` reads "2026-03-09". Each assertion below
 * only holds for the Eastern reading.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getSourcePerformance } from "@/lib/queries/level-performance";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { computeIbkrTradingContext } from "@/lib/chat/ibkr-context";

const EVENING_ET = new Date("2026-03-10T01:30:00Z");

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(EVENING_ET);
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  vi.useRealTimers();
});

function seedSecurity(symbol: string): number {
  const r = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class, multiplier) VALUES (?, ?, 'stock', 'equity', 1)",
    )
    .run(symbol, `${symbol} Corp`);
  return r.lastInsertRowid as number;
}

describe("level-performance forward-return window (ET today)", () => {
  it("caps an unfinished window at the ET day, not the UTC day", () => {
    const sec = seedSecurity("TESTA");
    for (const id of [1, 2, 3]) {
      db.prepare(
        `INSERT INTO security_levels (id, security_id, level_type, price, source, source_author)
         VALUES (?, ?, 'support', 100, 'newsletter', 'Synthetic')`,
      ).run(id, sec);
      // 30 days out is 2026-03-31 — still in the future, so the window end
      // is "today".
      db.prepare(
        `INSERT INTO level_alerts (level_id, security_id, triggered_at, triggered_price, user_response)
         VALUES (?, ?, '2026-03-01T12:00:00Z', 100, 'acted')`,
      ).run(id, sec);
    }
    const price = db.prepare(
      "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')",
    );
    price.run(sec, "2026-03-09", 110);
    // A row dated the UTC "today" must sit outside the window.
    price.run(sec, "2026-03-10", 200);

    const rows = getSourcePerformance(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].pnl_acted_30d).toBeCloseTo(10, 6);
  });
});

describe("portfolio summary for chat (ET today)", () => {
  it("counts days to long-term status from the ET day", () => {
    const sec = seedSecurity("TESTB");
    // Long-term date = acquisition + 366 days = 2026-03-11: two days after
    // the ET day (one day after the UTC day).
    db.prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (1, ?, '2025-03-10', 50, 10, 10, 500)`,
    ).run(sec);

    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain("TESTB");
    expect(summary).toContain("2 days until long-term (2026-03-11)");
  });

  it("ages the latest price from the ET day (7 days is not yet stale)", () => {
    const sec = seedSecurity("TESTC");
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, '2026-03-02', 10)").run(sec);

    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain("Latest price date: 2026-03-02");
    expect(summary).not.toContain("days old");
  });

  it("still flags a price more than 7 ET days old", () => {
    const sec = seedSecurity("TESTC");
    db.prepare("INSERT INTO prices (security_id, date, close_price) VALUES (?, '2026-03-01', 10)").run(sec);

    expect(getPortfolioSummaryForChat(db)).toContain("Price data is 8 days old (latest: 2026-03-01)");
  });
});

describe("IBKR trading context 90-day window (ET today)", () => {
  it("starts the window 90 days before the ET day", () => {
    const IBKR_ACCOUNT_ID = 3; // seeded by migration 002_seed_accounts.sql
    const sec = seedSecurity("TESTD");
    // 2025-12-09 is exactly 90 days before 2026-03-09 (ET); a UTC anchor
    // starts the window on 2025-12-10 and drops all three.
    const insert = db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
       VALUES (?, ?, '2025-12-09', 'BUY', 1, 10, -10, ?)`,
    );
    for (const key of ["k1", "k2", "k3"]) insert.run(IBKR_ACCOUNT_ID, sec, key);

    const ctx = computeIbkrTradingContext(db, IBKR_ACCOUNT_ID, "IBKR");
    expect(ctx.repeatNames.map((r) => r.symbol)).toEqual(["TESTD"]);
  });
});
