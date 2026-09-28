import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";
import { todayET, addDays } from "@/lib/calendar/date-utils";

// Regression coverage for [qa:analysis-defense--money-market-sweep-funds-ranked-top-unhedged-exposure]:
// a cash-equivalent sweep fund (stable $1.00 NAV) has no market exposure to
// hedge and must never appear in Defense's ranked exposures or feed the
// protection-ratio denominator. computeDefenseAnalysis pulls its holdings
// universe from a single SQL query; this file seeds that universe directly
// with small, synthetic tickers/quantities (never real portfolio data).

let db: Database.Database;

function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

interface SeedSecurityOpts {
  type?: string;
  fundCategory?: string | null;
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
        (symbol, name, security_type, fund_category, underlying_symbol, option_type, strike_price, expiration_date, multiplier, sector, geography, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      symbol,
      `${symbol} Test Security`,
      opts.type ?? "Stock",
      opts.fundCategory ?? null,
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
  ).run(accountId, securityId, qty, qty * 1, asOfDate);
}

function seedPrice(securityId: number, price: number, date = "2026-07-01") {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, close_price, date, source) VALUES (?, ?, ?, 'test')"
  ).run(securityId, price, date);
}

function daysFromNow(days: number): string {
  return addDays(todayET(), days);
}

describe("computeDefenseAnalysis — cash-equivalent sweep funds excluded", () => {
  let acct: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    acct = seedAccount("Taxable");
  });

  it("ranked exposures contain the stock but never a Mutual-Fund/Cash-Equivalent sweep fund", () => {
    // Ordinary stock: 50 sh @ $100 = $5,000 exposure, with a protective put
    // (mirrors the hedged_long recipe used by hedging-orchestrator.test.ts)
    // so the protection ratio is not trivially 0/0.
    const stockId = seedSecurity("ZZSTK", { type: "Stock", sector: "Technology", geography: "US" });
    seedHolding(acct, stockId, 50);
    seedPrice(stockId, 100);

    const expiry180 = daysFromNow(180);
    const expiryTag = expiry180.replace(/-/g, "").slice(2);
    const putId = seedSecurity(`ZZSTK ${expiryTag}P00090000`, {
      type: "Option",
      underlyingSymbol: "ZZSTK",
      optionType: "PUT",
      strikePrice: 90,
      expirationDate: expiry180,
      multiplier: 100,
    });
    seedHolding(acct, putId, 1);
    seedPrice(putId, 3);

    // Sweep fund: stable $1.00 NAV, 1,000 units = $1,000 — cash, not exposure.
    const cashId = seedSecurity("ZZCASH", {
      type: "Mutual Fund",
      fundCategory: "Cash Equivalent",
    });
    seedHolding(acct, cashId, 1000);
    seedPrice(cashId, 1.0);

    const withSweep = computeDefenseAnalysis(db, [acct]);

    // The sweep fund must never surface as a ranked exposure.
    expect(withSweep.rankedExposures.some((r) => r.underlying === "ZZCASH")).toBe(false);
    // The ordinary stock must still be there.
    expect(
      withSweep.pairs.some((p) => p.underlying === "ZZSTK") ||
        withSweep.rankedExposures.some((r) => r.underlying === "ZZSTK")
    ).toBe(true);

    // Build the identical book minus the sweep fund and confirm the
    // protection ratio and exposure totals are unaffected by its presence.
    const db2 = new Database(":memory:");
    db2.pragma("foreign_keys = ON");
    runMigrations(db2);
    const savedDb = db;
    db = db2;
    const acct2 = seedAccount("Taxable");
    const stockId2 = seedSecurity("ZZSTK", { type: "Stock", sector: "Technology", geography: "US" });
    seedHolding(acct2, stockId2, 50);
    seedPrice(stockId2, 100);
    const putId2 = seedSecurity(`ZZSTK ${expiryTag}P00090000`, {
      type: "Option",
      underlyingSymbol: "ZZSTK",
      optionType: "PUT",
      strikePrice: 90,
      expirationDate: expiry180,
      multiplier: 100,
    });
    seedHolding(acct2, putId2, 1);
    seedPrice(putId2, 3);
    const withoutSweep = computeDefenseAnalysis(db2, [acct2]);
    db = savedDb;

    expect(withSweep.summary.longExposure).toBeCloseTo(withoutSweep.summary.longExposure, 6);
    expect(withSweep.summary.grossExposure).toBeCloseTo(withoutSweep.summary.grossExposure, 6);
    expect(withSweep.summary.protectionRatio).not.toBeNull();
    expect(withSweep.summary.protectionRatio).toBeCloseTo(withoutSweep.summary.protectionRatio!, 6);
  });

  it("also excludes a money_market security_type row with a null fund_category", () => {
    const stockId = seedSecurity("ZZSTK", { type: "Stock", sector: "Technology", geography: "US" });
    seedHolding(acct, stockId, 50);
    seedPrice(stockId, 100);

    const mmId = seedSecurity("ZZMM", {
      type: "money_market",
      fundCategory: null,
    });
    seedHolding(acct, mmId, 2000);
    seedPrice(mmId, 1.0);

    const result = computeDefenseAnalysis(db, [acct]);

    expect(result.rankedExposures.some((r) => r.underlying === "ZZMM")).toBe(false);
    expect(
      result.pairs.some((p) => p.underlying === "ZZSTK") ||
        result.rankedExposures.some((r) => r.underlying === "ZZSTK")
    ).toBe(true);
    // No standalone bet either — the money-market row must not leak into any
    // downstream bucket.
    expect(result.standaloneBets.some((b) => b.underlying === "ZZMM")).toBe(false);
  });
});
