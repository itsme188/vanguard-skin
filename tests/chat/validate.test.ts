import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { annotateToolResult } from "@/lib/chat/validate";
import type { HoldingResult } from "@/lib/queries/chat-tools";

// ─── Seed helpers ─────────────────────────────────────────────────

function seedSecurity(
  db: Database.Database,
  symbol: string,
  opts?: { name?: string; security_type?: string; maturity_date?: string }
): number {
  const result = db
    .prepare(
      `INSERT INTO securities (symbol, name, security_type, maturity_date)
       VALUES (?, ?, ?, ?)`
    )
    .run(
      symbol,
      opts?.name ?? `${symbol} Corp`,
      opts?.security_type ?? "stock",
      opts?.maturity_date ?? null
    );
  return result.lastInsertRowid as number;
}

function seedPrice(db: Database.Database, securityId: number, date: string, price: number): void {
  db.prepare(
    "INSERT OR REPLACE INTO prices (security_id, date, close_price) VALUES (?, ?, ?)"
  ).run(securityId, date, price);
}

function seedHolding(
  db: Database.Database,
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate: string,
  costBasis?: number
): void {
  db.prepare(
    `INSERT OR REPLACE INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(accountId, securityId, quantity, costBasis ?? null, asOfDate, `hold-${accountId}-${securityId}-${asOfDate}`);
}

// ─── Tests ────────────────────────────────────────────────────────

describe("annotateToolResult", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("returns data_freshness with no data", () => {
    const annotation = annotateToolResult(db, "query_holdings", []);
    expect(annotation.data_freshness.latest_price_date).toBeNull();
    expect(annotation.data_freshness.price_age_days).toBeNull();
    expect(annotation.data_freshness.latest_holdings_date).toBeNull();
  });

  it("detects stale prices (>7 days old)", () => {
    const sec = seedSecurity(db, "AAPL");
    // Price from 30 days ago
    const oldDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    seedPrice(db, sec, oldDate, 200);

    const annotation = annotateToolResult(db, "query_holdings", []);
    expect(annotation.data_freshness.price_age_days).toBeGreaterThan(7);
    expect(annotation.quality_warnings.some((w) => w.includes("Price data is"))).toBe(true);
  });

  it("does not warn about fresh prices", () => {
    const sec = seedSecurity(db, "AAPL");
    const today = new Date().toISOString().slice(0, 10);
    seedPrice(db, sec, today, 200);

    const annotation = annotateToolResult(db, "query_holdings", []);
    expect(annotation.quality_warnings.some((w) => w.includes("Price data is"))).toBe(false);
  });

  it("flags missing prices in holdings", () => {
    const holdingsWithMissingPrice: Partial<HoldingResult>[] = [
      { symbol: "AAPL", latest_price: 200, cost_basis: 150, market_value: 10000 },
      { symbol: "MYSTERY", latest_price: null, cost_basis: 5000, market_value: null },
    ];

    const annotation = annotateToolResult(db, "query_holdings", holdingsWithMissingPrice);
    expect(annotation.quality_warnings.some((w) => w.includes("no price data") && w.includes("MYSTERY"))).toBe(true);
  });

  it("flags missing cost basis in holdings", () => {
    const holdingsWithMissingCost: Partial<HoldingResult>[] = [
      { symbol: "AAPL", latest_price: 200, cost_basis: null, market_value: 10000 },
    ];

    const annotation = annotateToolResult(db, "query_holdings", holdingsWithMissingCost);
    expect(annotation.quality_warnings.some((w) => w.includes("no cost basis") && w.includes("AAPL"))).toBe(true);
  });

  it("flags approaching bond maturity", () => {
    // Bond maturing in 30 days
    const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const holdingsWithMaturing: Partial<HoldingResult>[] = [
      { symbol: "TBILL1", maturity_note: `Matures in 30 days` },
    ];

    const annotation = annotateToolResult(db, "query_holdings", holdingsWithMaturing);
    expect(annotation.quality_warnings.some((w) => w.includes("approaching maturity"))).toBe(true);
  });

  it("adds cash balance caveat for holdings", () => {
    const annotation = annotateToolResult(db, "query_holdings", []);
    expect(annotation.quality_warnings.some((w) => w.includes("Cash balances are estimated"))).toBe(true);
  });

  it("adds FIFO warning for tax_lots tool", () => {
    const annotation = annotateToolResult(db, "query_tax_lots", []);
    expect(annotation.quality_warnings.some((w) => w.includes("FIFO"))).toBe(true);
  });

  it("adds monthly change caveat for performance tool", () => {
    const annotation = annotateToolResult(db, "query_performance", []);
    expect(annotation.quality_warnings.some((w) => w.includes("deposits/withdrawals"))).toBe(true);
  });

  it("adds allocation caveat", () => {
    const annotation = annotateToolResult(db, "query_allocation", []);
    expect(annotation.quality_warnings.some((w) => w.includes("cost basis") || w.includes("Cash balances"))).toBe(true);
  });

  it("adds income reinvestment caveat", () => {
    const annotation = annotateToolResult(db, "query_income_summary", []);
    expect(annotation.quality_warnings.some((w) => w.includes("REINVESTMENT"))).toBe(true);
  });

  it("adds ownership warning for transactions tool", () => {
    const annotation = annotateToolResult(db, "query_transactions", []);
    expect(
      annotation.quality_warnings.some((w) => w.includes("does NOT mean the position is currently held"))
    ).toBe(true);
  });

  it("warns about closed lots in tax lot results", () => {
    const mixedLots = [
      { symbol: "AAPL", sale_date: null, quantity_remaining: 10 },
      { symbol: "GPRO", sale_date: "2025-02-06", quantity_remaining: 0 },
    ];
    const annotation = annotateToolResult(db, "query_tax_lots", mixedLots);
    expect(
      annotation.quality_warnings.some((w) => w.includes("1 lot(s)") && w.includes("CLOSED"))
    ).toBe(true);
  });

  it("does not warn about closed lots when all lots are open", () => {
    const openLots = [
      { symbol: "AAPL", sale_date: null, quantity_remaining: 10 },
    ];
    const annotation = annotateToolResult(db, "query_tax_lots", openLots);
    expect(
      annotation.quality_warnings.some((w) => w.includes("CLOSED"))
    ).toBe(false);
  });

  it("price staleness only applies to relevant tools", () => {
    const sec = seedSecurity(db, "AAPL");
    const oldDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    seedPrice(db, sec, oldDate, 200);

    // query_transactions should NOT get price staleness warning
    const annotation = annotateToolResult(db, "query_transactions", []);
    expect(annotation.quality_warnings.some((w) => w.includes("Price data is"))).toBe(false);
  });
});
