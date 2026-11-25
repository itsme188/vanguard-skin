import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { putPrice, callPrice, yearsToExpiry } from "@/lib/compute/options-greeks";
import { getRiskFreeRate } from "@/lib/queries/risk-free-rate";
import {
  buildTrialEntry,
  checkTrialSecurity,
  lookupTrialSecurity,
  solveTrialEntry,
  trialCrossing,
  trialHoldingsByAccount,
  trialShortfalls,
  trialValuationPrice,
} from "@/lib/compute/gains-at-risk-trial";
import { computeGainsAtRisk, GAINS_AT_RISK_CASE_KEYS, type TrialPositionDraft, type TrialPositionInput } from "@/lib/compute/gains-at-risk";
import { loadScenarioPositionsByAccount } from "@/lib/compute/scenario-positions";

// Trial positions (Gains at risk step 2): the entry helpers. Synthetic ZZ
// tickers and round numbers; clock 2026-11-10 15:00 UTC (10:00 Eastern).

const NOW = "2026-11-10T15:00:00Z";
const today = "2026-11-10";
const now = new Date(NOW);

let db: Database.Database;
let nextId = 100;
let nextKey = 0;
let nextConId = 7000;

function addSecurity(f: {
  symbol: string;
  type: string;
  name?: string;
  currency?: string;
  underlying?: string;
  strike?: number;
  expiry?: string;
  optionType?: string;
  multiplier?: number;
  conId?: boolean;
}): number {
  const id = nextId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, currency, underlying_symbol, strike_price, expiration_date,
       option_type, multiplier, ib_con_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    f.symbol,
    f.name ?? null,
    f.type,
    f.currency ?? "USD",
    f.underlying ?? null,
    f.strike ?? null,
    f.expiry ?? null,
    f.optionType ?? null,
    f.multiplier ?? 1,
    f.conId === false ? null : nextConId++,
  );
  return id;
}

function price(id: number, close: number, date = "2026-11-09"): void {
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')").run(id, date, close);
}

function bar(id: number, date: string, close: number): void {
  db.prepare(
    `INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume)
     VALUES (?, ?, '1 day', ?, ?, ?, ?, 1000)`,
  ).run(id, date, close, close, close, close);
}

function hold(id: number, qty: number, account = 1, date = today): void {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (?, ?, ?, ?, ?)",
  ).run(account, id, date, qty, `trial-${++nextKey}`);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  nextId = 100;
  nextKey = 0;
  nextConId = 7000;
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("solveTrialEntry", () => {
  it("solveTrialEntry recovers the volatility a price was made from", () => {
    const r = getRiskFreeRate(db);
    const T = yearsToExpiry("2027-01-15", today, now);
    const p = putPrice(100, 95, T, r, 0.3);
    const out = solveTrialEntry({ right: "put", strike: 95, expiry: "2027-01-15", price: p, underlyingPrice: 100, riskFreeRate: r, today, now });
    expect(out.ok).toBe(true);
    if (out.ok) expect(Math.abs(out.volatility - 0.3)).toBeLessThan(1e-6);
    const c = callPrice(100, 110, T, r, 0.45);
    const outC = solveTrialEntry({ right: "call", strike: 110, expiry: "2027-01-15", price: c, underlyingPrice: 100, riskFreeRate: r, today, now });
    expect(outC.ok && Math.abs(outC.volatility - 0.45) < 1e-6).toBe(true);
    // The solved volatility reprices the typed price to well under a cent per contract.
    if (out.ok) expect(Math.abs(putPrice(100, 95, T, r, out.volatility) - p)).toBeLessThan(1e-9);
  });

  it("solveTrialEntry refuses a price below intrinsic and one no volatility explains; never uses a broker volatility", () => {
    const r = getRiskFreeRate(db);
    const base = { expiry: "2027-01-15", underlyingPrice: 100, riskFreeRate: r, today, now };
    expect(solveTrialEntry({ ...base, right: "put", strike: 120, price: 15 })).toEqual({ ok: false, reason: "below-intrinsic" });
    expect(solveTrialEntry({ ...base, right: "call", strike: 80, price: 19.5 })).toEqual({ ok: false, reason: "below-intrinsic" });
    // A call worth more than the stock itself: no volatility explains it, and nothing falls back.
    expect(solveTrialEntry({ ...base, right: "call", strike: 100, price: 150 })).toEqual({ ok: false, reason: "not-solvable" });
    expect(solveTrialEntry({ ...base, right: "put", strike: 95, price: 0 })).toEqual({ ok: false, reason: "not-solvable" });
    expect(solveTrialEntry({ ...base, right: "put", strike: 95, price: 3, expiry: "2026-11-09" })).toEqual({ ok: false, reason: "expired" });
    expect(solveTrialEntry({ ...base, right: "put", strike: 95, price: 3, expiry: "2027-02-30" })).toEqual({ ok: false, reason: "no-option-terms" });
    // Expiry day after the 16:00 Eastern close is expired.
    expect(
      solveTrialEntry({ ...base, right: "put", strike: 95, price: 3, expiry: today, now: new Date("2026-11-10T21:30:00Z") }),
    ).toEqual({ ok: false, reason: "expired" });
  });
});

describe("buildTrialEntry", () => {
  it("buildTrialEntry: unknown symbol, an option symbol, a non-USD underlying", () => {
    addSecurity({ symbol: "ZZOPT", type: "Option", underlying: "ZZA", strike: 50, expiry: "2027-01-15", optionType: "PUT", conId: false });
    const fx = addSecurity({ symbol: "ZZFX", type: "Stock", currency: "ZZD" });
    price(fx, 20);
    const shares = { kind: "shares" as const, side: "buy" as const, quantity: 10, price: 20 };
    expect(buildTrialEntry(db, { ...shares, symbol: "zzno" }, { today, now })).toEqual({ ok: false, reason: "unknown-symbol", symbol: "ZZNO" });
    expect(buildTrialEntry(db, { ...shares, symbol: "ZZOPT" }, { today, now })).toEqual({ ok: false, reason: "is-an-option", symbol: "ZZOPT" });
    expect(buildTrialEntry(db, { ...shares, symbol: "ZZFX" }, { today, now })).toEqual({ ok: false, reason: "foreign-currency", symbol: "ZZFX" });
    const opt = { kind: "option" as const, right: "put" as const, side: "buy" as const, expiry: "2027-01-15", strike: 18, contracts: 1, price: 1 };
    expect(buildTrialEntry(db, { ...opt, symbol: "ZZFX" }, { today, now })).toMatchObject({ ok: false, reason: "foreign-currency" });
  });

  it("buildTrialEntry takes the quote's underlying price, else the newer stored price or bar, and flags a stale close", () => {
    const u = addSecurity({ symbol: "ZZU", type: "Stock", name: "ZZ Underlying" });
    price(u, 98, "2026-11-03");
    bar(u, "2026-11-05", 100);
    const r = getRiskFreeRate(db);
    const T = yearsToExpiry("2027-01-15", today, now);
    const p = putPrice(100, 95, T, r, 0.3);
    const req = { kind: "option" as const, symbol: "ZZU", right: "put" as const, side: "buy" as const, expiry: "2027-01-15", strike: 95, contracts: 2, price: p };
    const fromBar = buildTrialEntry(db, req, { today, now });
    expect(fromBar).toMatchObject({
      ok: true,
      symbol: "ZZU",
      name: "ZZ Underlying",
      underlyingPrice: 100,
      underlyingPriceDate: "2026-11-05",
      underlyingPriceSource: "daily-bar",
      staleCloseDate: "2026-11-05",
      holdingsAtAddByAccount: {},
      hasContractId: true,
    });
    if (!fromBar.ok || fromBar.position.kind !== "option") throw new Error("must build an option");
    expect(fromBar.position).toMatchObject({ underlyingSecurityId: u, pricePaid: p, entryUnderlyingPrice: 100, valuationPriceAtEntry: 100, contracts: 2, strike: 95 });
    expect(Math.abs(fromBar.position.entryVolatility - 0.3)).toBeLessThan(1e-6);

    const quoted = buildTrialEntry(db, { ...req, quotedUnderlyingPrice: 100 }, { today, now });
    expect(quoted).toMatchObject({ ok: true, underlyingPrice: 100, underlyingPriceDate: today, underlyingPriceSource: "quote", staleCloseDate: null });
    // A quote off the app's own price: the volatility is solved at the quote, and the app's price is recorded beside it.
    const off = buildTrialEntry(db, { ...req, price: putPrice(104, 95, T, r, 0.3), quotedUnderlyingPrice: 104 }, { today, now });
    expect(off).toMatchObject({ ok: true, underlyingPrice: 104, position: { entryUnderlyingPrice: 104, valuationPriceAtEntry: 100 } });
    if (off.ok && off.position.kind === "option") expect(Math.abs(off.position.entryVolatility - 0.3)).toBeLessThan(1e-6);

    // A name held nowhere reads its latest daily bar before a stored price (one rule with the engine).
    price(u, 101, "2026-11-09");
    expect(buildTrialEntry(db, { ...req, quotedUnderlyingPrice: undefined }, { today, now })).toMatchObject({
      ok: true,
      underlyingPrice: 100,
      underlyingPriceSource: "daily-bar",
    });
    // Held in any account: the book's stored price, the row the position loader reads.
    hold(u, 10, 3);
    const stored = buildTrialEntry(db, { kind: "shares", symbol: "ZZU", side: "sell", quantity: 5, price: 101 }, { today, now });
    expect(stored).toMatchObject({
      ok: true,
      underlyingPrice: 101,
      underlyingPriceDate: "2026-11-09",
      underlyingPriceSource: "book",
      staleCloseDate: null,
      holdingsAtAddByAccount: { 3: 10 },
      position: { kind: "shares", securityId: u, side: "sell", quantity: 5, price: 101 },
    });

    // Refusals at the click: an expiry before today, below intrinsic, no price at all.
    expect(buildTrialEntry(db, { ...req, expiry: "2026-11-09" }, { today, now })).toMatchObject({ ok: false, reason: "expired" });
    expect(buildTrialEntry(db, { ...req, strike: 130, price: 20 }, { today, now })).toMatchObject({ ok: false, reason: "below-intrinsic" });
    addSecurity({ symbol: "ZZNP", type: "Stock" });
    expect(buildTrialEntry(db, { ...req, symbol: "ZZNP" }, { today, now })).toMatchObject({ ok: false, reason: "no-underlying-price" });
  });

  it("holdings snapshot is per account and counts the exact contract only", () => {
    const u = addSecurity({ symbol: "ZZU", type: "Stock" });
    price(u, 100);
    const put = addSecurity({ symbol: "ZZU P95 2027-01-15", type: "Option", underlying: "ZZU", strike: 95, expiry: "20270115", optionType: "P", multiplier: 100, conId: false });
    const other = addSecurity({ symbol: "ZZU P90 2027-01-15", type: "Option", underlying: "ZZU", strike: 90, expiry: "2027-01-15", optionType: "PUT", multiplier: 100, conId: false });
    const call = addSecurity({ symbol: "ZZU C95 2027-01-15", type: "Option", underlying: "ZZU", strike: 95, expiry: "2027-01-15", optionType: "CALL", multiplier: 100, conId: false });
    hold(put, 10, 1, "2026-11-09");
    hold(other, 4, 2);
    hold(call, 3, 2);
    hold(u, 50, 3);
    const position: TrialPositionDraft = {
      kind: "option", underlyingSecurityId: u, right: "put", side: "buy", expiry: "2027-01-15", strike: 95, contracts: 1,
      pricePaid: 3, entryUnderlyingPrice: 100, valuationPriceAtEntry: 100, entryVolatility: 0.3,
    };
    const atAdd = trialHoldingsByAccount(db, position);
    expect(atAdd).toEqual({ 1: 10 });
    expect(trialHoldingsByAccount(db, { kind: "shares", securityId: u, side: "sell", quantity: 1, price: 100 })).toEqual({ 3: 50 });
    // Since the click: A1 +10 and A2 -10. The total is unchanged; the maps differ.
    hold(put, 20, 1);
    hold(put, -10, 2);
    const later = trialHoldingsByAccount(db, position);
    expect(later).toEqual({ 1: 20, 2: -10 });
    expect(later).not.toEqual(atAdd);
    // A closed position (a zero row) is omitted.
    hold(put, 0, 2, "2026-11-11");
    expect(trialHoldingsByAccount(db, position)).toEqual({ 1: 20 });
  });
});

describe("lookupTrialSecurity and checkTrialSecurity", () => {
  it("lookup's price is the valuation price: stored 500 and bar 505 on a name no account holds reads 505", () => {
    const n = addSecurity({ symbol: "ZZV", type: "Stock" });
    price(n, 500, "2026-11-09");
    bar(n, "2026-11-06", 505);
    expect(lookupTrialSecurity(db, "ZZV", { today })).toMatchObject({ price: 505, priceDate: "2026-11-06", priceSource: "daily-bar" });
    expect(trialValuationPrice(db, n, { today })).toEqual({ price: 505, date: "2026-11-06", source: "daily-bar" });
    hold(n, 1, 2);
    expect(lookupTrialSecurity(db, "ZZV", { today })).toMatchObject({ price: 500, priceDate: "2026-11-09", priceSource: "book" });
    expect(lookupTrialSecurity(db, "ZZNOPX", { today })).toBeNull();
    const bare = addSecurity({ symbol: "ZZBARE", type: "Stock" });
    expect(lookupTrialSecurity(db, "ZZBARE", { today })).toMatchObject({ securityId: bare, price: null, priceDate: null, priceSource: null });
  });

  it("lookup reports priced daily bars: a known, priced security with zero bars", () => {
    const n = addSecurity({ symbol: "ZZN", type: "Stock", name: "ZZ Name" });
    price(n, 40);
    expect(lookupTrialSecurity(db, "ZZN", { today })).toMatchObject({ price: 40, dailyBars: { count: 0, through: null } });
    expect(lookupTrialSecurity(db, " zzn ", { today })).toEqual({
      securityId: n,
      symbol: "ZZN",
      name: "ZZ Name",
      price: 40,
      priceDate: "2026-11-09",
      priceSource: "stored-price",
      hasContractId: true,
      dailyBars: { count: 0, through: null },
    });
    bar(n, "2026-11-06", 39);
    bar(n, "2026-11-09", 40);
    bar(n, today, 41); // today's bar is outside [today - window, today)
    bar(n, "2020-01-02", 10); // older than the window
    expect(lookupTrialSecurity(db, "ZZN", { today })?.dailyBars).toEqual({ count: 2, through: "2026-11-09" });
    // The lookup's price is the price the engine marks against (one rule): here today's bar, the latest.
    expect(lookupTrialSecurity(db, "ZZN", { today })).toMatchObject({ price: 41, priceDate: today, priceSource: "daily-bar" });
    addSecurity({ symbol: "ZZOPT", type: "Option", conId: false });
    expect(lookupTrialSecurity(db, "ZZOPT", { today })).toBeNull();
    expect(lookupTrialSecurity(db, "ZZNONE", { today })).toBeNull();
  });

  it("checkTrialSecurity: unknown id, an option row, a non-USD row, no contract id when required", () => {
    const ok = addSecurity({ symbol: "ZZOK", type: "Stock" });
    const opt = addSecurity({ symbol: "ZZOK P1", type: "Option", conId: false });
    const fx = addSecurity({ symbol: "ZZFX", type: "Stock", currency: "ZZD" });
    const noCon = addSecurity({ symbol: "ZZNC", type: "ETF", conId: false });
    expect(checkTrialSecurity(db, 9999, { requireContractId: false })).toEqual({ ok: false, reason: "not-found" });
    expect(checkTrialSecurity(db, opt, { requireContractId: false })).toEqual({ ok: false, reason: "is-an-option" });
    expect(checkTrialSecurity(db, fx, { requireContractId: false })).toEqual({ ok: false, reason: "foreign-currency" });
    expect(checkTrialSecurity(db, noCon, { requireContractId: true })).toEqual({ ok: false, reason: "no-contract-id" });
    expect(checkTrialSecurity(db, noCon, { requireContractId: false })).toEqual({ ok: true, symbol: "ZZNC", ibConId: null });
    expect(checkTrialSecurity(db, ok, { requireContractId: true })).toMatchObject({ ok: true, symbol: "ZZOK" });
  });
});

describe("trialValuationPrice", () => {
  it("held anywhere: the stored price the loader reads; else the latest daily bar; else the stored price; else none", () => {
    const b = addSecurity({ symbol: "ZZB", type: "Stock" });
    price(b, 50);
    bar(b, "2026-11-06", 48);
    // Held only through a put, in one account: the book's price, whatever scope is stressed.
    const put = addSecurity({ symbol: "ZZB P45 2027-01-15", type: "Option", underlying: "ZZB", strike: 45, expiry: "2027-01-15", optionType: "PUT", multiplier: 100, conId: false });
    hold(put, 1, 3);
    expect(trialValuationPrice(db, b, { today })).toEqual({ price: 50, date: "2026-11-09", source: "book" });
    // The loader's own underlying price for that put is the same figure.
    const loaded = loadScenarioPositionsByAccount(db, undefined, { today });
    expect(loaded.find((r) => r.security_id === put)?.underlying_price).toBe(50);
    // Held nowhere, with bars: the latest priced daily close.
    const c = addSecurity({ symbol: "ZZC", type: "Stock" });
    price(c, 30);
    bar(c, "2026-11-05", 29);
    expect(trialValuationPrice(db, c, { today })).toEqual({ price: 29, date: "2026-11-05", source: "daily-bar" });
    // An expired option on it does not make it held.
    const old = addSecurity({ symbol: "ZZC P25 2026-10-16", type: "Option", underlying: "ZZC", strike: 25, expiry: "2026-10-16", optionType: "PUT", multiplier: 100, conId: false });
    hold(old, 1, 1, "2026-10-15");
    expect(trialValuationPrice(db, c, { today })?.source).toBe("daily-bar");
    // Held nowhere, no bars, a stored price: that price with its own date.
    const d = addSecurity({ symbol: "ZZD", type: "Stock" });
    price(d, 12, "2026-10-30");
    expect(trialValuationPrice(db, d, { today })).toEqual({ price: 12, date: "2026-10-30", source: "stored-price" });
    // Held, but never priced: the bar.
    const e = addSecurity({ symbol: "ZZE", type: "Stock" });
    hold(e, 5, 2);
    bar(e, "2026-11-09", 7);
    expect(trialValuationPrice(db, e, { today })).toEqual({ price: 7, date: "2026-11-09", source: "daily-bar" });
    const none = addSecurity({ symbol: "ZZX", type: "Stock" });
    expect(trialValuationPrice(db, none, { today })).toBeNull();
  });
});

describe("trialShortfalls", () => {
  const sale = (id: string, securityId: number, quantity: number): TrialPositionInput => ({ kind: "shares", id, securityId, side: "sell", quantity, price: 10 });
  const buy = (id: string, securityId: number, quantity: number): TrialPositionInput => ({ kind: "shares", id, securityId, side: "buy", quantity, price: 10 });

  it("walks the sales in list order after every account's holding and every trial buy", () => {
    const one = trialShortfalls([sale("a", 1, 75), sale("b", 1, 75)], new Map([[1, 100]]));
    expect([...one.bySaleId]).toEqual([["a", 0], ["b", 50]]);
    expect([...one.byName]).toEqual([[1, 50]]);
    const two = trialShortfalls([buy("c", 1, 50), sale("d", 1, 120)], new Map([[1, 100]]));
    expect([...two.bySaleId]).toEqual([["d", 0]]);
    expect([...two.byName]).toEqual([]);
    // A buy after the sale still covers it (the whole list counts); a name not held starts at 0.
    const three = trialShortfalls([sale("e", 2, 30), buy("f", 2, 10)], new Map());
    expect([...three.bySaleId]).toEqual([["e", 20]]);
    expect([...three.byName]).toEqual([[2, 20]]);
    // A name already held short: only the part the trial sales cause.
    const four = trialShortfalls([sale("g", 3, 100)], new Map([[3, -50]]));
    expect([...four.bySaleId]).toEqual([["g", 100]]);
    expect([...four.byName]).toEqual([[3, 100]]);
  });
});

describe("trialCrossing", () => {
  it("trialCrossing covers every pattern", () => {
    expect(trialCrossing([0, -0.05, -0.1], [-100, -20, 60])).toEqual({ kind: "pays-beyond", move: expect.closeTo(-0.0625, 9) });
    expect(trialCrossing([0, -0.05, -0.1], [10, 20, 30])).toEqual({ kind: "better-at-every-move" });
    expect(trialCrossing([0, -0.05, -0.1], [-10, -20, -30])).toEqual({ kind: "worse-at-every-move", deepestMove: -0.1 });
    expect(trialCrossing([0, -0.05, -0.1], [40, 10, -30])).toEqual({ kind: "helps-until", move: expect.closeTo(-0.0625, 9) });
    expect(trialCrossing([0, -0.05, -0.1, -0.15], [-10, 10, -10, 10])).toMatchObject({
      kind: "changes-more-than-once",
      firstHelpFrom: expect.closeTo(-0.025, 9),
      firstHelpTo: expect.closeTo(-0.075, 9),
    });
    expect(trialCrossing([0, -0.05], [0, 0])).toEqual({ kind: "no-trial-effect" });
    expect(trialCrossing([0, -0.05], [0, 20])).toEqual({ kind: "pays-beyond", move: 0 }); // exactly 0 is not better
  });

  it("reads only the moves at or below 0, ordered by deepening fall, whatever the input order", () => {
    expect(trialCrossing([0.1, -0.1, 0, -0.05], [999, 60, -100, -20])).toEqual({ kind: "pays-beyond", move: expect.closeTo(-0.0625, 9) });
    expect(trialCrossing([0.1, 0.05], [1, 2])).toEqual({ kind: "no-trial-effect" });
    // A point at exactly zero after help is the boundary itself.
    expect(trialCrossing([0, -0.05, -0.1], [10, 0, -5])).toEqual({ kind: "helps-until", move: -0.05 });
    // Starting better: the first help interval starts at the first move.
    expect(trialCrossing([0, -0.05, -0.1], [10, -10, 10])).toMatchObject({
      kind: "changes-more-than-once",
      firstHelpFrom: 0,
      firstHelpTo: expect.closeTo(-0.025, 9),
    });
  });
});

// ─── Step 3: the crossing by the driver's direction (D5) ─────────

describe("trialCrossing, rise (step 3)", () => {
  it("T21 trialCrossing rise mirrors every fall pattern", () => {
    expect(trialCrossing([0, 0.05, 0.1], [-100, -20, 60], "rise")).toEqual({ kind: "pays-beyond", move: expect.closeTo(0.0625, 9) });
    expect(trialCrossing([0, 0.05, 0.1], [-10, -20, -30], "rise")).toEqual({ kind: "worse-at-every-move", deepestMove: 0.1 });
    expect(trialCrossing([0, 0.05, 0.1], [40, 10, -30], "rise")).toEqual({ kind: "helps-until", move: expect.closeTo(0.0625, 9) });
    expect(trialCrossing([0, -0.05], [-10, 20], "rise")).toEqual({ kind: "worse-at-every-move", deepestMove: 0 }); // falls ignored
    expect(trialCrossing([0, -0.05, -0.1], [-100, -20, 60])).toEqual({ kind: "pays-beyond", move: expect.closeTo(-0.0625, 9) }); // default fall unchanged
    expect(trialCrossing([0, 0.05, 0.1], [10, 20, 30], "rise")).toEqual({ kind: "better-at-every-move" });
    expect(trialCrossing([0, 0.05, 0.1, 0.15], [-10, 10, -10, 10], "rise")).toMatchObject({
      kind: "changes-more-than-once",
      firstHelpFrom: expect.closeTo(0.025, 9),
      firstHelpTo: expect.closeTo(0.075, 9),
    });
    expect(trialCrossing([0, 0.05], [0, 0], "rise")).toEqual({ kind: "no-trial-effect" });
    expect(trialCrossing([0, 0.05], [0, 20], "rise")).toEqual({ kind: "pays-beyond", move: 0 });
    // Order of the input does not matter; only moves at or above 0 are read.
    expect(trialCrossing([-0.1, 0.1, 0, 0.05], [999, 60, -100, -20], "rise")).toEqual({ kind: "pays-beyond", move: expect.closeTo(0.0625, 9) });
    expect(trialCrossing([-0.1, -0.05], [1, 2], "rise")).toEqual({ kind: "no-trial-effect" });
  });
});

describe("computeGainsAtRisk: the trial crossing follows the driver's direction (step 3)", () => {
  const expiry = "2027-01-15";
  function trial(id: string, sec: number, right: "put" | "call", S: number, K: number): TrialPositionInput {
    const T = yearsToExpiry(expiry, today, now);
    const r = getRiskFreeRate(db);
    const p = right === "put" ? putPrice(S, K, T, r, 0.3) : callPrice(S, K, T, r, 0.3);
    const s = solveTrialEntry({ right, strike: K, expiry, price: p, underlyingPrice: S, riskFreeRate: r, today, now });
    if (!s.ok) throw new Error("solve");
    return { kind: "option", id, underlyingSecurityId: sec, right, side: "buy", expiry, strike: K, contracts: 1, pricePaid: p, entryUnderlyingPrice: S, valuationPriceAtEntry: S, entryVolatility: s.volatility };
  }
  const moves = [-0.2, -0.1, 0, 0.1, 0.2];

  it("T21 engine: selectedMove 0 and -0.2 read fall, +0.2 reads rise; index mode reads fall with no crossingDirection key", () => {
    const a = addSecurity({ symbol: "ZZA", type: "Stock" });
    price(a, 100);
    hold(a, 10);
    const trialPositions = [trial("p", a, "put", 100, 95)];
    const driver = { kind: "single-name" as const, symbol: "ZZA", securityId: a };
    for (const [selectedMove, dir] of [[0, "fall"], [-0.2, "fall"], [0.2, "rise"]] as const) {
      const r = computeGainsAtRisk(db, { driverSymbol: "QQQ", driver, valuationDate: today, moves, volChangePoints: 0, trialPositions, selectedMove, today, now });
      for (const k of GAINS_AT_RISK_CASE_KEYS) {
        const c = r.trial!.cases[k];
        expect(c.crossingDirection).toBe(dir);
        expect(c.crossing).toEqual(trialCrossing(moves, c.moves.map((m) => m.trialPnlUsd), dir));
      }
    }
    // The bought put pays in a fall and does not in a rise.
    const fall = computeGainsAtRisk(db, { driverSymbol: "QQQ", driver, valuationDate: today, moves, volChangePoints: 0, trialPositions, selectedMove: -0.2, today, now });
    expect(fall.trial!.cases.measured.crossing.kind).toBe("pays-beyond");
    const rise = computeGainsAtRisk(db, { driverSymbol: "QQQ", driver, valuationDate: today, moves, volChangePoints: 0, trialPositions, selectedMove: 0.2, today, now });
    expect(rise.trial!.cases.measured.crossing).toEqual({ kind: "worse-at-every-move", deepestMove: 0.2 });
    // Index mode: falls only, no direction key, whatever the selected move.
    for (const selectedMove of [undefined, 0.1]) {
      const idx = computeGainsAtRisk(db, { driverSymbol: "ZZA", valuationDate: today, moves, volChangePoints: 0, trialPositions, selectedMove, today, now });
      for (const k of GAINS_AT_RISK_CASE_KEYS) {
        const c = idx.trial!.cases[k];
        expect("crossingDirection" in c).toBe(false);
        expect(c.crossing).toEqual(trialCrossing(moves, c.moves.map((m) => m.trialPnlUsd)));
      }
    }
  });

  it("T21 a call on an inverse fund on the driver (seeded) and a name with a negative owner figure (index mode) are read by the driver's direction, not their right", () => {
    const a = addSecurity({ symbol: "ZZA", type: "Stock" });
    price(a, 100);
    hold(a, 10);
    const inv = addSecurity({ symbol: "ZZI", type: "ETF", name: "ZZ UltraShort ZZA Fund" });
    db.prepare("UPDATE securities SET leverage_factor = -1 WHERE id = ?").run(inv);
    price(inv, 30);
    const driver = { kind: "single-name" as const, symbol: "ZZA", securityId: a };
    const calls = [trial("c", inv, "call", 30, 31)];
    const opts = { trackedIndexSeeds: { ZZI: "ZZA" } };
    const fall = computeGainsAtRisk(db, { driverSymbol: "QQQ", driver, valuationDate: today, moves, volChangePoints: 0, trialPositions: calls, selectedMove: -0.1, today, now }, opts);
    expect(fall.trial!.rows[0].betaSource).toBe("leveraged");
    expect(fall.trial!.cases.measured.crossingDirection).toBe("fall");
    // A call on an inverse fund pays as the driver FALLS.
    expect(fall.trial!.cases.measured.crossing).toEqual({ kind: "pays-beyond", move: 0 });
    const rise = computeGainsAtRisk(db, { driverSymbol: "QQQ", driver, valuationDate: today, moves, volChangePoints: 0, trialPositions: calls, selectedMove: 0.1, today, now }, opts);
    expect(rise.trial!.cases.measured.crossing).toEqual({ kind: "worse-at-every-move", deepestMove: 0.2 });

    // Index mode: a name the owner says moves against the index; a call on it pays in the index's fall.
    const m = addSecurity({ symbol: "ZZM", type: "Stock" });
    price(m, 50);
    const idx = computeGainsAtRisk(
      db,
      { driverSymbol: "QQQ", valuationDate: today, moves, volChangePoints: 0, trialPositions: [trial("m", m, "call", 50, 52)], betaOverrides: { [m]: -1 }, today, now },
    );
    expect(idx.trial!.rows[0].betaSource).toBe("owner");
    expect("crossingDirection" in idx.trial!.cases.measured).toBe(false);
    expect(idx.trial!.cases.measured.crossing).toEqual({ kind: "pays-beyond", move: 0 });
  });
});
