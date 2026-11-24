// tests/compute/exposure-gross-netted-by-name.test.ts
//
// FIX 17 (2026-11-24) — one meaning of "gross". Owner ruling 2026-11-24:
// "Net each name first (shares in every account plus its options at delta),
// then add up the sizes. A covered call then shrinks its stock.
// Concentration keeps market value on purpose, labelled as such."
//
// A NAME is the underlying security: its shares in every scoped account plus
// every option on it at delta exposure. A leveraged or inverse fund is its
// own name at its factor-adjusted exposure (never netted into the index it
// tracks); an option on that fund nets with the fund. Then long = Σ positive
// names, short = Σ negative names, net = long + short, gross = long − short.
// One helper (`nameNettedExposure`, lib/compute/exposure.ts) serves the
// Diagnostics badge (and the chat options tool, which reads the summary) and
// Defense's summary, so the two print the same four figures here. (Only
// because no fixture below holds a bond: Defense's universe leaves bonds out,
// so with a bond held its figures differ from the badge's.) Netting never
// changes a sum: net is the same as the plain per-row sum.
//
// Synthetic symbols, round figures; the option deltas come from the engine,
// so the expectations are written in terms of the map's own exposure.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getOptionExposureMap, getPortfolioExposureSummary } from "@/lib/compute/exposure";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";
import { getAllocationByDimension } from "@/lib/queries/analysis";
import { todayET } from "@/lib/calendar/date-utils";

let db: Database.Database;
let A: number;
let B: number;
const TODAY = todayET();
const EXPIRY = `${Number(TODAY.slice(0, 4)) + 2}-12-17`;

function account(name: string, value: number): number {
  const id = db.prepare("INSERT INTO accounts (name) VALUES (?)").run(name).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO daily_valuations (account_id, valuation_date, cash_balance, holdings_value, total_value)
     VALUES (?, ?, 0, ?, ?)`
  ).run(id, TODAY, value, value);
  return id;
}

function security(
  symbol: string,
  f: { type?: string; sector?: string; underlying?: string; strike?: number; leverage?: number; name?: string } = {}
): number {
  const isOption = f.type === "Option";
  return db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, sector, underlying_symbol, option_type, strike_price,
                               expiration_date, leverage_factor, currency, multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?)`
    )
    .run(
      symbol,
      f.name ?? `${symbol} Corp`,
      f.type ?? "Stock",
      f.sector ?? "Technology",
      f.underlying ?? null,
      isOption ? "CALL" : null,
      f.strike ?? null,
      isOption ? EXPIRY : null,
      f.leverage ?? null,
      isOption ? 100 : 1
    ).lastInsertRowid as number;
}

function price(securityId: number, close: number) {
  db.prepare("INSERT OR IGNORE INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')").run(
    securityId,
    TODAY,
    close
  );
}

function hold(accountId: number, securityId: number, quantity: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key) VALUES (?, ?, ?, ?, ?)"
  ).run(accountId, securityId, quantity, TODAY, `t:${accountId}:${securityId}`);
}

let ZZX: number;
let CALL: number;

/** Case A: long 10,000 of ZZX plus one short far-dated call on it (worth -3,000). */
function caseA() {
  ZZX = security("ZZX");
  price(ZZX, 100);
  hold(A, ZZX, 100);
  CALL = security("ZZX   C70", { type: "Option", underlying: "ZZX", strike: 70 });
  price(CALL, 30);
  hold(A, CALL, -1);
}

function callExposure(): number {
  const v = getOptionExposureMap(db).get(CALL);
  if (v === undefined) throw new Error("call delta did not compute");
  return v;
}

function bothSides(accountIds?: number[]) {
  const s = getPortfolioExposureSummary(db, accountIds);
  const d = computeDefenseAnalysis(db, accountIds).summary;
  return { s, d };
}

function expectSameFigures(s: ReturnType<typeof getPortfolioExposureSummary>, d: ReturnType<typeof computeDefenseAnalysis>["summary"]) {
  expect(d.netExposure).toBeCloseTo(s.net_exposure, 6);
  expect(d.grossExposure).toBeCloseTo(s.gross_exposure, 6);
  expect(d.nameLongExposure).toBeCloseTo(s.long_exposure, 6);
  expect(d.nameShortExposure).toBeCloseTo(s.short_exposure, 6);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  A = account("ZZ One", 50_000);
  B = account("ZZ Two", 50_000);
});

describe("FIX 17: gross nets each name first", () => {
  it("Case A: a covered call shrinks its stock (gross = |net|)", () => {
    caseA();
    const call = callExposure();
    // The fixture is the review's shape: the call's delta exposure is most
    // of the stock, and the name stays net long.
    expect(call).toBeLessThan(-6_000);
    expect(call).toBeGreaterThan(-10_000);

    const { s, d } = bothSides();
    // Net is the plain sum, unchanged by netting.
    expect(s.net_exposure).toBeCloseTo(10_000 + call, 6);
    expect(s.gross_exposure).toBeCloseTo(10_000 + call, 6);
    expect(s.long_exposure).toBeCloseTo(10_000 + call, 6);
    expect(s.short_exposure).toBe(0);
    expectSameFigures(s, d);
    // The old Σ|per security| would have been 10,000 + |call|.
    expect(s.gross_exposure).toBeLessThan(10_000 - call - 1);
  });

  it("Case B: plus a 4,000 short of ZZX in another account (the name turns net short)", () => {
    caseA();
    hold(B, ZZX, -40);
    const call = callExposure();
    const { s, d } = bothSides();
    const net = 6_000 + call;
    expect(net).toBeLessThan(0);
    expect(s.net_exposure).toBeCloseTo(net, 6);
    expect(s.gross_exposure).toBeCloseTo(-net, 6);
    expect(s.long_exposure).toBe(0);
    expect(s.short_exposure).toBeCloseTo(net, 6);
    expectSameFigures(s, d);
    // Ratios over net worth (100,000).
    expect(s.net_ratio).toBeCloseTo(net / 100_000, 9);
    expect(s.gross_ratio).toBeCloseTo(-net / 100_000, 9);
  });

  it("a stock long in one account and short in another, no options: gross 0, ratios 0", () => {
    const id = security("ZZF");
    price(id, 100);
    hold(A, id, 100);
    hold(B, id, -100);
    const { s, d } = bothSides();
    expect(s.net_exposure).toBeCloseTo(0, 9);
    expect(s.gross_exposure).toBeCloseTo(0, 9);
    expect(s.long_exposure).toBe(0);
    expect(s.short_exposure).toBe(0);
    // A positive base with no exposure prints 0, not "no figure".
    expect(s.net_ratio).toBe(0);
    expect(s.gross_ratio).toBe(0);
    expectSameFigures(s, d);
  });

  it("a flat name with no net worth on file prints no ratio", () => {
    const id = security("ZZF");
    price(id, 100);
    hold(A, id, 100);
    hold(B, id, -100);
    db.prepare("DELETE FROM daily_valuations").run();
    const s = getPortfolioExposureSummary(db);
    expect(s.gross_exposure).toBeCloseTo(0, 9);
    expect(s.net_ratio).toBeNull();
    expect(s.gross_ratio).toBeNull();
  });

  it("an option on a leveraged fund nets with the fund, not with the index it tracks", () => {
    const fund = security("ZZL3", { type: "ETF", leverage: 3, name: "ZZ 3x Index Fund", sector: undefined });
    price(fund, 100);
    hold(A, fund, 100); // 10,000 of fund, 30,000 of index exposure
    const index = security("ZZIX", { type: "ETF", name: "ZZ Index Fund" });
    price(index, 100);
    hold(A, index, 50); // 5,000, its own name
    CALL = security("ZZL3  C70", { type: "Option", underlying: "ZZL3", strike: 70 });
    price(CALL, 30);
    hold(A, CALL, -1);

    const fundCallIndexExposure = 3 * callExposure();
    const { s, d } = bothSides();
    const fundName = 30_000 + fundCallIndexExposure;
    expect(s.net_exposure).toBeCloseTo(fundName + 5_000, 6);
    expect(s.gross_exposure).toBeCloseTo(Math.abs(fundName) + 5_000, 6);
    expectSameFigures(s, d);
  });

  it("an option whose underlying has no securities row is its own name", () => {
    CALL = security("ZZQ   C70", { type: "Option", underlying: "ZZQ", strike: 70 });
    price(CALL, 30);
    hold(A, CALL, -1);
    const s = getPortfolioExposureSummary(db);
    // No underlying price either: the ±2.5× fallback, a name of its own.
    expect(s.net_exposure).toBeCloseTo(-2.5 * 3_000, 6);
    expect(s.gross_exposure).toBeCloseTo(2.5 * 3_000, 6);
    expect(s.short_exposure).toBeCloseTo(-2.5 * 3_000, 6);
  });

  it("the Breakdown nets a security across accounts inside a row, and keeps an option in its own row", () => {
    caseA();
    hold(B, ZZX, -40);
    const rows = getAllocationByDimension(db, "security_type");
    const stock = rows.find((r) => r.group_name === "Stock");
    const option = rows.find((r) => r.group_name === "Option");
    // ZZX: 10,000 long in A, 4,000 short in B: one security, net 6,000 long.
    expect(stock?.long_value).toBeCloseTo(6_000, 6);
    expect(stock?.short_value).toBe(0);
    expect(option?.short_value).toBeCloseTo(-3_000, 6);
    expect(option?.long_value).toBe(0);
  });
});
