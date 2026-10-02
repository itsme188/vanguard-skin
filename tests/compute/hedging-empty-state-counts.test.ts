import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach } from "vitest";
import { runMigrations } from "@/lib/db/migrate";
import { computeDefenseAnalysis } from "@/lib/compute/hedging";
import { todayET, addDays } from "@/lib/calendar/date-utils";

// Regression: Defense's empty state claims "no options or short positions in
// this scope". A scope holding only a WRITTEN put (positive delta, so no short
// exposure, no hedge, no standalone bet) must still report that it holds an
// option position. Synthetic tickers and round quantities only.

let db: Database.Database;
let acct: number;

function seedSecurity(
  symbol: string,
  o: { type?: string; underlying?: string; optionType?: "CALL" | "PUT"; strike?: number; expiry?: string } = {}
): number {
  return db
    .prepare(
      `INSERT INTO securities
        (symbol, name, security_type, underlying_symbol, option_type, strike_price, expiration_date, multiplier, sector, geography, currency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Technology', 'US', 'USD')`
    )
    .run(
      symbol,
      `${symbol} Test`,
      o.type ?? "Stock",
      o.underlying ?? null,
      o.optionType ?? null,
      o.strike ?? null,
      o.expiry ?? null,
      o.type === "Option" ? 100 : 1
    ).lastInsertRowid as number;
}

function seedHolding(securityId: number, qty: number, price: number) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date) VALUES (?, ?, ?, ?, '2026-07-01')"
  ).run(acct, securityId, qty, qty);
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, close_price, date, source) VALUES (?, ?, '2026-07-01', 'test')"
  ).run(securityId, price);
}

describe("computeDefenseAnalysis — empty-state position counts", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    db.prepare("INSERT INTO accounts (name) VALUES ('Taxable')").run();
    acct = (db.prepare("SELECT id FROM accounts WHERE name = 'Taxable'").get() as { id: number }).id;
  });

  it("a written put alongside long stock counts as an option position, not a hedge", () => {
    const stock = seedSecurity("ZZSTK");
    seedHolding(stock, 50, 100);
    const expiry = addDays(todayET(), 60);
    const tag = expiry.replace(/-/g, "").slice(2);
    const put = seedSecurity(`ZZSTK ${tag}P00090000`, {
      type: "Option",
      underlying: "ZZSTK",
      optionType: "PUT",
      strike: 90,
      expiry,
    });
    seedHolding(put, -1, 3);

    const { summary } = computeDefenseAnalysis(db, [acct]);
    expect(summary.optionPositionCount).toBeGreaterThanOrEqual(1);
    expect(summary.shortPositionCount).toBeGreaterThanOrEqual(1);
    expect(summary.hedgeCount).toBe(0);
  });

  it("long stock only: both counts are zero", () => {
    const stock = seedSecurity("ZZSTK");
    seedHolding(stock, 50, 100);
    const { summary } = computeDefenseAnalysis(db, [acct]);
    expect(summary.optionPositionCount).toBe(0);
    expect(summary.shortPositionCount).toBe(0);
  });

  it("a short stock position counts as a short position", () => {
    const stock = seedSecurity("ZZSHT");
    seedHolding(stock, -20, 50);
    const { summary } = computeDefenseAnalysis(db, [acct]);
    expect(summary.shortPositionCount).toBeGreaterThanOrEqual(1);
    expect(summary.optionPositionCount).toBe(0);
  });
});

describe("DefenseView empty-state gate (source pin)", () => {
  it("also requires zero option and zero short positions", () => {
    const src = readFileSync("app/dashboard/components/DefenseView.tsx", "utf8");
    expect(src).toMatch(/summary\.optionPositionCount === 0/);
    expect(src).toMatch(/summary\.shortPositionCount === 0/);
  });
});
