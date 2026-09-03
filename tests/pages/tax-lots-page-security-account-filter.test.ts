/**
 * QA finding tax-lots--account-pill-drops-security-filter-from-realized-tiles-filtered-chip-stays:
 * with BOTH ?security=<id> and ?account=<name> set, the REALIZED /
 * LONG-TERM / SHORT-TERM tiles silently dropped the security filter and
 * rendered the WHOLE account's totals while the "Filtered: <symbol>" chip
 * stayed on screen — a security with zero sales in the selected account
 * showed that account's entire realized P&L under its own symbol.
 *
 * Root cause: `activeSummary` in app/dashboard/tax-lots/page.tsx was
 * computed from `selectedAccount` alone (account-wide, security-blind) and
 * then took precedence over the correctly security-filtered `closedSales`
 * reduction via `activeSummary?.X ?? ...`. Fix: only use the account-wide
 * `activeSummary` when NO security filter is active; when a security filter
 * is present (with or without an account filter), always derive the tiles
 * from the already-filtered `closedSales`/`openLots` rows.
 *
 * TaxLotsPage is a plain `export default async function` (no
 * cookies/headers/notFound) — directly invocable, same pattern as
 * tests/pages/today-page-fx.test.ts: mock the `@/lib/db` singleton, call
 * the page function, and walk the returned element tree without rendering
 * (child components like TaxLotSummaryCards are never executed by React,
 * so we just read their props).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { TaxLotSummaryCards } from "@/app/dashboard/components/TaxLotSummary";
import type { TaxLotSummary } from "@/lib/queries/tax-lots";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

let db: Database.Database;

function getAccountId(name: string): number {
  return (
    db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as {
      id: number;
    }
  ).id;
}

function seedSecurity(symbol: string): number {
  const result = db
    .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'stock')")
    .run(symbol, `${symbol} Corp`);
  return result.lastInsertRowid as number;
}

function seedBuy(accountId: number, securityId: number, date: string, qty: number, price: number): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
     VALUES (?, ?, ?, 'BUY', ?, ?, ?, ?)`
  ).run(accountId, securityId, date, qty, price, -(qty * price), `buy-${accountId}-${securityId}-${date}-${Math.random()}`);
}

function seedSell(accountId: number, securityId: number, date: string, qty: number, price: number): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
     VALUES (?, ?, ?, 'SELL', ?, ?, ?, ?)`
  ).run(accountId, securityId, date, qty, price, qty * price, `sell-${accountId}-${securityId}-${date}-${Math.random()}`);
}

// ─── Minimal JSX-tree walker (mirrors tests/pages/today-page-fx.test.ts) ───

interface ElementLike {
  type: unknown;
  props?: { children?: unknown; [key: string]: unknown };
}

function isElement(node: unknown): node is ElementLike {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}

function findByType(node: unknown, type: unknown): ElementLike | null {
  if (node === null || node === undefined || typeof node === "boolean") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByType(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!isElement(node)) return null;
  if (node.type === type) return node;
  return findByType(node.props?.children, type);
}

describe("TaxLotsPage — security + account filters combined (QA regression)", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    hoisted.db = db;
  });

  it("shows AAPL's own zero 2026 sales in Vanguard Taxable, not Vanguard Taxable's whole-account MSFT total", async () => {
    const { default: TaxLotsPage } = await import("@/app/dashboard/tax-lots/page");

    const vgTaxable = getAccountId("Vanguard Taxable");
    const ibkr = getAccountId("IBKR");

    const aaplId = seedSecurity("AAPL");
    const msftId = seedSecurity("MSFT");

    // AAPL: bought + sold entirely within IBKR — zero AAPL activity in
    // Vanguard Taxable (mirrors the QA repro: AAPL's 7 real sales are all
    // IBKR, zero are Vanguard Taxable).
    seedBuy(ibkr, aaplId, "2026-01-05", 10, 100);
    seedSell(ibkr, aaplId, "2026-02-01", 10, 133.7); // +$337 realized

    // MSFT: bought + sold within Vanguard Taxable — a large, unrelated gain
    // that must NOT leak into the AAPL+Vanguard-Taxable filtered tiles.
    seedBuy(vgTaxable, msftId, "2026-01-05", 100, 300);
    seedSell(vgTaxable, msftId, "2026-02-01", 100, 800); // +$50,000 realized

    computeTaxLots(db);

    const element = await TaxLotsPage({
      searchParams: Promise.resolve({ security: String(aaplId), account: "Vanguard Taxable" }),
    });

    const cards = findByType(element, TaxLotSummaryCards);
    expect(cards, "expected a TaxLotSummaryCards element in the returned tree").not.toBeNull();
    const summary = cards!.props!.summary as TaxLotSummary;

    // AAPL has ZERO sales in Vanguard Taxable — the tiles must reflect that,
    // not MSFT's +$50,000 / 1 sale for the whole account.
    expect(summary.totalClosedSales).toBe(0);
    expect(summary.totalRealizedGain).toBe(0);
    expect(summary.longTermGain).toBe(0);
    expect(summary.shortTermGain).toBe(0);
  });

  it("still shows AAPL's own IBKR sale when both filters point at where the activity actually is", async () => {
    const { default: TaxLotsPage } = await import("@/app/dashboard/tax-lots/page");

    const ibkr = getAccountId("IBKR");
    const aaplId = seedSecurity("AAPL");
    const msftId = seedSecurity("MSFT");

    seedBuy(ibkr, aaplId, "2026-01-05", 10, 100);
    seedSell(ibkr, aaplId, "2026-02-01", 10, 133.7); // +$337 realized
    seedBuy(ibkr, msftId, "2026-01-05", 100, 300);
    seedSell(ibkr, msftId, "2026-02-01", 100, 800); // +$50,000 realized, different security

    computeTaxLots(db);

    const element = await TaxLotsPage({
      searchParams: Promise.resolve({ security: String(aaplId), account: "IBKR" }),
    });

    const cards = findByType(element, TaxLotSummaryCards);
    const summary = cards!.props!.summary as TaxLotSummary;

    expect(summary.totalClosedSales).toBe(1);
    expect(summary.totalRealizedGain).toBeCloseTo(337, 0);
  });
});
