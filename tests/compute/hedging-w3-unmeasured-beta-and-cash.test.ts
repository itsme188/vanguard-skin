import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { todayET, addDays } from "@/lib/calendar/date-utils";
import {
  attributeProxies,
  computeDefenseAnalysis,
  creditAtResolvedBeta,
  NOT_CREDITED_BETA_NO_HISTORY,
  NOT_CREDITED_BETA_LOW_FIT,
  type AttributionContext,
  type ProxyCandidate,
  type ProxyFundIdentity,
  type ResolvedBeta,
} from "@/lib/compute/hedging";
import { getConcentrationUniverse, splitConcentrationUniverse } from "@/lib/queries/concentration-universe";

// Owner rulings 2026-11-16 for the Defense view:
//  Ruling 19 = B: a hedge whose beta cannot be measured (too little price
//    history, or a measured slope that fails the fit test) is credited
//    NOTHING until it is measurable. It moves to the "Not credited" list with
//    a plain reason, keeps its notional shown, and stays out of the
//    protection ratio and the sector bars. The policy lives in ONE function,
//    creditAtResolvedBeta.
//  Cash line: "Cash and equivalents: X% of this scope", read through the
//    concentration card's own reader (splitConcentrationUniverse), never
//    added into the protection ratio.

const eq = (sector: string | null): ProxyFundIdentity => ({ fundCategory: null, assetClass: "equity", sector, leveraged: false });
const cand = (underlying: string, notional: number): ProxyCandidate => ({
  underlying,
  protectiveNotional: notional,
  source: "no_core_etf",
  instruments: [],
});
const unmeasured = (reason: "no_history" | "low_fit"): ResolvedBeta => ({ beta: null, source: "unmeasured", reason });

function ctx(over: Partial<AttributionContext> = {}): AttributionContext {
  return {
    sectorWeights: new Map(),
    etfGeography: new Map(),
    longExposureBySector: new Map([["Energy", 1000], ["Technology", 1000]]),
    longExposureByGeography: new Map(),
    tier1CreditedBySector: new Map(),
    totalLongExposure: 2000,
    resolveBeta: (s: string) =>
      s === "ZMB" ? { beta: 0.8, source: "computed" } : s === "ZLF" ? unmeasured("low_fit") : unmeasured("no_history"),
    fundIdentityByUnderlying: new Map([
      ["ZMB", eq("Energy")],
      ["ZNH", eq("Energy")],
      ["ZLF", eq(null)],
    ]),
    ...over,
  };
}

describe("ruling 19 = B: the one policy function", () => {
  it("credits a measured beta and refuses an unmeasured one with its plain reason", () => {
    expect(creditAtResolvedBeta(100, { beta: 1.5, source: "cached" })).toEqual({ credited: 150 });
    expect(creditAtResolvedBeta(100, unmeasured("no_history"))).toEqual({ notCreditedReason: NOT_CREDITED_BETA_NO_HISTORY });
    expect(creditAtResolvedBeta(100, unmeasured("low_fit"))).toEqual({ notCreditedReason: NOT_CREDITED_BETA_LOW_FIT });
    expect(NOT_CREDITED_BETA_NO_HISTORY).toMatch(/has not collected enough of its price history to measure/);
    expect(NOT_CREDITED_BETA_LOW_FIT).toMatch(/fits the market too loosely to measure/);
  });
});

describe("ruling 19 = B: attributeProxies", () => {
  it("an own-sector fund with no history is not credited and never reaches the sector bar", () => {
    const r = attributeProxies([cand("ZMB", 100), cand("ZNH", 300)], ctx());
    const znh = r.proxies.find((p) => p.underlying === "ZNH")!;
    expect(znh.route).toBe("not_credited");
    expect(znh.creditedTo).toEqual([]);
    expect(znh.notCreditedReason).toBe(NOT_CREDITED_BETA_NO_HISTORY);
    expect(znh.betaSource).toBe("unmeasured");
    expect(znh.protectiveNotional).toBe(300);
    // Only the measured fund lands on Energy: 100 x 0.8.
    expect(r.sectorCoverage.find((s) => s.sector === "Energy")!.protected).toBeCloseTo(80, 9);
  });

  it("a book-route fund whose slope fails the fit test is not credited, with the low-fit reason", () => {
    const r = attributeProxies([cand("ZLF", 200)], ctx());
    expect(r.proxies[0].route).toBe("not_credited");
    expect(r.proxies[0].notCreditedReason).toBe(NOT_CREDITED_BETA_LOW_FIT);
    expect(r.proxies[0].creditedTo).toEqual([]);
  });
});

// ─── Orchestrator: a synthetic book ──────────────────────────────────────

function book() {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  runMigrations(d);
  const acct = d.prepare("INSERT INTO accounts (name) VALUES ('Taxable')").run().lastInsertRowid as number;
  const sec = (symbol: string, type: string, sector: string | null, assetClass: string | null, fundCategory: string | null = null) =>
    d
      .prepare(
        "INSERT INTO securities (symbol, name, security_type, sector, asset_class, fund_category, source_key) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(symbol, symbol, type, sector, assetClass, fundCategory, `t:${symbol}`).lastInsertRowid as number;
  const hold = (sid: number, qty: number, price: number) => {
    d.prepare("INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, '2026-07-01')").run(
      acct,
      sid,
      qty,
      qty * price
    );
    d.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-07-01', 'test')").run(sid, price);
  };
  const expiry = addDays(todayET(), 180);
  const tag = expiry.replace(/-/g, "").slice(2);
  const put = (underlying: string, strike: number) => {
    const id = d
      .prepare(
        `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier)
         VALUES (?, ?, 'Option', ?, 'PUT', ?, ?, 100)`
      )
      .run(`${underlying}   ${tag}P00${strike}000`, `${underlying} PUT`, underlying, strike, expiry).lastInsertRowid as number;
    hold(id, 2, 5);
    return id;
  };
  // Long book: two stocks.
  hold(sec("ZZA", "Stock", "Technology", null), 1000, 100);
  hold(sec("ZZE", "Stock", "Energy", null), 1000, 100);
  // A Tier-1 hedge on ZZA.
  put("ZZA", 100);
  // Two equity funds held only through puts (no core): one with a cached
  // beta, one with a single price and no beta (unmeasurable).
  const zzm = sec("ZZM", "ETF", "Energy", "equity");
  d.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 100, '2026-07-01', 'test')").run(zzm);
  d.prepare("INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, 252, 0.8, '2026-07-01')").run(zzm);
  put("ZZM", 100);
  const zzu = sec("ZZU", "ETF", "Technology", "equity");
  d.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, 100, '2026-07-01', 'test')").run(zzu);
  put("ZZU", 100);
  return { d, acct, zzu, sec, hold };
}

describe("ruling 19 = B: the orchestrator", () => {
  it("conservation: old protection total == new credited protection + newly not-credited amount, zero residual", () => {
    const { d, acct, zzu } = book();
    const now = computeDefenseAnalysis(d, [acct]);
    const notCredited = now.notCreditedHedges.find((h) => h.underlying === "ZZU")!;
    expect(notCredited.reason).toBe(NOT_CREDITED_BETA_NO_HISTORY);
    expect(notCredited.protectiveNotional).toBeGreaterThan(0);
    expect(now.hedgeScores.some((h) => h.underlying === "ZZU")).toBe(false);
    expect(now.summary.notCreditedCount).toBe(1);
    expect(now.diagnostics.some((x) => x.kind === "unmeasured_beta" && x.symbol === "ZZU")).toBe(true);

    // The OLD rule credited an unmeasurable beta at an assumed 1.0. Storing
    // a beta of exactly 1.0 for ZZU reproduces that old credit on the same
    // book, with every other input unchanged.
    d.prepare("INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, 252, 1.0, '2026-07-01')").run(zzu);
    const old = computeDefenseAnalysis(d, [acct]);
    expect(old.notCreditedHedges).toEqual([]);
    const residual = old.summary.protectiveNotional - (now.summary.protectiveNotional + notCredited.protectiveNotional);
    expect(Math.abs(residual)).toBeLessThan(1e-9);
    // Same long book either way: only the numerator moves.
    expect(now.summary.longExposure).toBe(old.summary.longExposure);
    expect(now.summary.protectionRatio!).toBeLessThan(old.summary.protectionRatio!);
    // The sector bars lose exactly that credit.
    const prot = (a: typeof now) => a.sectorCoverage.reduce((s, c) => s + c.protected, 0);
    const bookShare = (a: typeof now) =>
      a.proxies.flatMap((p) => p.creditedTo).filter((c) => c.bucket === "book").reduce((s, c) => s + c.credited, 0);
    expect(Math.abs(prot(old) + bookShare(old) - (prot(now) + bookShare(now) + notCredited.protectiveNotional))).toBeLessThan(1e-9);
  });
});

describe("cash line: the concentration card's own cash figure, never in the protection ratio", () => {
  it("reads splitConcentrationUniverse and leaves the protection ratio unchanged", () => {
    const { d, acct, sec, hold } = book();
    const without = computeDefenseAnalysis(d, [acct]);
    expect(without.cashLine).toEqual({ weight: 0, marketValue: 0, holdingCount: 0, borrowed: { marketValue: 0, holdingCount: 0 } });

    hold(sec("ZMMXX", "Mutual Fund", null, null, "Money Market"), 50_000, 1);
    const withCash = computeDefenseAnalysis(d, [acct]);
    const split = splitConcentrationUniverse(getConcentrationUniverse(d, [acct]));
    expect(withCash.cashLine.weight).toBe(split.cash.weight);
    expect(withCash.cashLine.marketValue).toBe(50_000);
    expect(withCash.cashLine.holdingCount).toBe(1);
    expect(withCash.summary.protectionRatio).toBe(without.summary.protectionRatio);
    expect(withCash.summary.protectiveNotional).toBe(without.summary.protectiveNotional);
  });

  it("reports borrowing (a negative cash fund) apart, never as a cash share", () => {
    const { d, acct, sec, hold } = book();
    hold(sec("ZMMXX", "Mutual Fund", null, null, "Money Market"), -20_000, 1);
    const r = computeDefenseAnalysis(d, [acct]);
    expect(r.cashLine.holdingCount).toBe(0);
    expect(r.cashLine.weight).toBe(0);
    expect(r.cashLine.borrowed).toEqual({ marketValue: -20_000, holdingCount: 1 });
  });

  it("an empty scope reads no cash", () => {
    const { d } = book();
    expect(computeDefenseAnalysis(d, []).cashLine.holdingCount).toBe(0);
  });
});
