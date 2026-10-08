import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { buildOCCSymbol } from "@/lib/import/occ-symbol";
import { upsertSecurityQuote } from "@/lib/mutations/security-quotes";
import { isOptionLive } from "@/lib/compute/option-expiry";
import {
  callPrice,
  compareGreeksDefaultOrder,
  computePortfolioGreeks,
  DEFAULT_FALLBACK_VOL,
  delta,
  yearsToExpiry,
} from "@/lib/compute/options-greeks";

// QA findings (Options Greeks card, B14):
//   analysis-greeks--fallback-vol-row-counted-both-computed-and-failed
//   analysis-greeks--expired-contract-counted-in-coverage-denominator
//   analysis-greeks--underlying-lookup-symbol-equal-misses-issuer-sibling-goog
//   analysis-greeks-table--rows-unsorted-no-sortable-headers
//
// Fixed calendar: 2026-09-14 is a Monday, EDT in effect. All symbols and
// figures are synthetic.
const TODAY = "2026-09-14";
const MID_SESSION = new Date(`${TODAY}T10:30:00-04:00`);
const AFTER_CLOSE = new Date(`${TODAY}T16:30:00-04:00`);
const FAR = "2027-03-19";
const NEAR = "2026-10-16";
const YESTERDAY = "2026-09-13";
const R = 0.04;

let db: Database.Database;
let nextId = 10;

function addStock(symbol: string, price: number | null): number {
  const id = nextId++;
  db.prepare(`INSERT INTO securities (id, symbol, security_type) VALUES (?, ?, 'Stock')`).run(id, symbol);
  if (price !== null) {
    db.prepare(
      `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-09-11', ?, 'tws')`,
    ).run(id, price);
  }
  return id;
}

function addOption(opts: {
  underlying: string;
  strike: number;
  expiration: string; // as STORED (may be the legacy compact form)
  occExpiration?: string; // dashed form for the OCC symbol when `expiration` is compact
  type?: "CALL" | "PUT";
  price?: number | null;
  quantity?: number;
}): string {
  const id = nextId++;
  const type = opts.type ?? "CALL";
  const symbol = buildOCCSymbol(opts.underlying, opts.occExpiration ?? opts.expiration, type, opts.strike);
  db.prepare(
    `INSERT INTO securities (id, symbol, security_type, option_type, strike_price, expiration_date, underlying_symbol, multiplier)
     VALUES (?, ?, 'Option', ?, ?, ?, ?, 100)`,
  ).run(id, symbol, type, opts.strike, opts.expiration, opts.underlying);
  db.prepare(
    `INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key)
     VALUES (1, ?, '2026-09-11', ?, ?)`,
  ).run(id, opts.quantity ?? 1, `fixture-${id}`);
  if (opts.price != null) {
    db.prepare(
      `INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-09-11', ?, 'tws')`,
    ).run(id, opts.price);
  }
  return symbol;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  nextId = 10;
});

describe("computePortfolioGreeks — coverage counts partition the live option positions", () => {
  // One of each kind.
  let ownVol: string;
  let snapshotVol: string;
  let defaultVol: string;
  let unpriced: string;
  let expiredDashed: string;
  let expiredCompact: string;
  let expiredUnpriced: string;
  let stored: { symbol: string; expiration: string }[];

  beforeEach(() => {
    addStock("AAA", 100);
    const bbb = addStock("BBB", 100);
    addStock("CCC", 100);
    addStock("DDD", null); // no close anywhere
    addStock("EEE", 100);
    addStock("FFF", null);
    upsertSecurityQuote(db, {
      securityId: bbb,
      asOfDate: "2026-09-11",
      ivUnderlying: 0.4,
      hv30d: 0.35,
      week52High: 120,
      week52Low: 80,
      dividendYield: null,
    });

    const T = yearsToExpiry(FAR, TODAY, MID_SESSION);
    // 1. priced on the contract's own vol (mark generated at a 25% vol)
    ownVol = addOption({ underlying: "AAA", strike: 100, expiration: FAR, price: callPrice(100, 100, T, R, 0.25) });
    // 2. priced on the underlying's broker-snapshot vol (no option mark)
    snapshotVol = addOption({ underlying: "BBB", strike: 100, expiration: FAR });
    // 3. priced on the blind default vol (no mark, no snapshot)
    defaultVol = addOption({ underlying: "CCC", strike: 100, expiration: FAR });
    // 4. not priced (no underlying close)
    unpriced = addOption({ underlying: "DDD", strike: 100, expiration: FAR });
    // 5. expired, dashed expiration
    expiredDashed = addOption({ underlying: "EEE", strike: 100, expiration: YESTERDAY, price: 1 });
    // 6. expired, legacy compact expiration (a raw string compare reads it as live)
    expiredCompact = addOption({ underlying: "EEE", strike: 110, expiration: "20260910", occExpiration: "2026-09-10" });
    // 7. expired AND no underlying close: expired wins, it is not "unpriced"
    expiredUnpriced = addOption({ underlying: "FFF", strike: 100, expiration: YESTERDAY });

    stored = db
      .prepare(`SELECT symbol, expiration_date AS expiration FROM securities WHERE LOWER(security_type) = 'option'`)
      .all() as { symbol: string; expiration: string }[];
  });

  it("own-vol + fallback-vol + not-priced = live option positions (liveness per lib/compute/option-expiry.ts)", () => {
    const result = computePortfolioGreeks(db, { today: TODAY, now: MID_SESSION, riskFreeRate: R });

    const liveCount = stored.filter((s) => isOptionLive(s.expiration, TODAY)).length;
    expect(liveCount).toBe(4);
    expect(stored).toHaveLength(7);

    const pricedOwnVol = result.computedPositions - result.fallbackVolPositions;
    expect(pricedOwnVol).toBe(1);
    expect(result.fallbackVolPositions).toBe(2);
    expect(result.unpricedPositions).toBe(1);
    expect(pricedOwnVol + result.fallbackVolPositions + result.unpricedPositions).toBe(liveCount);
    expect(result.totalPositions).toBe(liveCount);

    // Expired rows are listed and counted, in neither side of the coverage line.
    expect(result.expiredPositions).toBe(3);
    expect(result.positions).toHaveLength(7);
    expect(result.totalPositions + result.expiredPositions).toBe(result.positions.length);
  });

  it("the counts agree with the rows they describe", () => {
    const result = computePortfolioGreeks(db, { today: TODAY, now: MID_SESSION, riskFreeRate: R });
    const bySymbol = new Map(result.positions.map((p) => [p.symbol, p]));

    expect(bySymbol.get(ownVol)!.greeks!.ivSource).toBe("computed");
    expect(bySymbol.get(snapshotVol)!.greeks!.ivSource).toBe("ibkr");
    expect(bySymbol.get(defaultVol)!.greeks!.ivSource).toBe("default");
    expect(bySymbol.get(unpriced)!.greeks).toBeNull();
    for (const sym of [expiredDashed, expiredCompact, expiredUnpriced]) {
      expect(bySymbol.get(sym)!.expired, sym).toBe(true);
      expect(bySymbol.get(sym)!.greeks, sym).toBeNull();
    }

    const live = result.positions.filter((p) => !p.expired);
    expect(live.filter((p) => p.greeks !== null).length).toBe(result.computedPositions);
    expect(live.filter((p) => p.greeks && p.greeks.ivSource !== "computed").length).toBe(result.fallbackVolPositions);
    expect(live.filter((p) => p.greeks === null).length).toBe(result.unpricedPositions);

    const reasons = new Map(result.diagnostics.map((d) => [d.symbol, d.reason]));
    expect(reasons.get(unpriced)).toBe("no_underlying_price");
    expect(reasons.get(expiredDashed)).toBe("expired");
    expect(reasons.get(expiredCompact)).toBe("expired");
    expect(reasons.get(expiredUnpriced)).toBe("expired");
    expect(reasons.get(defaultVol)).toBe("missing_option_price");
    expect(reasons.has(snapshotVol)).toBe(false);
    expect(reasons.has(ownVol)).toBe(false);
  });

  it("a fallback-vol row names the vol it was computed at and still feeds the totals", () => {
    const result = computePortfolioGreeks(db, { today: TODAY, now: MID_SESSION, riskFreeRate: R });
    const bySymbol = new Map(result.positions.map((p) => [p.symbol, p]));
    const T = yearsToExpiry(FAR, TODAY, MID_SESSION);

    const def = bySymbol.get(defaultVol)!.greeks!;
    expect(def.iv).toBeNull();
    expect(def.volUsed).toBe(DEFAULT_FALLBACK_VOL);
    // No numeric change: the delta is exactly the delta at the default vol.
    expect(def.delta).toBeCloseTo(delta(100, 100, T, R, DEFAULT_FALLBACK_VOL, "CALL"), 12);

    const snap = bySymbol.get(snapshotVol)!.greeks!;
    expect(snap.volUsed).toBeCloseTo(0.4, 12);
    expect(bySymbol.get(ownVol)!.greeks!.volUsed).toBeCloseTo(0.25, 4);

    const summed = result.positions.reduce((acc, p) => acc + (p.greeks ? p.greeks.delta * p.quantity * p.multiplier : 0), 0);
    expect(result.totalDelta).toBeCloseTo(summed, 9);
  });

  it("an expired-only book has an empty coverage denominator, not '0 of 1'", () => {
    db.prepare(`DELETE FROM holdings WHERE security_id NOT IN (SELECT id FROM securities WHERE symbol = ?)`).run(expiredDashed);
    const result = computePortfolioGreeks(db, { today: TODAY, now: MID_SESSION, riskFreeRate: R });
    expect(result.positions).toHaveLength(1);
    expect(result.totalPositions).toBe(0);
    expect(result.computedPositions).toBe(0);
    expect(result.unpricedPositions).toBe(0);
    expect(result.expiredPositions).toBe(1);
    expect(result.diagnostics.map((d) => d.reason)).toEqual(["expired"]);
  });

  it("after the 16:00 ET close an expiry-day contract leaves the denominator and the identity still holds", () => {
    const sameDay = addOption({ underlying: "AAA", strike: 105, expiration: TODAY, price: 0.5 });

    const open = computePortfolioGreeks(db, { today: TODAY, now: MID_SESSION, riskFreeRate: R });
    expect(open.positions.find((p) => p.symbol === sameDay)!.expired).toBe(false);
    expect(open.totalPositions).toBe(5);
    expect(open.computedPositions + open.unpricedPositions).toBe(open.totalPositions);

    const closed = computePortfolioGreeks(db, { today: TODAY, now: AFTER_CLOSE, riskFreeRate: R });
    expect(closed.positions.find((p) => p.symbol === sameDay)!.expired).toBe(true);
    expect(closed.totalPositions).toBe(4);
    expect(closed.expiredPositions).toBe(4);
    expect(closed.computedPositions + closed.unpricedPositions).toBe(closed.totalPositions);
  });
});

describe("computePortfolioGreeks — issuer-sibling underlying price", () => {
  it("prices a contract off the issuer sibling's close when its own symbol has none, and names the sibling", () => {
    addStock("GOOG", 300); // priced class
    addStock("GOOGL", null); // typeless stub, no close
    const T = yearsToExpiry(FAR, TODAY, MID_SESSION);
    const symbol = addOption({ underlying: "GOOGL", strike: 200, expiration: FAR, price: callPrice(300, 200, T, R, 0.3) });

    const result = computePortfolioGreeks(db, { today: TODAY, now: MID_SESSION, riskFreeRate: R });
    const pos = result.positions.find((p) => p.symbol === symbol)!;

    expect(pos.underlyingPrice).toBe(300);
    expect(pos.underlyingPriceSource).toBe("GOOG");
    expect(pos.greeks).not.toBeNull();
    expect(pos.greeks!.ivSource).toBe("computed");
    expect(pos.greeks!.iv!).toBeCloseTo(0.3, 3);
    expect(result.unpricedPositions).toBe(0);
    expect(result.computedPositions).toBe(1);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("does not name a source when the contract's own underlying is priced", () => {
    addStock("GOOG", 300);
    addStock("GOOGL", 302);
    const symbol = addOption({ underlying: "GOOGL", strike: 200, expiration: FAR, price: 110 });
    const pos = computePortfolioGreeks(db, { today: TODAY, now: MID_SESSION, riskFreeRate: R }).positions.find(
      (p) => p.symbol === symbol,
    )!;
    expect(pos.underlyingPrice).toBe(302);
    expect(pos.underlyingPriceSource).toBeUndefined();
  });

  it("stays unpriced when no share class has a close, and for a symbol with no family", () => {
    addStock("GOOG", null);
    addStock("GOOGL", null);
    addStock("ZZZ", null);
    addOption({ underlying: "GOOGL", strike: 200, expiration: FAR });
    addOption({ underlying: "ZZZ", strike: 50, expiration: FAR });
    const result = computePortfolioGreeks(db, { today: TODAY, now: MID_SESSION, riskFreeRate: R });
    expect(result.unpricedPositions).toBe(2);
    expect(result.computedPositions).toBe(0);
    expect(result.diagnostics.map((d) => d.reason)).toEqual(["no_underlying_price", "no_underlying_price"]);
    expect(result.positions.every((p) => p.underlyingPriceSource === undefined)).toBe(true);
  });
});

describe("computePortfolioGreeks — default row order", () => {
  it("returns positions nearest-expiry first, then underlying, then strike", () => {
    addStock("AAA", 100);
    addStock("BBB", 100);
    // Inserted deliberately out of order.
    const farB = addOption({ underlying: "BBB", strike: 100, expiration: FAR });
    const nearA110 = addOption({ underlying: "AAA", strike: 110, expiration: NEAR });
    const farA = addOption({ underlying: "AAA", strike: 100, expiration: FAR });
    const nearA90 = addOption({ underlying: "AAA", strike: 90, expiration: NEAR });
    const gone = addOption({ underlying: "BBB", strike: 100, expiration: YESTERDAY });

    const result = computePortfolioGreeks(db, { today: TODAY, now: MID_SESSION, riskFreeRate: R });
    expect(result.positions.map((p) => p.symbol)).toEqual([gone, nearA90, nearA110, farA, farB]);
  });

  it("compareGreeksDefaultOrder sorts an unreadable day count last", () => {
    const row = (daysToExpiry: number, underlying: string) => ({
      daysToExpiry,
      underlying,
      strike: 1,
      optionType: "CALL",
      symbol: underlying,
    });
    const sorted = [row(Number.NaN, "AAA"), row(30, "ZZZ"), row(5, "MMM")].sort(compareGreeksDefaultOrder);
    expect(sorted.map((r) => r.underlying)).toEqual(["MMM", "ZZZ", "AAA"]);
  });
});
