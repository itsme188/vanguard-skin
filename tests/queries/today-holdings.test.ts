import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getIbkrTodayHoldings } from "@/lib/queries/today-holdings";

// Regression pin for qa:today-ibkr-holdings--todays-move-all-zero-nontrading-price-pair.
// The Today IBKR block paired rn=1 vs rn=2 price rows with no trading-day
// guard, so identical weekend/Monday-before-open phantom rows (written by
// quote enrichment, which lacked fetchSnapshotPrices' isMarketClosed guard)
// rendered every position as exactly $0 / 0.00%. The move must come from the
// anomaly-engine convention: one consecutive trading-day pair resolved from
// SPY (resolveTradingDayPair), phantom rows ignored.

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

function ibkrAccountId(): number {
  return (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;
}

function seedSecurity(symbol: string, type = "Stock"): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, asset_class) VALUES (?, ?, ?, 'equity')",
    )
    .run(symbol, `${symbol} Corp`, type).lastInsertRowid as number;
}

function hold(accountId: number, securityId: number, qty: number, asOf = "2026-08-03"): void {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, ?, ?)",
  ).run(accountId, securityId, qty, asOf);
}

function price(securityId: number, date: string, close: number): void {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'tws')",
  ).run(securityId, date, close);
}

describe("getIbkrTodayHoldings", () => {
  it("ignores identical non-trading-day phantom rows and computes the move on the trading-day pair", () => {
    const acct = ibkrAccountId();
    const goog = seedSecurity("GOOG");
    const spy = seedSecurity("SPY", "ETF");
    hold(acct, goog, 10);
    hold(acct, spy, 5);

    // 2026-07-31 = Friday (real session close), 2026-08-01 Sat, 2026-08-02 Sun
    // (phantom), 2026-08-03 Mon-before-open (phantom carrying Friday's true
    // close). rn=1 vs rn=2 pairing reads 8/03 vs 8/02 → identical → 0.00%.
    for (const [sid, friClose, weekendLast] of [
      [goog, 346.6, 354.25],
      [spy, 630.0, 633.8],
    ] as const) {
      price(sid, "2026-07-30", friClose - 1);
      price(sid, "2026-07-31", friClose);
      price(sid, "2026-08-02", weekendLast); // Sunday phantom
      price(sid, "2026-08-03", weekendLast); // Monday-before-open phantom
    }

    const rows = getIbkrTodayHoldings(db, acct);
    const g = rows.find((r) => r.symbol === "GOOG")!;

    // Pair resolves to (2026-08-03, 2026-07-31) — the Sunday phantom is
    // dropped, so the move is real, never 0.00% from two identical rows.
    expect(g.today_pct).toBeCloseTo((354.25 - 346.6) / 346.6, 6);
    expect(g.today_gain).toBeCloseTo((354.25 - 346.6) * 10, 4);
    // Current price/value still use the freshest known row.
    expect(g.current_price).toBeCloseTo(354.25, 2);
    expect(g.prior_close).toBeCloseTo(346.6, 2);
  });

  it("returns null move (not 0) when no trading-day pair can be resolved", () => {
    const acct = ibkrAccountId();
    const goog = seedSecurity("GOOG");
    hold(acct, goog, 10);
    // Only one price row and no SPY at all — no pair.
    price(goog, "2026-07-31", 346.6);

    const rows = getIbkrTodayHoldings(db, acct);
    const g = rows.find((r) => r.symbol === "GOOG")!;
    expect(g.today_gain).toBeNull();
    expect(g.today_pct).toBeNull();
    expect(g.current_price).toBeCloseTo(346.6, 2);
  });

  it("keeps normal consecutive-weekday behavior unchanged", () => {
    const acct = ibkrAccountId();
    const aapl = seedSecurity("AAPL");
    const spy = seedSecurity("SPY", "ETF");
    hold(acct, aapl, 4, "2026-07-30");
    hold(acct, spy, 1, "2026-07-30");
    for (const [sid, a, b] of [
      [aapl, 210, 214.2],
      [spy, 628, 630],
    ] as const) {
      price(sid, "2026-07-29", a);
      price(sid, "2026-07-30", b);
    }

    const rows = getIbkrTodayHoldings(db, acct);
    const a = rows.find((r) => r.symbol === "AAPL")!;
    expect(a.today_pct).toBeCloseTo((214.2 - 210) / 210, 6);
    expect(a.today_gain).toBeCloseTo(4 * (214.2 - 210), 4);
  });

  it("omits the move for a security missing a close on either pair date", () => {
    const acct = ibkrAccountId();
    const spy = seedSecurity("SPY", "ETF");
    const newpos = seedSecurity("NEWPOS");
    hold(acct, spy, 1, "2026-07-30");
    hold(acct, newpos, 3, "2026-07-30");
    price(spy, "2026-07-29", 628);
    price(spy, "2026-07-30", 630);
    price(newpos, "2026-07-30", 50); // no 7/29 close — bought today

    const rows = getIbkrTodayHoldings(db, acct);
    const n = rows.find((r) => r.symbol === "NEWPOS")!;
    expect(n.today_gain).toBeNull();
    expect(n.today_pct).toBeNull();
    expect(n.current_price).toBeCloseTo(50, 2);
  });
});
