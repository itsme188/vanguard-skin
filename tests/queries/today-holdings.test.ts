import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import {
  getIbkrTodayHoldings,
  summarizeIbkrDayMove,
  type TodayHolding,
} from "@/lib/queries/today-holdings";

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
    // Held since before the pair's prior date (7/31): a row dated on the later
    // pair date with no earlier row would be a position opened that session.
    hold(acct, goog, 10, "2026-07-30");
    hold(acct, spy, 5, "2026-07-30");

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
    hold(acct, aapl, 4, "2026-07-29");
    hold(acct, spy, 1, "2026-07-29");
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
    expirationDate: string | null = null,
  ): number {
    return db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, asset_class, underlying_symbol, option_type, strike_price, multiplier, currency, expiration_date)
         VALUES (?, ?, 'Option', 'option', ?, ?, ?, 100, 'USD', ?)`,
      )
      .run(symbol, `${symbol} opt`, underlying, optionType, strike, expirationDate)
      .lastInsertRowid as number;
  }

  it("suppresses an option's move when its prior stored close violates intrinsic vs the underlying's same-date close", () => {
    const acct = ibkrAccountId();
    const spy = seedSecurity("SPY", "ETF");
    const app = seedSecurity("ZZP");
    const put = seedOption("ZZP   260814P00400000", "ZZP", "PUT", 400);
    hold(acct, spy, 1);
    hold(acct, app, 10);
    hold(acct, put, 1);

    price(spy, "2026-08-05", 630);
    price(spy, "2026-08-06", 631);
    // Underlying: post-earnings closes on both pair dates
    price(app, "2026-08-05", 350.0);
    price(app, "2026-08-06", 351);
    // Put: 8/05 row is a stale PRE-earnings intraday quote — $15 is far
    // below intrinsic ($400 − $350 = $50) at the same date's underlying close.
    price(put, "2026-08-05", 15);
    price(put, "2026-08-06", 50);

    const rows = getIbkrTodayHoldings(db, acct);
    const p = rows.find((r) => r.symbol.includes("P00400000"))!;
    // The +233% phantom ((50 − 15) / 15) must not render as "today's move"
    expect(p.today_gain).toBeNull();
    expect(p.today_pct).toBeNull();
    // Position value still shows from the freshest row
    expect(p.current_value).toBeCloseTo(50 * 100, 2);
    // Underlying row unaffected
    const a = rows.find((r) => r.symbol === "ZZP")!;
    expect(a.today_pct).toBeCloseTo((351 - 350.0) / 350.0, 6);
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

  // Regression pin for qa:today-ibkr-snapshot--percent-denominator-must-be-gross-not-net.
  // The day-percent denominator on Today used NET prior-close exposure
  // (Σcurrent_value − ΣtodayGain). With shorts included in the row set, a
  // hedged book (long + offsetting short) drives net exposure to ~0, which
  // either renders "—" beside a real dollar gain or blows the percent up.
  // Ratified fix: the denominator is GROSS prior-close exposure, i.e. the sum
  // of each row's |prior-close value|, never net.
  describe("summarizeIbkrDayMove", () => {
    // Synthetic (round, invented) dollar figures — not real portfolio data.
    function row(overrides: Partial<TodayHolding>): TodayHolding {
      return {
        security_id: 1,
        symbol: "SYN",
        security_name: null,
        quantity: 1,
        current_price: null,
        current_value: null,
        prior_close: null,
        today_gain: null,
        today_pct: null,
        price_date: null,
        price_source: null,
        opened_today: false,
        added_today_qty: 0,
        added_cost_unknown: false,
        change_undated: false,
        day_move_basis: overrides.today_gain == null ? "unpriced" : "prior_close",
        day_move_base: null,
        ...overrides,
      };
    }

    it("uses gross (not net) prior-close exposure across a long + short book", () => {
      // Long: $2,000 prior -> +$100 gain -> $2,100 current value.
      const long = row({ symbol: "LONG", current_value: 2100, today_gain: 100 });
      // Short: -$5,000 prior (price fell) -> +$500 gain -> -$4,500 current value.
      const short = row({ symbol: "SHORT", current_value: -4500, today_gain: 500 });

      const summary = summarizeIbkrDayMove([long, short]);

      expect(summary.count).toBe(2);
      expect(summary.todayGain).toBeCloseTo(600, 6);
      expect(summary.priorGross).toBeCloseTo(7000, 6);
      expect(summary.todayPct).toBeCloseTo(600 / 7000, 6);
    });

    it("returns a finite percent for a near-neutral (net ~0) hedged book", () => {
      // Long: $5,000 prior -> +$50 gain -> $5,050 current value.
      const long = row({ symbol: "LONG", current_value: 5050, today_gain: 50 });
      // Short: -$5,000 prior -> -$50 gain (price rose) -> -$5,050 current value.
      const short = row({ symbol: "SHORT", current_value: -5050, today_gain: -50 });

      // Net prior-close exposure would be (5050 - 4950) - (50 + -50) = 0,
      // which is why the old net-denominator formula produced null/blowup
      // here. Gross exposure is 5000 + 5000 = 10000, always well-defined.
      const summary = summarizeIbkrDayMove([long, short]);

      expect(summary.priorGross).toBeCloseTo(10000, 6);
      expect(summary.todayGain).toBeCloseTo(0, 6);
      expect(summary.todayPct).not.toBeNull();
      expect(summary.todayPct).toBeCloseTo(0, 6);
    });

    it("returns null todayGain/todayPct and count 0 when nothing has a prior close", () => {
      const noMove = row({ symbol: "NEWPOS", today_gain: null });

      const summary = summarizeIbkrDayMove([noMove]);

      expect(summary.count).toBe(0);
      expect(summary.todayGain).toBeNull();
      expect(summary.priorGross).toBe(0);
      expect(summary.todayPct).toBeNull();
    });
  });

  // Regression pin for qa:today-ibkr-snapshot--name-count-and-day-pl-drop-short-positions.
  // getIbkrTodayHoldings called latestHoldingsPredicate with includeShorts:
  // false, so the row set's quantity clause was `h.quantity > 0` and every
  // short position vanished — the Today snapshot's name count undercounted
  // the Accounts page by exactly its short-position count. A short must
  // appear in the rows, and because the market-value expressions are
  // quantity-signed, a price DROP must show a POSITIVE today_gain (a short
  // profits when the price falls) — never suppressed, never sign-flipped.
  it("includes short positions so the row/name count matches Accounts, with day P/L sign correct", () => {
    const acct = ibkrAccountId();
    const spy = seedSecurity("SPY", "ETF");
    const short = seedSecurity("SHRT");
    const long = seedSecurity("LONG");
    hold(acct, spy, 1, "2026-07-29");
    hold(acct, short, -100, "2026-07-29");
    hold(acct, long, 20, "2026-07-29");

    price(spy, "2026-07-29", 628);
    price(spy, "2026-07-30", 630);
    // Short: price DROPS 50 -> 45. A short gains when price falls.
    price(short, "2026-07-29", 50);
    price(short, "2026-07-30", 45);
    // Long control in the same fixture: price rises, unaffected by the fix.
    price(long, "2026-07-29", 100);
    price(long, "2026-07-30", 105);

    const rows = getIbkrTodayHoldings(db, acct);

    const s = rows.find((r) => r.symbol === "SHRT");
    expect(s).toBeDefined();
    // Sign check: the position gained even though the underlying price fell.
    expect(s!.today_gain).toBeGreaterThan(0);
    expect(s!.today_gain).toBeCloseTo((45 - 50) * -100, 4);
    // today_pct is signed by position direction: a short gains when price
    // falls, so pct agrees in sign with today_gain.
    expect(s!.today_pct).toBeCloseTo(-(45 - 50) / 50, 6);

    const l = rows.find((r) => r.symbol === "LONG")!;
    expect(l).toBeDefined();
    expect(l.today_gain).toBeCloseTo((105 - 100) * 20, 4);
    expect(l.today_pct).toBeCloseTo((105 - 100) / 100, 6);
  });

  // Regression pin for
  // qa:today-ibkr-snapshot--expired-option-counted-in-names-and-day-move.
  // Options never carry `maturity_date` (bond-only column) — their expiry
  // lives in `securities.expiration_date` — so the maturity_date guard let a
  // contract that expired YESTERDAY (ET) sail through: it stayed in the name
  // count, the day-move sum, and the exposure denominator. Dates are derived
  // from todayET() (never a hardcoded calendar date) so this pin never goes
  // wall-clock stale. A contract expiring TODAY must still count as live.
  it("excludes an option past its ET expiration date from rows/count/day-move, keeps one expiring today", () => {
    const acct = ibkrAccountId();
    const today = todayET();
    const yesterday = addDays(today, -1);

    const spy = seedSecurity("SPY", "ETF");
    const expired = seedOption("EXP   270101P00100000", "EXP", "PUT", 100, yesterday);
    const liveToday = seedOption("LIV   270101P00100000", "LIV", "PUT", 100, today);
    hold(acct, spy, 1, "2026-07-29");
    hold(acct, expired, 2, "2026-07-29");
    hold(acct, liveToday, 3, "2026-07-29");

    price(spy, "2026-07-29", 628);
    price(spy, "2026-07-30", 630);
    price(expired, "2026-07-29", 5);
    price(expired, "2026-07-30", 6);
    price(liveToday, "2026-07-29", 7);
    price(liveToday, "2026-07-30", 8);

    const rows = getIbkrTodayHoldings(db, acct);

    expect(rows.find((r) => r.symbol.startsWith("EXP"))).toBeUndefined();
    const live = rows.find((r) => r.symbol.startsWith("LIV"));
    expect(live).toBeDefined();
    expect(live!.today_gain).toBeCloseTo((8 - 7) * 100 * 3, 4);

    // Summary must reflect only the surviving rows: SPY + LIV, never EXP.
    const summary = summarizeIbkrDayMove(rows);
    expect(summary.count).toBe(2);
  });
});

describe("short positions: today_pct is signed by position direction", () => {
  it("a short that falls in price shows a positive gain AND a positive pct; a long that falls is negative", () => {
    const acct = ibkrAccountId();
    const shrt = seedSecurity("SHRT");
    const lng = seedSecurity("LONG");
    const spy = seedSecurity("SPY", "ETF");
    hold(acct, shrt, -10, "2026-07-29");
    hold(acct, lng, 10, "2026-07-29");
    hold(acct, spy, 1, "2026-07-29");
    for (const sid of [shrt, lng]) {
      price(sid, "2026-07-29", 100);
      price(sid, "2026-07-30", 90);
    }
    price(spy, "2026-07-29", 600);
    price(spy, "2026-07-30", 601);

    const rows = getIbkrTodayHoldings(db, acct);
    const s = rows.find((r) => r.symbol === "SHRT")!;
    const l = rows.find((r) => r.symbol === "LONG")!;
    expect(s.today_gain).toBeCloseTo(100, 4);
    expect(s.today_pct).toBeCloseTo(0.1, 6);
    expect(Math.sign(s.today_pct!)).toBe(Math.sign(s.today_gain!));
    expect(l.today_gain).toBeCloseTo(-100, 4);
    expect(l.today_pct).toBeCloseTo(-0.1, 6);
  });
});


describe("getIbkrTodayHoldings measures on the pair it is given", () => {
  it("the Today page resolves the pair once and passes it, so the heading and the figure share it", () => {
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const page = readFileSync("app/dashboard/today/page.tsx", "utf8");
    expect(page.match(/resolveTradingDayPair\(db\)/g)).toHaveLength(1);
    expect(page).toContain("getIbkrTodayHoldings(db, ibkrAccount.id, movePair)");
    expect(page).toContain("ibkrSnapshotHeading(movePair?.latest ?? null, todayET())");
  });
});

// Owner ruling 2026-10-08: a position opened or added to since the prior close
// is not credited with the move since that close. Quantity held through the
// session keeps the close-to-close move; quantity opened today is measured
// from its own cost, and is left out when the cost is unknown.
//
// Fixtures follow the live writer (lib/tws/positions.ts): one holdings row per
// (account, security, day), cost_basis = quantity x average cost (a TOTAL, so
// negative for a short and already multiplied for an option).
describe("getIbkrTodayHoldings: quantity opened today is measured from cost", () => {
  const PRIOR = "2026-08-05"; // Wednesday
  const LATEST = "2026-08-06"; // Thursday

  function holdAt(
    accountId: number,
    securityId: number,
    qty: number,
    cost: number | null,
    asOf: string,
  ): void {
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(accountId, securityId, qty, cost, asOf, `tws-${accountId}-${securityId}-${asOf}`);
  }

  /** SPY sets the pair, and is held on both dates so the book was observed at the prior close. */
  function seedClock(acct: number): number {
    const spy = seedSecurity("SPY", "ETF");
    price(spy, PRIOR, 630);
    price(spy, LATEST, 631);
    holdAt(acct, spy, 1, 600, PRIOR);
    holdAt(acct, spy, 1, 600, LATEST);
    return spy;
  }

  function find(rows: TodayHolding[], symbol: string): TodayHolding {
    const row = rows.find((r) => r.symbol === symbol);
    if (!row) throw new Error(`no row for ${symbol}`);
    return row;
  }

  it("opened today with a cost: gain is (latest close - cost per share) x quantity", () => {
    const acct = ibkrAccountId();
    seedClock(acct);
    const zza = seedSecurity("ZZA");
    holdAt(acct, zza, 10, 1020, LATEST); // bought 10 at 102
    price(zza, PRIOR, 100);
    price(zza, LATEST, 105);

    const z = find(getIbkrTodayHoldings(db, acct), "ZZA");
    // 10 x (105 - 102) = 30. The old rule credited 10 x (105 - 100) = 50.
    expect(z.today_gain).toBeCloseTo(30, 6);
    expect(z.today_pct).toBeCloseTo(30 / 1020, 9);
    expect(z.opened_today).toBe(true);
    expect(z.added_today_qty).toBe(10);
    expect(z.day_move_basis).toBe("cost");
    expect(z.day_move_base).toBeCloseTo(1020, 6);
    expect(z.change_undated).toBe(false);
  });

  it("opened today with a cost needs no prior close", () => {
    const acct = ibkrAccountId();
    seedClock(acct);
    const zza = seedSecurity("ZZA");
    holdAt(acct, zza, 10, 1020, LATEST);
    price(zza, LATEST, 105); // first price row ever

    const z = find(getIbkrTodayHoldings(db, acct), "ZZA");
    expect(z.today_gain).toBeCloseTo(30, 6);
    expect(z.day_move_basis).toBe("cost");
  });

  it("opened today without a cost: excluded from the move and counted", () => {
    const acct = ibkrAccountId();
    seedClock(acct);
    const zza = seedSecurity("ZZA");
    holdAt(acct, zza, 10, null, LATEST);
    price(zza, PRIOR, 100);
    price(zza, LATEST, 105);

    const rows = getIbkrTodayHoldings(db, acct);
    const z = find(rows, "ZZA");
    expect(z.today_gain).toBeNull();
    expect(z.today_pct).toBeNull();
    expect(z.opened_today).toBe(true);
    expect(z.day_move_basis).toBe("excluded");
    // Still a held name with a value.
    expect(z.current_value).toBeCloseTo(1050, 6);

    const summary = summarizeIbkrDayMove(rows);
    expect(summary.count).toBe(1); // SPY only
    expect(summary.todayGain).toBeCloseTo(1, 6); // SPY 1 x (631 - 630)
    expect(summary.openedTodayCount).toBe(1);
    expect(summary.excludedCount).toBe(1);
    expect(summary.unpricedCount).toBe(0);
  });

  it("a position closed and reopened: the zero-quantity tombstone at the prior date means absent", () => {
    const acct = ibkrAccountId();
    seedClock(acct);
    const zza = seedSecurity("ZZA");
    holdAt(acct, zza, 10, 900, "2026-08-04");
    holdAt(acct, zza, 0, null, PRIOR); // closed
    holdAt(acct, zza, 10, 1020, LATEST); // bought back at 102
    price(zza, PRIOR, 100);
    price(zza, LATEST, 105);

    const z = find(getIbkrTodayHoldings(db, acct), "ZZA");
    expect(z.opened_today).toBe(true);
    expect(z.today_gain).toBeCloseTo(30, 6);
  });

  it("an add: held quantity close-to-close, added quantity from the change in total cost", () => {
    const acct = ibkrAccountId();
    seedClock(acct);
    const zzb = seedSecurity("ZZB");
    holdAt(acct, zzb, 10, 900, PRIOR);
    holdAt(acct, zzb, 15, 1410, LATEST); // 5 more for 510 = 102 each
    price(zzb, PRIOR, 100);
    price(zzb, LATEST, 105);

    const z = find(getIbkrTodayHoldings(db, acct), "ZZB");
    // Held 10 x 5 = 50, added 5 x (105 - 102) = 15. Old rule: 15 x 5 = 75.
    expect(z.today_gain).toBeCloseTo(65, 6);
    // Base: 10 x 100 + 510 = 1,510.
    expect(z.day_move_base).toBeCloseTo(1510, 6);
    expect(z.today_pct).toBeCloseTo(65 / 1510, 9);
    expect(z.day_move_basis).toBe("mixed");
    expect(z.opened_today).toBe(false);
    expect(z.added_today_qty).toBe(5);
    expect(z.added_cost_unknown).toBe(false);
  });

  it("an add whose cost cannot be derived: only the held quantity counts, and the row is flagged", () => {
    const acct = ibkrAccountId();
    seedClock(acct);
    const zzb = seedSecurity("ZZB");
    holdAt(acct, zzb, 10, null, PRIOR); // no cost on the prior row
    holdAt(acct, zzb, 15, 1410, LATEST);
    price(zzb, PRIOR, 100);
    price(zzb, LATEST, 105);

    const rows = getIbkrTodayHoldings(db, acct);
    const z = find(rows, "ZZB");
    expect(z.today_gain).toBeCloseTo(50, 6); // 10 x 5
    expect(z.today_pct).toBeCloseTo(0.05, 9);
    expect(z.day_move_base).toBeCloseTo(1000, 6);
    expect(z.day_move_basis).toBe("prior_close");
    expect(z.added_today_qty).toBe(5);
    expect(z.added_cost_unknown).toBe(true);

    const summary = summarizeIbkrDayMove(rows);
    expect(summary.addedTodayCount).toBe(1);
    expect(summary.addedCostUnknownCount).toBe(1);
    // Denominator uses the held quantity's prior value (1,000), not the value
    // of all 15 shares: SPY 630 + ZZB 1,000.
    expect(summary.priorGross).toBeCloseTo(1630, 6);
  });

  it("a reduced position: only the quantity still held gets the move", () => {
    const acct = ibkrAccountId();
    seedClock(acct);
    const zzc = seedSecurity("ZZC");
    holdAt(acct, zzc, 10, 900, PRIOR);
    holdAt(acct, zzc, 4, 360, LATEST);
    price(zzc, PRIOR, 100);
    price(zzc, LATEST, 105);

    const z = find(getIbkrTodayHoldings(db, acct), "ZZC");
    expect(z.today_gain).toBeCloseTo(20, 6); // 4 x 5
    expect(z.today_pct).toBeCloseTo(0.05, 9);
    expect(z.day_move_basis).toBe("prior_close");
    expect(z.opened_today).toBe(false);
    expect(z.added_today_qty).toBe(0);
  });

  it("an unchanged position is exactly what it was before the ruling, whatever its cost says", () => {
    const acct = ibkrAccountId();
    seedClock(acct);
    const zzd = seedSecurity("ZZD");
    holdAt(acct, zzd, 10, 900, PRIOR);
    holdAt(acct, zzd, 10, 910, LATEST); // cost drifted; quantity did not
    price(zzd, PRIOR, 100);
    price(zzd, LATEST, 105);

    const z = find(getIbkrTodayHoldings(db, acct), "ZZD");
    expect(z.today_gain).toBeCloseTo(50, 6);
    expect(z.today_pct).toBeCloseTo(0.05, 9);
    expect(z.prior_close).toBeCloseTo(100, 6);
    expect(z.day_move_basis).toBe("prior_close");
    expect(z.day_move_base).toBeCloseTo(1000, 6);
    expect(z.opened_today).toBe(false);
    expect(z.added_today_qty).toBe(0);
    expect(z.added_cost_unknown).toBe(false);
  });

  it("a short opened today gains when the price falls below the sale price, not below the prior close", () => {
    const acct = ibkrAccountId();
    seedClock(acct);
    const zzs = seedSecurity("ZZS");
    holdAt(acct, zzs, -10, -500, LATEST); // sold 10 short at 50
    price(zzs, PRIOR, 52);
    price(zzs, LATEST, 45);

    const z = find(getIbkrTodayHoldings(db, acct), "ZZS");
    // (45 - 50) x -10 = +50. The old rule credited (45 - 52) x -10 = +70.
    expect(z.today_gain).toBeCloseTo(50, 6);
    expect(z.today_pct).toBeCloseTo(0.1, 9); // 50 on 500 of proceeds
    expect(z.day_move_basis).toBe("cost");
    expect(z.opened_today).toBe(true);
  });

  it("an option opened today: the contract multiplier scales the value, the cost is already total dollars", () => {
    const acct = ibkrAccountId();
    seedClock(acct);
    const call = db
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, asset_class, underlying_symbol, option_type, strike_price, multiplier, currency)
         VALUES ('ZZA   271217C00110000', 'ZZA call', 'Option', 'option', 'ZZA', 'CALL', 110, 100, 'USD')`,
      )
      .run().lastInsertRowid as number;
    holdAt(acct, call, 2, 1000, LATEST); // 2 contracts at 5.00
    price(call, PRIOR, 2);
    price(call, LATEST, 6);

    const c = find(getIbkrTodayHoldings(db, acct), "ZZA   271217C00110000");
    // (6 - 5) x 2 x 100 = 200. The old rule credited (6 - 2) x 2 x 100 = 800.
    expect(c.today_gain).toBeCloseTo(200, 6);
    expect(c.today_pct).toBeCloseTo(0.2, 9);
    expect(c.day_move_base).toBeCloseTo(1000, 6);
    expect(c.day_move_basis).toBe("cost");
  });

  it("an option opened today ignores a stale PRIOR quote but is still suppressed by a stale LATEST quote", () => {
    const acct = ibkrAccountId();
    seedClock(acct);
    const und = seedSecurity("ZZU");
    price(und, PRIOR, 350);
    price(und, LATEST, 350);
    const insert = db.prepare(
      `INSERT INTO securities (symbol, name, security_type, asset_class, underlying_symbol, option_type, strike_price, multiplier, currency)
       VALUES (?, ?, 'Option', 'option', 'ZZU', 'PUT', 390, 100, 'USD')`,
    );
    const stalePrior = insert.run("ZZU   271217P00390000", "ZZU put a").lastInsertRowid as number;
    const staleLatest = insert.run("ZZU   280121P00390000", "ZZU put b").lastInsertRowid as number;
    // Intrinsic is 390 - 350 = 40 on both dates.
    holdAt(acct, stalePrior, 1, 4100, LATEST); // bought at 41.00
    price(stalePrior, PRIOR, 15); // far below intrinsic: stale, but not used
    price(stalePrior, LATEST, 42);
    holdAt(acct, staleLatest, 1, 4100, LATEST);
    price(staleLatest, PRIOR, 41);
    price(staleLatest, LATEST, 15); // far below intrinsic: stale, and it IS used

    const rows = getIbkrTodayHoldings(db, acct);
    const a = find(rows, "ZZU   271217P00390000");
    expect(a.today_gain).toBeCloseTo(100, 6); // (42 - 41) x 100
    const b = find(rows, "ZZU   280121P00390000");
    expect(b.today_gain).toBeNull();
    expect(b.day_move_basis).toBe("unpriced");
  });

  it("a non-USD row: cost and closes are native, the gain and its base are converted once", () => {
    const acct = ibkrAccountId();
    seedClock(acct);
    const zzk = db
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, asset_class, currency) VALUES ('ZZK', 'ZZK Corp', 'Stock', 'equity', 'KRW')",
      )
      .run().lastInsertRowid as number;
    db.prepare(
      "INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('KRW', 0.0007, ?, 'test')",
    ).run(LATEST);
    holdAt(acct, zzk, 10, 17_000_000, LATEST); // 10 at 1,700,000 won
    price(zzk, PRIOR, 1_650_000);
    price(zzk, LATEST, 1_730_000);

    const z = find(getIbkrTodayHoldings(db, acct), "ZZK");
    // 10 x (1,730,000 - 1,700,000) = 300,000 won x 0.0007 = 210 dollars.
    expect(z.today_gain).toBeCloseTo(210, 6);
    // Base 17,000,000 won = 11,900 dollars.
    expect(z.day_move_base).toBeCloseTo(11_900, 6);
    expect(z.today_pct).toBeCloseTo(210 / 11_900, 9);
    expect(z.day_move_basis).toBe("cost");
  });

  it("percent denominator: prior value of held quantity plus cost of quantity opened today", () => {
    const acct = ibkrAccountId();
    seedClock(acct); // SPY: gain 1 on a prior value of 630
    const held = seedSecurity("ZZD");
    holdAt(acct, held, 10, 900, PRIOR);
    holdAt(acct, held, 10, 900, LATEST);
    price(held, PRIOR, 100);
    price(held, LATEST, 105); // gain 50 on 1,000
    const opened = seedSecurity("ZZA");
    holdAt(acct, opened, 10, 1020, LATEST);
    price(opened, PRIOR, 100);
    price(opened, LATEST, 105); // gain 30 on a cost of 1,020
    const added = seedSecurity("ZZB");
    holdAt(acct, added, 10, 900, PRIOR);
    holdAt(acct, added, 15, 1410, LATEST);
    price(added, PRIOR, 100);
    price(added, LATEST, 105); // gain 65 on 1,000 + 510

    const summary = summarizeIbkrDayMove(getIbkrTodayHoldings(db, acct));
    expect(summary.count).toBe(4);
    expect(summary.todayGain).toBeCloseTo(1 + 50 + 30 + 65, 6);
    // 630 + 1,000 + 1,020 + 1,510 = 4,160. The old denominator took
    // current value - gain for every row and read 630 + 1,000 + 1,020 + 1,510
    // only by accident for none of the changed rows: it gave 1,050 - 30 = 1,020
    // for the opened row but 1,575 - 65 = 1,510 only because 65 is now the gain.
    expect(summary.priorGross).toBeCloseTo(4160, 6);
    expect(summary.todayPct).toBeCloseTo(146 / 4160, 9);
    expect(summary.openedTodayCount).toBe(1);
    expect(summary.addedTodayCount).toBe(1);
    expect(summary.excludedCount).toBe(0);
    expect(summary.addedCostUnknownCount).toBe(0);
    expect(summary.undatedChangeCount).toBe(0);
  });

  it("a short opened today enters the denominator at its proceeds, as a positive amount", () => {
    const acct = ibkrAccountId();
    seedClock(acct);
    const zzs = seedSecurity("ZZS");
    holdAt(acct, zzs, -10, -500, LATEST);
    price(zzs, PRIOR, 52);
    price(zzs, LATEST, 45);

    const summary = summarizeIbkrDayMove(getIbkrTodayHoldings(db, acct));
    expect(summary.todayGain).toBeCloseTo(51, 6);
    expect(summary.priorGross).toBeCloseTo(630 + 500, 6);
  });

  // The book was last seen days ago: a position that is new since then may
  // have been bought on any of those days. Measuring it from cost would print
  // a multi-day gain as this session's move, so the change is left out.
  it("with no holdings snapshot at the prior close, a new position is not dated to this session", () => {
    const acct = ibkrAccountId();
    const spy = seedSecurity("SPY", "ETF");
    price(spy, PRIOR, 630);
    price(spy, LATEST, 631);
    holdAt(acct, spy, 1, 600, "2026-07-31"); // last snapshot before the gap
    holdAt(acct, spy, 1, 600, LATEST);
    const zza = seedSecurity("ZZA");
    holdAt(acct, zza, 10, 1020, LATEST);
    price(zza, PRIOR, 100);
    price(zza, LATEST, 105);
    const zzb = seedSecurity("ZZB");
    holdAt(acct, zzb, 10, 900, "2026-07-31");
    holdAt(acct, zzb, 15, 1410, LATEST);
    price(zzb, PRIOR, 100);
    price(zzb, LATEST, 105);

    const rows = getIbkrTodayHoldings(db, acct);
    const a = find(rows, "ZZA");
    expect(a.today_gain).toBeNull();
    expect(a.change_undated).toBe(true);
    expect(a.opened_today).toBe(false);
    expect(a.day_move_basis).toBe("excluded");
    const b = find(rows, "ZZB");
    // The 10 shares in the last snapshot are still held: 10 x 5 = 50.
    expect(b.today_gain).toBeCloseTo(50, 6);
    expect(b.change_undated).toBe(true);
    expect(b.added_today_qty).toBe(0);
    expect(b.day_move_base).toBeCloseTo(1000, 6);
    // Unchanged names are untouched by the gap.
    expect(find(rows, "SPY").today_gain).toBeCloseTo(1, 6);

    const summary = summarizeIbkrDayMove(rows);
    expect(summary.undatedChangeCount).toBe(2);
    expect(summary.openedTodayCount).toBe(0);
    expect(summary.addedTodayCount).toBe(0);
    expect(summary.priorGross).toBeCloseTo(1630, 6);
  });

  it("with no trading-day pair nothing is called opened and every move is unknown", () => {
    const acct = ibkrAccountId();
    const zza = seedSecurity("ZZA");
    holdAt(acct, zza, 10, 1020, LATEST);
    price(zza, LATEST, 105);

    const z = find(getIbkrTodayHoldings(db, acct, null), "ZZA");
    expect(z.today_gain).toBeNull();
    expect(z.opened_today).toBe(false);
    expect(z.day_move_basis).toBe("unpriced");
  });
});

// A holdings row dated AFTER the measured session says what happened in the
// NEXT session. Measuring its quantity against this session's closes prices a
// purchase against a close that came before it. Invented round figures.
describe("getIbkrTodayHoldings: a row dated after the measured session", () => {
  const PRIOR = "2026-10-06"; // Tuesday
  const LATEST = "2026-10-07"; // Wednesday
  const NEXT = "2026-10-08"; // Thursday: after the measured session
  const PAIR = { latest: LATEST, prior: PRIOR };

  function holdAt(
    accountId: number,
    securityId: number,
    qty: number,
    cost: number | null,
    asOf: string,
  ): void {
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(accountId, securityId, qty, cost, asOf, `tws-${accountId}-${securityId}-${asOf}`);
  }

  function seedName(symbol: string): number {
    const id = seedSecurity(symbol);
    price(id, PRIOR, 50);
    price(id, LATEST, 55);
    return id;
  }

  function find(rows: TodayHolding[], symbol: string): TodayHolding {
    const row = rows.find((r) => r.symbol === symbol);
    if (!row) throw new Error(`no row for ${symbol}`);
    return row;
  }

  it("shares bought in the next session are not measured: the session's own quantity moves close-to-close", () => {
    const acct = ibkrAccountId();
    const morn = seedName("MORN");
    holdAt(acct, morn, 100, 4000, PRIOR);
    holdAt(acct, morn, 100, 4000, LATEST);
    holdAt(acct, morn, 200, 10000, NEXT); // 100 more bought at 60 the next day

    const m = find(getIbkrTodayHoldings(db, acct, PAIR), "MORN");
    expect(m.today_gain).toBeCloseTo(500, 6); // 100 x (55 - 50)
    expect(m.today_pct).toBeCloseTo(0.1, 9);
    expect(m.day_move_basis).toBe("prior_close");
    expect(m.added_today_qty).toBe(0);
    expect(m.opened_today).toBe(false);
    expect(m.change_undated).toBe(true);
    expect(m.changed_after_session).toBe(true);
    expect(m.day_move_base).toBeCloseTo(5000, 6); // 100 x 50
    expect(m.quantity).toBe(200); // the row still shows what is held now
  });

  it("a name opened in the next session is not measured at all, and is counted", () => {
    const acct = ibkrAccountId();
    const morn = seedName("MORN");
    holdAt(acct, morn, 100, 4000, PRIOR);
    holdAt(acct, morn, 100, 4000, LATEST);
    const next = seedName("OPENNEXT");
    holdAt(acct, next, 100, 6000, NEXT);

    const rows = getIbkrTodayHoldings(db, acct, PAIR);
    const o = find(rows, "OPENNEXT");
    expect(o.today_gain).toBeNull();
    expect(o.today_pct).toBeNull();
    expect(o.opened_today).toBe(false);
    expect(o.added_today_qty).toBe(0);
    expect(o.day_move_basis).toBe("excluded");
    expect(o.change_undated).toBe(true);
    expect(o.changed_after_session).toBe(true);

    const summary = summarizeIbkrDayMove(rows);
    expect(summary.todayGain).toBeCloseTo(500, 6);
    expect(summary.priorGross).toBeCloseTo(5000, 6);
    expect(summary.count).toBe(1);
    expect(summary.undatedChangeCount).toBe(1);
    expect(summary.openedTodayCount).toBe(0);
    expect(summary.excludedCount).toBe(0);
  });

  it("a position reduced in the next session: the quantity held in the session is measured", () => {
    const acct = ibkrAccountId();
    const zza = seedName("ZZA");
    holdAt(acct, zza, 100, 4000, PRIOR);
    holdAt(acct, zza, 100, 4000, LATEST);
    holdAt(acct, zza, 40, 1600, NEXT); // 60 sold the next day

    const z = find(getIbkrTodayHoldings(db, acct, PAIR), "ZZA");
    expect(z.today_gain).toBeCloseTo(500, 6); // 100 x 5, not 40 x 5
    expect(z.day_move_basis).toBe("prior_close");
    expect(z.change_undated).toBe(true);
    expect(z.day_move_base).toBeCloseTo(5000, 6);
  });

  it("a later row with the SAME quantity changes nothing", () => {
    const acct = ibkrAccountId();
    const zza = seedName("ZZA");
    holdAt(acct, zza, 100, 4000, PRIOR);
    holdAt(acct, zza, 100, 4000, LATEST);
    holdAt(acct, zza, 100, 4000, NEXT);

    const z = find(getIbkrTodayHoldings(db, acct, PAIR), "ZZA");
    expect(z.today_gain).toBeCloseTo(500, 6);
    expect(z.change_undated).toBe(false);
    expect(z.changed_after_session).toBeUndefined();
    expect(z.day_move_basis).toBe("prior_close");
  });

  it("a row dated exactly on the session is measured as before: bought in the session, from cost", () => {
    const acct = ibkrAccountId();
    const zza = seedName("ZZA");
    holdAt(acct, zza, 100, 4000, PRIOR);
    holdAt(acct, zza, 200, 9200, LATEST); // 100 more at 52 during the session

    const z = find(getIbkrTodayHoldings(db, acct, PAIR), "ZZA");
    // Held 100 x 5 = 500, added 100 x (55 - 52) = 300.
    expect(z.today_gain).toBeCloseTo(800, 6);
    expect(z.day_move_basis).toBe("mixed");
    expect(z.added_today_qty).toBe(100);
    expect(z.change_undated).toBe(false);
    expect(z.changed_after_session).toBeUndefined();
  });

  it("bought in the session AND again the next day: the session's purchase is measured, the next day's is not", () => {
    const acct = ibkrAccountId();
    const zza = seedName("ZZA");
    holdAt(acct, zza, 100, 4000, PRIOR);
    holdAt(acct, zza, 200, 9200, LATEST);
    holdAt(acct, zza, 300, 15200, NEXT);

    const z = find(getIbkrTodayHoldings(db, acct, PAIR), "ZZA");
    expect(z.today_gain).toBeCloseTo(800, 6);
    expect(z.day_move_basis).toBe("mixed");
    expect(z.added_today_qty).toBe(100);
    expect(z.change_undated).toBe(true);
    expect(z.day_move_base).toBeCloseTo(10200, 6); // 100 x 50 + 5,200 cost
  });
});
