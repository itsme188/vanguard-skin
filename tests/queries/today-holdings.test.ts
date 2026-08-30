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

  // Regression pin for qa:today-ibkr-holdings--option-move-books-earnings-gap-as-today.
  // An option's stored pair-date close can be a stale pre-move intraday quote
  // stamped on the same date as the underlying's true (post-move) close — the
  // dates are consecutive, so the trading-day pair can't catch it. The tell is
  // an arbitrage violation: a put trading far below (strike − underlying close)
  // on the SAME date. Differencing against such a row books the underlying's
  // whole gap as "today", so the move must be suppressed (null), never shown.
  function seedOption(
    symbol: string,
    underlying: string,
    optionType: "PUT" | "CALL",
    strike: number,
  ): number {
    return db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, asset_class, underlying_symbol, option_type, strike_price, multiplier, currency)
         VALUES (?, ?, 'Option', 'option', ?, ?, ?, 100, 'USD')`,
      )
      .run(symbol, `${symbol} opt`, underlying, optionType, strike).lastInsertRowid as number;
  }

  it("suppresses an option's move when its prior stored close violates intrinsic vs the underlying's same-date close", () => {
    const acct = ibkrAccountId();
    const spy = seedSecurity("SPY", "ETF");
    const app = seedSecurity("APP");
    const put = seedOption("APP   260814P00390000", "APP", "PUT", 390);
    hold(acct, spy, 1);
    hold(acct, app, 15);
    hold(acct, put, 1);

    price(spy, "2026-08-05", 630);
    price(spy, "2026-08-06", 631);
    // Underlying: post-earnings closes on both pair dates
    price(app, "2026-08-05", 350.0);
    price(app, "2026-08-06", 351.51);
    // Put: 8/05 row is a stale PRE-earnings intraday quote — $15.75 is far
    // below intrinsic ($390 − $350 = $40) at the same date's underlying close.
    price(put, "2026-08-05", 15.75);
    price(put, "2026-08-06", 48.52);

    const rows = getIbkrTodayHoldings(db, acct);
    const p = rows.find((r) => r.symbol.includes("P00390000"))!;
    // The +208% phantom must not render as "today's move"
    expect(p.today_gain).toBeNull();
    expect(p.today_pct).toBeNull();
    // Position value still shows from the freshest row
    expect(p.current_value).toBeCloseTo(48.52 * 100, 2);
    // Underlying row unaffected
    const a = rows.find((r) => r.symbol === "APP")!;
    expect(a.today_pct).toBeCloseTo((351.51 - 350.0) / 350.0, 6);
  });

  it("keeps a legitimate option premium multi-bagger (no intrinsic violation)", () => {
    const acct = ibkrAccountId();
    const spy = seedSecurity("SPY", "ETF");
    const hood = seedSecurity("HOOD");
    const call = seedOption("HOOD  261218C00110000", "HOOD", "CALL", 110);
    hold(acct, spy, 1);
    hold(acct, hood, 10);
    hold(acct, call, 2);

    price(spy, "2026-08-05", 630);
    price(spy, "2026-08-06", 631);
    price(hood, "2026-08-05", 100);
    price(hood, "2026-08-06", 106);
    // OTM call triples on the underlying pop — intrinsic is 0 both days, no
    // violation. Options legitimately double/halve; magnitude is never a gate.
    price(call, "2026-08-05", 2.0);
    price(call, "2026-08-06", 6.0);

    const rows = getIbkrTodayHoldings(db, acct);
    const c = rows.find((r) => r.symbol.includes("C00110000"))!;
    expect(c.today_pct).toBeCloseTo(2.0, 6); // +200%
    expect(c.today_gain).toBeCloseTo((6.0 - 2.0) * 100 * 2, 4);
  });

  it("keeps an ITM option move whose stored closes respect intrinsic", () => {
    const acct = ibkrAccountId();
    const spy = seedSecurity("SPY", "ETF");
    const xyz = seedSecurity("XYZ");
    const put = seedOption("XYZ   261218P00390000", "XYZ", "PUT", 390);
    hold(acct, spy, 1);
    hold(acct, xyz, 5);
    hold(acct, put, 1);

    price(spy, "2026-08-05", 630);
    price(spy, "2026-08-06", 631);
    price(xyz, "2026-08-05", 350);
    price(xyz, "2026-08-06", 351.51);
    // Consistent quotes: at/above intrinsic on both dates
    price(put, "2026-08-05", 42.0);
    price(put, "2026-08-06", 40.5);

    const rows = getIbkrTodayHoldings(db, acct);
    const p = rows.find((r) => r.symbol.includes("P00390000"))!;
    expect(p.today_pct).toBeCloseTo((40.5 - 42.0) / 42.0, 6);
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

  // holdings-latest-sweep Task 3: per-(account, security) latest holdings,
  // not a per-account global MAX(as_of_date). A statement-only position
  // (Treasuries, mutual funds) that only restates monthly must survive a
  // same-account sync that writes a newer row for a different security.
  it("keeps a statement-lag security whose only row predates another security's newer row", () => {
    const acct = ibkrAccountId();
    const lag = seedSecurity("TLAG");
    const fresh = seedSecurity("FRESH");
    hold(acct, lag, 10, "2025-01-31"); // only row, older date
    hold(acct, fresh, 5, "2025-02-28"); // newer sync row, same account

    const rows = getIbkrTodayHoldings(db, acct);
    expect(rows.map((r) => r.symbol).sort()).toEqual(["FRESH", "TLAG"]);
  });

  // Reconciler contract: the quantity=0 tombstone IS the latest row for the
  // (account, security) pair, so per-pair latest still hides the closed
  // position rather than resurrecting the older non-zero row.
  it("hides a security whose newest row is a quantity=0 tombstone above a non-zero older row", () => {
    const acct = ibkrAccountId();
    const closed = seedSecurity("GONE");
    hold(acct, closed, 10, "2025-01-31"); // was held
    hold(acct, closed, 0, "2025-02-28"); // closure marker

    const rows = getIbkrTodayHoldings(db, acct);
    expect(rows.find((r) => r.symbol === "GONE")).toBeUndefined();
  });
});
