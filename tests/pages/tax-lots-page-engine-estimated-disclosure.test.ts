/**
 * QA finding: tax-lots--headline-tiles-include-reconcile-close-engine-rows
 * (page-wiring half — data: tests/queries/tax-lots-engine-estimated-disclosure.test.ts,
 *  render: tests/dashboard/tax-lots-engine-estimated-disclosure.test.tsx)
 *
 * /dashboard/tax-lots feeds TaxLotSummaryCards from THREE different places:
 * the unfiltered getTaxLotSummary, the account-wide getTaxLotSummaryByAccount
 * row (when an account pill alone is active), and a reduction over the
 * already-filtered closedSales rows (when a ?security= filter is active).
 * All three must carry the engine-estimated disclosure, or narrowing the view
 * silently drops it and the tiles disagree with the TAX REPORT card again.
 *
 * TaxLotsPage is a plain `export default async function` (no cookies/headers/
 * notFound) — directly invocable: mock the `@/lib/db` singleton, call it, and
 * read the child element's props without rendering (same pattern as
 * tests/pages/tax-lots-page-security-account-filter.test.ts).
 *
 * Synthetic fixture only (fake tickers, small round dollars).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { TaxLotSummaryCards } from "@/app/dashboard/components/TaxLotSummary";
import type { TaxLotSummary } from "@/lib/queries/tax-lots";

const hoisted = vi.hoisted(() => ({ db: null as unknown as Database.Database }));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

let db: Database.Database;

function accountId(name: string): number {
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedStock(symbol: string): number {
  return db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'stock', 'USD')"
    )
    .run(symbol, `${symbol} Corp`).lastInsertRowid as number;
}

function seedBuy(acct: number, sec: number, date: string, qty: number, price: number): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
     VALUES (?, ?, ?, 'BUY', ?, ?, ?, ?)`
  ).run(acct, sec, date, qty, price, -(qty * price), `buy-${acct}-${sec}-${date}`);
}

function seedSell(acct: number, sec: number, date: string, qty: number, price: number): void {
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
     VALUES (?, ?, ?, 'SELL', ?, ?, ?, ?)`
  ).run(acct, sec, date, qty, price, qty * price, `sell-${acct}-${sec}-${date}`);
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

async function tiles(searchParams: Record<string, string>): Promise<TaxLotSummary> {
  const { default: TaxLotsPage } = await import("@/app/dashboard/tax-lots/page");
  const element = await TaxLotsPage({ searchParams: Promise.resolve(searchParams) });
  const cards = findByType(element, TaxLotSummaryCards);
  expect(cards, "expected a TaxLotSummaryCards element in the returned tree").not.toBeNull();
  return cards!.props!.summary as TaxLotSummary;
}

describe("TaxLotsPage — engine-estimated disclosure survives every filter path", () => {
  let zzaId: number;
  let zzbId: number;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    hoisted.db = db;

    const ibkr = accountId("IBKR");
    // ZZA: an ordinary sale, +$200 short-term.
    zzaId = seedStock("ZZA");
    seedBuy(ibkr, zzaId, "2026-01-05", 10, 100);
    seedSell(ibkr, zzaId, "2026-03-01", 10, 120);
    // ZZB: becomes the engine-owned RECONCILE_CLOSE, +$300 short-term.
    zzbId = seedStock("ZZB");
    seedBuy(ibkr, zzbId, "2026-01-05", 10, 100);
    seedSell(ibkr, zzbId, "2026-04-01", 10, 130);

    computeTaxLots(db);
    db.prepare(
      `UPDATE transactions SET type = 'RECONCILE_CLOSE'
       WHERE id IN (SELECT sale_transaction_id FROM tax_lot_sales WHERE sale_date = '2026-04-01')`
    ).run();
  });

  it("unfiltered: tiles carry the whole economic total AND the disclosure", async () => {
    const summary = await tiles({ year: "2026" });
    expect(summary.totalRealizedGain).toBe(500);
    expect(summary.engineEstimatedSales).toBe(1);
    expect(summary.engineEstimatedGain).toBe(300);
    expect(summary.engineEstimatedShortTermSales).toBe(1);
    expect(summary.engineEstimatedShortTermGain).toBe(300);
  });

  it("account pill only (account-wide summary path): disclosure preserved", async () => {
    const summary = await tiles({ year: "2026", account: "IBKR" });
    expect(summary.totalRealizedGain).toBe(500);
    expect(summary.engineEstimatedSales).toBe(1);
    expect(summary.engineEstimatedGain).toBe(300);
  });

  it("security filter (filtered-rows path): disclosure narrows with the rows", async () => {
    const engineOnly = await tiles({ year: "2026", security: String(zzbId) });
    expect(engineOnly.totalRealizedGain).toBe(300);
    expect(engineOnly.engineEstimatedSales).toBe(1);
    expect(engineOnly.engineEstimatedGain).toBe(300);
    expect(engineOnly.engineEstimatedShortTermGain).toBe(300);

    const realOnly = await tiles({ year: "2026", security: String(zzaId) });
    expect(realOnly.totalRealizedGain).toBe(200);
    expect(realOnly.engineEstimatedSales).toBe(0);
    expect(realOnly.engineEstimatedGain).toBe(0);
    expect(realOnly.engineEstimatedShortTermSales).toBe(0);
  });

  it("security + account filter: still the filtered rows, never the account-wide figures", async () => {
    const summary = await tiles({ year: "2026", security: String(zzaId), account: "IBKR" });
    expect(summary.totalRealizedGain).toBe(200);
    expect(summary.engineEstimatedSales).toBe(0);
    expect(summary.engineEstimatedGain).toBe(0);
  });
});
