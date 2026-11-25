import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  findSingleNameDriver,
  listCandidateUnderlyings,
  hasUsableDriverPrice,
  listSingleNameDrivers,
  type SingleNameDriverEntry,
} from "@/lib/compute/gains-at-risk-drivers";

// Gains at risk step 3, task S1: the single-name driver list (P1) and the
// candidate underlying list (F8). Synthetic ZZ tickers only.

const TODAY = "2026-11-10";

let db: Database.Database;
let nextId = 100;
let nextKey = 0;
let nextConId = 9000;

function addSecurity(f: {
  symbol: string;
  type: string;
  name?: string;
  fundCategory?: string | null;
  currency?: string;
  underlying?: string;
  strike?: number;
  expiry?: string;
  optionType?: string;
  conId?: boolean;
}): number {
  const id = nextId++;
  db.prepare(
    `INSERT INTO securities (id, symbol, name, security_type, fund_category, currency, underlying_symbol, strike_price,
       expiration_date, option_type, multiplier, ib_con_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    f.symbol,
    f.name ?? null,
    f.type,
    f.fundCategory ?? null,
    f.currency ?? "USD",
    f.underlying ?? null,
    f.strike ?? null,
    f.expiry ?? null,
    f.optionType ?? null,
    f.type === "Option" ? 100 : 1,
    f.conId === false ? null : nextConId++,
  );
  return id;
}

function price(id: number, close: number, date = "2026-11-09"): void {
  db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')").run(id, date, close);
}

/** A non-option row with a stored price (a listed driver needs one). */
function priced(f: Parameters<typeof addSecurity>[0], close = 10): number {
  const id = addSecurity(f);
  price(id, close);
  return id;
}

function hold(id: number, qty: number, account = 1, date = TODAY): void {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (?, ?, ?, ?, ?)",
  ).run(account, id, date, qty, `drv-${++nextKey}`);
}

function option(underlying: string, expiry = "2027-01-15"): number {
  return addSecurity({ symbol: `${underlying} P10 ${expiry}`, type: "Option", underlying, strike: 10, expiry, optionType: "PUT", conId: false });
}

function watch(securityId: number, active = true): void {
  db.prepare("INSERT INTO watchlist (security_id, added_date, is_active) VALUES (?, ?, ?)").run(securityId, TODAY, active ? 1 : 0);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  nextId = 100;
  nextKey = 0;
  nextConId = 9000;
});

afterEach(() => {
  db.close();
});

describe("listSingleNameDrivers", () => {
  it("T20 lists held non-options, option underlyings with and without a row, and trial underlyings, with reasons in order", () => {
    const a = priced({ symbol: "ZZA", type: "Stock", name: "ZZ Alpha" });
    hold(a, 10, 1);
    hold(option("ZZA"), 1, 3); // ZZA: held and an option underlying
    const b = priced({ symbol: "ZZB", type: "ETF", name: "ZZ Beta Fund" });
    hold(option("ZZB"), -2, 3); // ZZB: only through an option (short)
    hold(option("ZZN"), 1); // ZZN: an underlying with no row has no price: left out
    const t = priced({ symbol: "ZZT", type: "Stock", conId: false });
    const s = priced({ symbol: "ZZS", type: "Stock" });
    hold(s, -5, 3); // held short counts
    hold(option("ZZX", "2026-11-06"), 1); // an expired option: its underlying is not listed
    const list = listSingleNameDrivers(db, { trialUnderlyingIds: [t, a, t], today: TODAY });
    expect(list).toEqual([
      { symbol: "ZZA", name: "ZZ Alpha", securityId: a, reasons: ["held", "option-underlying", "trial"], hasContractId: true },
      { symbol: "ZZB", name: "ZZ Beta Fund", securityId: b, reasons: ["option-underlying"], hasContractId: true },
      { symbol: "ZZS", name: null, securityId: s, reasons: ["held"], hasContractId: true },
      { symbol: "ZZT", name: null, securityId: t, reasons: ["trial"], hasContractId: false },
    ]);
  });

  it("leaves out a cash-equivalent fund and a bond; a security held in no account and not a trial is absent", () => {
    const mm = priced({ symbol: "ZZMM", type: "Mutual Fund", fundCategory: "Cash Equivalent" });
    hold(mm, 1000);
    const bond = priced({ symbol: "ZZBOND", type: "Bond" });
    hold(bond, 1000);
    const bondUnderlying = priced({ symbol: "ZZBD", type: " bond " });
    const a = priced({ symbol: "ZZA", type: "Stock" });
    hold(a, 10, 1, "2026-10-31");
    hold(a, 0, 1, TODAY); // sold: the latest row is zero
    addSecurity({ symbol: "ZZQ", type: "Stock" }); // never held
    const opt = option("ZZQQ");
    hold(opt, 0); // an option row at zero
    expect(listSingleNameDrivers(db, { trialUnderlyingIds: [mm, bond, bondUnderlying, opt], today: TODAY })).toEqual([]);
  });

  it("findSingleNameDriver by id and by symbol; a name not listed is null", () => {
    const a = priced({ symbol: "ZZA", type: "Stock" });
    hold(a, 10);
    const list: SingleNameDriverEntry[] = [
      ...listSingleNameDrivers(db, { trialUnderlyingIds: [], today: TODAY }),
      { symbol: "ZZN", name: null, securityId: null, reasons: ["option-underlying"], hasContractId: false },
    ];
    expect(findSingleNameDriver(list, { securityId: a })?.symbol).toBe("ZZA");
    expect(findSingleNameDriver(list, { symbol: " zzn " })).toMatchObject({ symbol: "ZZN", securityId: null });
    expect(findSingleNameDriver(list, { securityId: 4242 })).toBeNull();
    expect(findSingleNameDriver(list, { symbol: "ZZQ" })).toBeNull();
    expect(findSingleNameDriver(list, { symbol: "" })).toBeNull();
  });

  it("hasContractId false for a row with no ib_con_id", () => {
    const a = priced({ symbol: "ZZA", type: "Stock", conId: false });
    hold(a, 10);
    const list = listSingleNameDrivers(db, { trialUnderlyingIds: [], today: TODAY });
    expect(list.map((e) => [e.symbol, e.hasContractId])).toEqual([["ZZA", false]]);
  });

  it("fix 2: a name with no usable price is left out; an option underlying with no row is left out; a priced one is listed", () => {
    const noPx = addSecurity({ symbol: "ZZP", type: "Stock" }); // held, no price row
    hold(noPx, 10);
    const zeroPx = addSecurity({ symbol: "ZZZ", type: "Stock" });
    price(zeroPx, 0); // a zero close is no price
    hold(zeroPx, 10);
    const stale = addSecurity({ symbol: "ZZV", type: "Stock" });
    price(stale, 12, "2026-11-01");
    price(stale, 0, "2026-11-09"); // the latest row (the one the loader reads) is zero: an older good row does not count
    hold(stale, 10);
    const barOnly = addSecurity({ symbol: "ZZY", type: "Stock" }); // a daily bar but no stored price: the book cannot move it
    db.prepare(
      "INSERT INTO ohlcv_bars (security_id, bar_date, bar_size, open, high, low, close, volume) VALUES (?, '2026-11-06', '1 day', 5, 5, 5, 5, 100)",
    ).run(barOnly);
    hold(barOnly, 10);
    const u = addSecurity({ symbol: "ZZU", type: "Stock" }); // option underlying, no price
    hold(option("ZZU"), 1);
    hold(option("ZZN"), 1); // no row at all
    const ok = priced({ symbol: "ZZOK", type: "Stock" });
    hold(option("ZZOK"), 1);
    const trialNoPx = addSecurity({ symbol: "ZZTN", type: "Stock" });
    const list = listSingleNameDrivers(db, { trialUnderlyingIds: [trialNoPx, u], today: TODAY });
    expect(list.map((e) => e.symbol)).toEqual(["ZZOK"]);
    expect(list[0]).toMatchObject({ securityId: ok, reasons: ["option-underlying"] });
    for (const id of [noPx, zeroPx, stale, barOnly, u, trialNoPx]) expect(hasUsableDriverPrice(db, id)).toBe(false);
    expect(hasUsableDriverPrice(db, ok)).toBe(true);
    expect(hasUsableDriverPrice(db, 4242)).toBe(false);
  });
});

describe("listCandidateUnderlyings", () => {
  it("F8 candidate underlyings: driver-list names, the index rows and active watchlist names, each with a contract id, non-option and US-dollar; a contract-less, a non-dollar and an inactive watchlist name are absent; a symbol-only driver is absent", () => {
    const a = priced({ symbol: "ZZA", type: "Stock", name: "ZZ Alpha" });
    hold(a, 10);
    const nc = priced({ symbol: "ZZC", type: "Stock", conId: false });
    hold(nc, 10); // a driver with no contract id
    hold(option("ZZN"), 1); // an underlying with no row: not even a driver
    const fx = priced({ symbol: "ZZF", type: "Stock", currency: "EUR" });
    hold(fx, 10);
    const spy = addSecurity({ symbol: "SPY", type: "ETF", name: "Index fund one" });
    const qqq = addSecurity({ symbol: "QQQ", type: "ETF", conId: false }); // index row with no contract id
    const w = addSecurity({ symbol: "ZZW", type: "Stock" });
    watch(w);
    watch(a);
    const off = addSecurity({ symbol: "ZZO", type: "Stock" });
    watch(off, false);
    const wfx = addSecurity({ symbol: "ZZWF", type: "Stock", currency: "CAD" });
    watch(wfx);
    const drivers = listSingleNameDrivers(db, { trialUnderlyingIds: [], today: TODAY });
    expect(drivers.map((d) => d.symbol)).toEqual(["ZZA", "ZZC", "ZZF"]);
    const list = listCandidateUnderlyings(db, { drivers, today: TODAY });
    expect(list).toEqual([
      { securityId: spy, symbol: "SPY", name: "Index fund one", reasons: ["index"] },
      { securityId: a, symbol: "ZZA", name: "ZZ Alpha", reasons: ["driver-list", "watchlist"] },
      { securityId: w, symbol: "ZZW", name: null, reasons: ["watchlist"] },
    ]);
    expect(list.some((e) => [nc, fx, qqq, off, wfx].includes(e.securityId))).toBe(false);
  });
});
