import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";

/**
 * Two figures the chat summary states:
 *  - the realized-gain dollar totals, which must hold USD sales only
 *    (realized G/L is stored native per security) and disclose what they
 *    leave out, exactly as the Tax Lots tiles do;
 *  - the date a lot turns long-term, which must be the engine's calendar
 *    rule, not a fixed day count.
 * Synthetic symbols, invented round numbers.
 */

const ACCOUNT_ID = 1; // seeded by migration 002

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  vi.useRealTimers();
});

function seedSecurity(symbol: string, currency: string): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'Stock', ?)")
    .run(symbol, `${symbol} Corp`, currency).lastInsertRowid as number;
}

function seedClosedLot(securityId: number, realizedGainLoss: number, isLongTerm: boolean): void {
  const lotId = db
    .prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, '2024-01-10', 10, 10, 0, 100)`
    )
    .run(ACCOUNT_ID, securityId).lastInsertRowid as number;
  const txnId = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, source_key)
       VALUES (?, ?, '2026-02-10', 'SELL', ?)`
    )
    .run(ACCOUNT_ID, securityId, `usd-only-sale-${lotId}`).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO tax_lot_sales
       (tax_lot_id, sale_transaction_id, sale_date, sale_price, quantity_sold, proceeds,
        cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days)
     VALUES (?, ?, '2026-02-10', 10, 10, ?, 100, ?, ?, 762)`
  ).run(lotId, txnId, 100 + realizedGainLoss, realizedGainLoss, isLongTerm ? 1 : 0);
}

function realizedLine(summary: string): string {
  return summary.split("\n").find((l) => l.startsWith("- Realized gains:")) ?? "";
}

describe("chat summary realized gains are USD-only", () => {
  it("sums only the USD sale and discloses the one non-USD sale", () => {
    seedClosedLot(seedSecurity("AAA", "USD"), 300, true);
    // Native-currency gain: adding it to dollars would print a huge fake USD total.
    seedClosedLot(seedSecurity("ZZZ", "JPY"), 70000, true);

    const line = realizedLine(getPortfolioSummaryForChat(db));
    expect(line).toBe(
      "- Realized gains: $300 (LT: $300, ST: $0) — USD totals exclude 1 non-USD sale (native-currency figures)"
    );
  });

  it("keeps the long-term / short-term split USD-only and pluralizes the disclosure", () => {
    seedClosedLot(seedSecurity("AAA", "USD"), 300, true);
    seedClosedLot(seedSecurity("BBB", "USD"), -100, false);
    seedClosedLot(seedSecurity("YYY", "EUR"), 5000, true);
    seedClosedLot(seedSecurity("ZZZ", "JPY"), 70000, false);

    const line = realizedLine(getPortfolioSummaryForChat(db));
    expect(line).toContain("Realized gains: $200 (LT: $300, ST: -$100)");
    expect(line).toContain("USD totals exclude 2 non-USD sales (native-currency figures)");
  });

  it("says nothing extra when every sale is USD", () => {
    seedClosedLot(seedSecurity("AAA", "USD"), 300, true);
    expect(realizedLine(getPortfolioSummaryForChat(db))).toBe("- Realized gains: $300 (LT: $300, ST: $0)");
  });

  it("still shows the tax summary, with the disclosure, when the only sale is non-USD", () => {
    seedClosedLot(seedSecurity("ZZZ", "JPY"), 70000, true);
    const line = realizedLine(getPortfolioSummaryForChat(db));
    expect(line).toContain("Realized gains: $0 (LT: $0, ST: $0)");
    expect(line).toContain("USD totals exclude 1 non-USD sale (native-currency figures)");
  });

  it("scopes the excluded count to the account asked for", () => {
    seedClosedLot(seedSecurity("AAA", "USD"), 300, true);
    seedClosedLot(seedSecurity("ZZZ", "JPY"), 70000, true);
    const name = (id: number) =>
      (db.prepare("SELECT name FROM accounts WHERE id = ?").get(id) as { name: string }).name;
    expect(realizedLine(getPortfolioSummaryForChat(db, name(2)))).toBe("");
    expect(realizedLine(getPortfolioSummaryForChat(db, name(ACCOUNT_ID)))).toContain("exclude 1 non-USD sale");
  });
});

describe("chat summary long-term date follows the calendar rule", () => {
  function seedOpenLot(symbol: string, acquired: string): void {
    db.prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, ?, 10, 10, 10, 100)`
    ).run(ACCOUNT_ID, seedSecurity(symbol, "USD"), acquired);
  }

  it("a lot whose year spans Feb 29 turns long-term the day after its anniversary, not on it", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-06-01T16:00:00Z")); // 2024-06-01 in ET
    seedOpenLot("AAA", "2023-06-17");

    const summary = getPortfolioSummaryForChat(db);
    expect(summary).toContain("AAA (Vanguard Taxable): 17 days until long-term (2024-06-18)");
  });

  it("a Feb-29 lot turns long-term on Mar 1", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2025-02-20T16:00:00Z"));
    seedOpenLot("AAA", "2024-02-29");

    expect(getPortfolioSummaryForChat(db)).toContain("9 days until long-term (2025-03-01)");
  });

  it("on its anniversary a lot is still approaching (one day left); the next day it is gone", () => {
    seedOpenLot("AAA", "2023-06-17");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2024-06-17T16:00:00Z"));
    expect(getPortfolioSummaryForChat(db)).toContain("1 days until long-term (2024-06-18)");
    vi.setSystemTime(new Date("2024-06-18T16:00:00Z"));
    expect(getPortfolioSummaryForChat(db)).not.toContain("until long-term");
  });
});
