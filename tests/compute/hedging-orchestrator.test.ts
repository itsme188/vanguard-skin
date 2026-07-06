import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";

let db: Database.Database;

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

interface SeedSecurityOpts {
  type?: string;
  underlyingSymbol?: string | null;
  optionType?: "CALL" | "PUT" | null;
  strikePrice?: number | null;
  expirationDate?: string | null;
  multiplier?: number;
  sector?: string | null;
  geography?: string | null;
  currency?: string;
}

function seedSecurity(symbol: string, opts: SeedSecurityOpts = {}): number {
  const r = db
    .prepare(
      `INSERT INTO securities
        (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier, sector, geography, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol,
      `${symbol} Corp`,
      opts.type ?? "Stock",
      opts.underlyingSymbol ?? null,
      opts.optionType ?? null,
      opts.strikePrice ?? null,
      opts.expirationDate ?? null,
      opts.multiplier ?? 1,
      opts.sector ?? null,
      opts.geography ?? null,
      opts.currency ?? "USD"
    );
  return r.lastInsertRowid as number;
}

function seedHolding(accountId: number, securityId: number, qty: number, asOfDate = "2026-07-01") {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, ?)"
  ).run(accountId, securityId, qty, qty * 100, asOfDate);
}

function seedPrice(securityId: number, price: number, date = "2026-07-01") {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, close_price, date, source) VALUES (?, ?, ?, 'test')"
  ).run(securityId, price, date);
}

function daysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe("computeDefenseAnalysis", () => {
  let accountA: number;
  let accountB: number;
  let msftId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);

    accountA = seedAccount("Account A");
    accountB = seedAccount("Account B");

    const expiry180 = daysFromNow(180);
    const expiryTag = expiry180.replace(/-/g, "").slice(2);

    // 100 sh MSFT @ $500
    msftId = seedSecurity("MSFT", { type: "Stock", sector: "Technology", geography: "US" });
    seedHolding(accountA, msftId, 100);
    seedPrice(msftId, 500);

    // 2 MSFT puts, strike 400, expiry +180d, multiplier 100, option price $10
    const msftPutId = seedSecurity(`MSFT  ${expiryTag}P00400000`, {
      type: "Option",
      underlyingSymbol: "MSFT",
      optionType: "PUT",
      strikePrice: 400,
      expirationDate: expiry180,
      multiplier: 100,
    });
    seedHolding(accountA, msftPutId, 2);
    seedPrice(msftPutId, 10);

    // MTUM: no shares held, just a price for the option's underlying valuation
    const mtumId = seedSecurity("MTUM", { type: "ETF" });
    seedPrice(mtumId, 220);

    // 3 MTUM puts, strike 200, expiry +180d, multiplier 100
    const mtumPutId = seedSecurity(`MTUM  ${expiryTag}P00200000`, {
      type: "Option",
      underlyingSymbol: "MTUM",
      optionType: "PUT",
      strikePrice: 200,
      expirationDate: expiry180,
      multiplier: 100,
    });
    seedHolding(accountA, mtumPutId, 3);
    seedPrice(mtumPutId, 5);

    // -80 sh PAYC in account B (naked short, no options)
    const paycId = seedSecurity("PAYC", { type: "Stock" });
    seedHolding(accountB, paycId, -80);
    seedPrice(paycId, 200);
  });

  it("builds MSFT hedged_long, MTUM proxy via assumed beta, and PAYC naked_short, with a positive protection ratio", () => {
    const result = computeDefenseAnalysis(db);

    expect(result.summary.protectionRatio).not.toBeNull();
    expect(result.summary.protectionRatio!).toBeGreaterThan(0);

    const msftPair = result.pairs.find((p) => p.underlying === "MSFT");
    expect(msftPair).toBeDefined();
    expect(msftPair!.classification).toBe("hedged_long");

    const mtumProxy = result.proxies.find((p) => p.underlying === "MTUM");
    expect(mtumProxy).toBeDefined();
    expect(mtumProxy!.route).toBe("beta");
    expect(mtumProxy!.betaSource).toBe("assumed");
    expect(
      result.diagnostics.some((d) => d.kind === "assumed_beta" && d.symbol === "MTUM")
    ).toBe(true);

    const paycBet = result.standaloneBets.find((b) => b.underlying === "PAYC");
    expect(paycBet).toBeDefined();
    expect(paycBet!.kind).toBe("naked_short");
  });

  it("scoping to account A excludes PAYC from standaloneBets and from summary.shortExposure", () => {
    const all = computeDefenseAnalysis(db);
    const scoped = computeDefenseAnalysis(db, [accountA]);

    expect(all.standaloneBets.find((b) => b.underlying === "PAYC")).toBeDefined();
    expect(scoped.standaloneBets.find((b) => b.underlying === "PAYC")).toBeUndefined();

    // Excluding PAYC's negative exposure makes shortExposure less negative (i.e. greater).
    expect(scoped.summary.shortExposure).toBeGreaterThan(all.summary.shortExposure);
  });

  it("scales MSFT's core exposure by the FX rate when its currency is foreign", () => {
    const before = computeDefenseAnalysis(db);
    const msftPairBefore = before.pairs.find((p) => p.underlying === "MSFT")!;
    expect(msftPairBefore.coreExposure).toBeCloseTo(50000, 2);

    db.prepare("UPDATE securities SET currency = 'KRW' WHERE id = ?").run(msftId);
    db.prepare(
      "INSERT INTO fx_rates (currency, usd_per_unit, as_of, source) VALUES ('KRW', 0.0007, '2026-07-01', 'test')"
    ).run();

    const after = computeDefenseAnalysis(db);
    const msftPairAfter = after.pairs.find((p) => p.underlying === "MSFT")!;

    expect(msftPairAfter.coreExposure).toBeCloseTo(msftPairBefore.coreExposure * 0.0007, 2);
  });
});
