/**
 * Defense / hedge book: a daily-reset leveraged or inverse fund, or an option
 * on one, is held out of the hedge book and listed as not modelled (owner
 * ruling 2026-11-01 item 2, `lib/compute/leveraged-fund.ts`). Synthetic
 * symbols and round figures only.
 */
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { computeDefenseAnalysis, type DefenseAnalysis } from "@/lib/compute/hedging";
import { todayET, addDays } from "@/lib/calendar/date-utils";

let db: Database.Database;
let accountId: number;

interface SeedOpts {
  type?: string;
  name?: string;
  fundCategory?: string | null;
  underlyingSymbol?: string | null;
  optionType?: "CALL" | "PUT" | null;
  strikePrice?: number | null;
  expirationDate?: string | null;
  multiplier?: number;
  sector?: string | null;
  geography?: string | null;
}

function seedSecurity(symbol: string, opts: SeedOpts = {}): number {
  const r = db
    .prepare(
      `INSERT INTO securities
        (symbol, name, security_type, fund_category, underlying_symbol, option_type, strike_price, expiration_date, multiplier, sector, geography, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD')`
    )
    .run(
      symbol,
      opts.name ?? `${symbol} Corp`,
      opts.type ?? "Stock",
      opts.fundCategory ?? null,
      opts.underlyingSymbol ?? null,
      opts.optionType ?? null,
      opts.strikePrice ?? null,
      opts.expirationDate ?? null,
      opts.multiplier ?? 1,
      opts.sector ?? null,
      opts.geography ?? null
    );
  return r.lastInsertRowid as number;
}

function seedHolding(securityId: number, qty: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, '2026-07-01')"
  ).run(accountId, securityId, qty, qty * 100);
}

function seedPrice(securityId: number, price: number) {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-07-01', 'test')"
  ).run(securityId, price);
}

function symbolsEverywhere(a: DefenseAnalysis): string[] {
  const out: string[] = [];
  for (const p of a.pairs) out.push(p.underlying, ...p.instruments.map((i) => i.symbol));
  for (const p of a.proxies) out.push(p.underlying, ...p.instruments.map((i) => i.symbol));
  for (const b of a.standaloneBets) out.push(b.underlying, ...b.instruments.map((i) => i.symbol));
  for (const r of a.rankedExposures) out.push(r.underlying, ...(r.legs ?? []).map((l) => l.symbol));
  for (const h of a.hedgeScores) out.push(h.underlying, h.symbol);
  return out;
}

describe("computeDefenseAnalysis: leveraged or inverse funds are not modelled", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("INSERT INTO accounts (name) VALUES ('Account A')").run();
    accountId = (db.prepare("SELECT id FROM accounts WHERE name = 'Account A'").get() as { id: number }).id;

    // A plain long equity book: 100 sh ZZA @ $500.
    const zzaId = seedSecurity("ZZA", { type: "Stock", sector: "Technology", geography: "US" });
    seedHolding(zzaId, 100);
    seedPrice(zzaId, 500);
  });

  it("holds a short leveraged commodity fund out of every hedge-book list and the summary counts", () => {
    const zzlId = seedSecurity("ZZL", {
      type: "ETF",
      name: "ZZL Synthetic Fund",
      fundCategory: "Leveraged/Inverse (Commodities)",
    });
    seedHolding(zzlId, -400);
    seedPrice(zzlId, 25);

    const a = computeDefenseAnalysis(db);
    expect(symbolsEverywhere(a)).not.toContain("ZZL");
    expect(a.summary.shortPositionCount).toBe(0);
    expect(a.summary.shortExposure).toBe(0);
    expect(a.summary.grossExposure).toBeCloseTo(50_000, 6);
    expect(a.summary.hedgeCount).toBe(0);
    expect(a.leveragedFundsUnmodelled.count).toBe(1);
    expect(a.leveragedFundsUnmodelled.symbols).toEqual(["ZZL"]);
    // |−400 × 25| = 10,000 of a 60,000 gross universe.
    expect(a.leveragedFundsUnmodelled.valueShare).toBeCloseTo(10_000 / 60_000, 6);
  });

  it("holds a long put on a leveraged fund out too, counted once under the option's own symbol", () => {
    const expiry = addDays(todayET(), 180);
    const tag = expiry.replace(/-/g, "").slice(2);
    const zzlId = seedSecurity("ZZL", {
      type: "ETF",
      name: "ZZL Synthetic Fund",
      fundCategory: "Leveraged/Inverse (Commodities)",
    });
    seedPrice(zzlId, 25);
    const putSymbol = `ZZL   ${tag}P00020000`;
    const putId = seedSecurity(putSymbol, {
      type: "Option",
      underlyingSymbol: "ZZL",
      optionType: "PUT",
      strikePrice: 20,
      expirationDate: expiry,
      multiplier: 100,
    });
    seedHolding(putId, 2);
    seedPrice(putId, 1);

    const a = computeDefenseAnalysis(db);
    const everywhere = symbolsEverywhere(a);
    expect(everywhere).not.toContain("ZZL");
    expect(everywhere).not.toContain(putSymbol);
    expect(a.summary.optionPositionCount).toBe(0);
    expect(a.summary.hedgeCount).toBe(0);
    expect(a.leveragedFundsUnmodelled.count).toBe(1);
    expect(a.leveragedFundsUnmodelled.symbols).toEqual([putSymbol]);
    expect(a.leveragedFundsUnmodelled.valueShare).toBeGreaterThan(0);
  });

  it("still classifies a plain short ETF with no leveraged markers exactly as before", () => {
    const zzpId = seedSecurity("ZZP", { type: "ETF", name: "ZZP Broad Market Fund", fundCategory: "Large Blend" });
    seedHolding(zzpId, -100);
    seedPrice(zzpId, 100);

    const a = computeDefenseAnalysis(db);
    expect(symbolsEverywhere(a)).toContain("ZZP");
    expect(a.summary.shortPositionCount).toBe(1);
    expect(a.summary.shortExposure).toBeCloseTo(-10_000, 6);
    expect(a.leveragedFundsUnmodelled).toEqual({ count: 0, valueShare: 0, symbols: [] });
  });
});
