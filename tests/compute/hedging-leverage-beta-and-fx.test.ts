import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { computeDefenseAnalysis, creditAtResolvedBeta, type DefenseInstrument } from "@/lib/compute/hedging";
import { computePortfolioGreeks } from "@/lib/compute/options-greeks";
import { todayET, addDays } from "@/lib/calendar/date-utils";

// Two Defense defects (review 2026-11-23). Synthetic symbols, round figures.
//
// BUG 6: on the beta route a leveraged or inverse fund's leverage was applied
// twice. The orchestrator already multiplies the fund's exposure by its
// stored signed factor (theme T2); the measured beta of the fund's OWN price
// history already carries that leverage too (a -1x fund regresses at about
// -1, a -3x fund at about -3). Notional x factor x beta squared the leverage
// and flipped the sign of every inverse hedge. The fix divides the measured
// beta by the factor already applied: the beta of the tracked index.
//
// BUG 7: on the Greeks path an option's delta-notional exposure and theta were
// left in the underlying's NATIVE currency, while the fallback path (market
// value) was converted to USD.

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const today = todayET();

let db: Database.Database;
let acct: number;

function fresh() {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  db.prepare("INSERT INTO accounts (name) VALUES ('Taxable')").run();
  acct = (db.prepare("SELECT id FROM accounts WHERE name='Taxable'").get() as { id: number }).id;
}

interface SecOpts {
  type?: string;
  sector?: string | null;
  fundCategory?: string | null;
  currency?: string;
  leverageFactor?: number | null;
  name?: string;
}

function sec(symbol: string, o: SecOpts = {}): number {
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, sector, fund_category, currency, leverage_factor, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol,
      o.name ?? symbol,
      o.type ?? "Stock",
      o.sector ?? null,
      o.fundCategory ?? null,
      o.currency ?? "USD",
      o.leverageFactor ?? null,
      `t:${symbol}`
    ).lastInsertRowid as number;
}

function price(sid: number, close: number) {
  db.prepare("INSERT INTO prices (security_id, close_price, date, source) VALUES (?, ?, ?, 'test')").run(sid, close, today);
}

function hold(sid: number, qty: number, close: number) {
  db.prepare("INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, ?)").run(
    acct,
    sid,
    qty,
    qty * close,
    today
  );
  price(sid, close);
}

function option(under: string, type: "PUT" | "CALL", strike: number, qty: number, close: number, currency = "USD"): number {
  const expiry = addDays(today, 180);
  const tag = expiry.replace(/-/g, "").slice(2);
  const sid = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier, currency)
       VALUES (?, ?, 'Option', ?, ?, ?, ?, 100, ?)`
    )
    .run(`${under.padEnd(6)}${tag}${type[0]}${String(strike * 1000).padStart(8, "0")}`, `${under} ${type}`, under, type, strike, expiry, currency)
    .lastInsertRowid as number;
  hold(sid, qty, close);
  return sid;
}

/** A published beta (the cache only holds betas past the house gate). */
function storedBeta(sid: number, beta: number) {
  db.prepare("INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, 60, ?, datetime('now'))").run(sid, beta);
}

describe("creditAtResolvedBeta: a factor already applied to the notional is not applied again", () => {
  it("divides the measured beta by the applied factor", () => {
    // $30,000 of index notional (a $10,000 -3x fund); the fund's own beta -3
    // is three times the index's beta of 1, with the sign of the factor.
    expect(creditAtResolvedBeta(30_000, { beta: -3, source: "cached" }, -3)).toEqual({ credited: 30_000 });
    expect(creditAtResolvedBeta(30_000, { beta: 3.6, source: "computed" }, 3)).toEqual({ credited: 36_000 });
  });

  it("an ordinary fund (no factor) is unchanged", () => {
    expect(creditAtResolvedBeta(10_000, { beta: 1.25, source: "cached" })).toEqual({ credited: 12_500 });
    expect(creditAtResolvedBeta(10_000, { beta: 1.25, source: "cached" }, null)).toEqual({ credited: 12_500 });
  });

  it("an unmeasured beta is still not credited, factor or not (ruling 19 = B)", () => {
    const r = creditAtResolvedBeta(10_000, { beta: null, source: "unmeasured", reason: "no_history" }, -3);
    expect("notCreditedReason" in r).toBe(true);
  });
});

describe("BUG 6: an inverse fund held against a long book scores POSITIVE protection", () => {
  // Long $50,000 of an ordinary stock, plus $10,000 of an inverse ETF with
  // no look-through weights and no geography: it reaches the whole-book beta
  // route (proxyFundVerdict answers "unchanged" for a leveraged fund).
  function seed(factor: number, beta: number) {
    fresh();
    const aaa = sec("AAA", { sector: "Technology" });
    hold(aaa, 500, 100);
    const zzi = sec("ZZI", {
      type: "ETF",
      fundCategory: "Leveraged/Inverse",
      name: `ZZ ${Math.abs(factor)}X INVERSE INDEX FUND`,
      leverageFactor: factor,
    });
    hold(zzi, 100, 100);
    storedBeta(zzi, beta);
  }

  it("a: -1x fund, measured beta -1: +20%, was -20%", () => {
    seed(-1, -1);
    const r = computeDefenseAnalysis(db, [acct]);
    const proxy = r.proxies.find((p) => p.underlying === "ZZI")!;
    expect(proxy.route).toBe("beta");
    // $10,000 x -1 = -$10,000 of index exposure; protective notional $10,000;
    // credited at the index beta (-1 / -1 = 1): $10,000 over $50,000 long.
    expect(proxy.protectiveNotional).toBeCloseTo(10_000, 6);
    expect(sum(proxy.creditedTo.map((c) => c.credited))).toBeCloseTo(10_000, 6);
    expect(r.summary.longExposure).toBeCloseTo(50_000, 6);
    expect(r.summary.protectionRatio).toBeCloseTo(0.2, 10);
  });

  it("b: -3x fund, measured beta -3: +60%, was -180%", () => {
    seed(-3, -3);
    const r = computeDefenseAnalysis(db, [acct]);
    const proxy = r.proxies.find((p) => p.underlying === "ZZI")!;
    expect(proxy.route).toBe("beta");
    // $10,000 x -3 = $30,000 protective notional, at index beta -3 / -3 = 1.
    expect(proxy.protectiveNotional).toBeCloseTo(30_000, 6);
    expect(r.summary.protectionRatio).toBeCloseTo(0.6, 10);
  });

  it("the totals still reconcile: long-side + short-side = every credit", () => {
    seed(-3, -3);
    const r = computeDefenseAnalysis(db, [acct]);
    const every =
      sum(r.pairs.map((p) => p.offsetCredited)) + sum(r.proxies.flatMap((p) => p.creditedTo.map((c) => c.credited)));
    expect(r.summary.protectiveNotional + r.summary.shortSideHedgeNotional).toBeCloseTo(every, 9);
    expect(r.summary.notCreditedCount).toBe(0);
  });

  it("an inverse fund with no usable factor keeps the stopgap: held out, disclosed", () => {
    fresh();
    const aaa = sec("AAA", { sector: "Technology" });
    hold(aaa, 500, 100);
    const zzi = sec("ZZI", { type: "ETF", fundCategory: "Leveraged/Inverse", name: "ZZ INVERSE INDEX FUND", leverageFactor: null });
    hold(zzi, 100, 100);
    storedBeta(zzi, -1);
    const r = computeDefenseAnalysis(db, [acct]);
    expect(r.leveragedFundsUnmodelled.symbols).toEqual(["ZZI"]);
    expect(r.proxies.find((p) => p.underlying === "ZZI")).toBeUndefined();
    expect(r.summary.protectiveNotional).toBe(0);
  });
});

describe("BUG 6 c: a put on a +3x fund is credited at the index beta, not 3 x 3", () => {
  it("credit = |delta x spot x multiplier x contracts| x 3 x (3 / 3)", () => {
    fresh();
    const aaa = sec("AAA", { sector: "Technology" });
    hold(aaa, 500, 100);
    // The fund itself is NOT held: its put has no core to pair with, so it is
    // a no_core_etf proxy candidate on the beta route.
    const zzb = sec("ZZB", { type: "ETF", fundCategory: "Leveraged/Inverse", name: "ZZ 3X BULL INDEX FUND", leverageFactor: 3 });
    price(zzb, 100);
    storedBeta(zzb, 3);
    option("ZZB", "PUT", 95, 1, 6);

    const r = computeDefenseAnalysis(db, [acct]);
    const proxy = r.proxies.find((p) => p.underlying === "ZZB")!;
    expect(proxy.route).toBe("beta");
    const put = proxy.instruments.find((i) => i.isOption)! as DefenseInstrument;
    // The instrument's exposure is the put's delta-notional in the fund, times
    // the factor 3, which converts it into index notional:
    //   delta x 100 (spot) x 100 (multiplier) x 1 contract x 3.
    expect(put.exposure).toBeCloseTo(put.delta! * 100 * 100 * 1 * 3, 6);
    // Before the fix the credit was |exposure| x beta 3 = nine times the put's
    // fund delta-notional (about 68% of the $50,000 book). The fund's beta of 3
    // already holds the same leverage, so the credit is |exposure| x 3 / 3 =
    // |exposure|: three times the fund delta-notional, a third of the old
    // figure (about 23%).
    const credited = sum(proxy.creditedTo.map((c) => c.credited));
    expect(credited).toBeCloseTo(Math.abs(put.exposure), 6);
    expect(r.summary.protectionRatio).toBeCloseTo(Math.abs(put.exposure) / 50_000, 10);
  });
});

describe("BUG 7: the Greeks path converts option exposure and theta to USD", () => {
  const JPY = 0.0067;

  beforeEach(() => {
    fresh();
    db.prepare("INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('JPY', ?, ?, 'test')").run(JPY, today);
    // 100 shares of a yen stock at 3,000 yen, with one yen put against them.
    const zzj = sec("ZZJ", { sector: "Industrials", currency: "JPY" });
    hold(zzj, 100, 3000);
    option("ZZJ", "PUT", 2800, 1, 50, "JPY");
  });

  it("exposure and theta equal the native Greeks figure x usd_per_unit", () => {
    const g = computePortfolioGreeks(db, { accountId: acct }).positions.find((p) => p.underlying === "ZZJ")!;
    expect(g.greeks).not.toBeNull();
    const nativeExposure = g.greeks!.delta * g.underlyingPrice * g.multiplier * g.quantity;
    const nativeTheta = g.greeks!.theta * g.multiplier * g.quantity;

    const r = computeDefenseAnalysis(db, [acct]);
    const pair = r.pairs.find((p) => p.underlying === "ZZJ")!;
    const put = pair.instruments.find((i) => i.isOption)!;
    const shares = pair.instruments.find((i) => !i.isOption)!;
    expect(put.greeksAvailable).toBe(true);
    expect(put.exposure).toBeCloseTo(nativeExposure * JPY, 6);
    expect(put.thetaPerDay!).toBeCloseTo(nativeTheta * JPY, 6);
    // The shares were already converted by the holdings query (once).
    expect(shares.exposure).toBeCloseTo(100 * 3000 * JPY, 6);
  });
});
