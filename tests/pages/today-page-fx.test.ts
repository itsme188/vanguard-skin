/**
 * Today page — IBKR "today's move" list FX conversion (Task 7a).
 *
 * Commit bdb62a4 added the fx_rates join + fxExpr arg to the two inline
 * adjustedMarketValueSQL() calls in app/dashboard/today/page.tsx (current +
 * prior market value for the IBKR holdings list) but shipped with no test —
 * pre-fix, a KRW holding rendered its won notional as if it were dollars
 * (402340.KS: 10 sh @ ₩1,731,000 rendered as a $17.3M "today's move" phantom).
 *
 * TodayPage is a plain `export default async function TodayPage(props)` with
 * no cookies()/headers()/redirect()/notFound() — it's directly invocable. We
 * call it and walk the RETURNED REACT ELEMENT TREE without rendering: none of
 * TodayPage's imported child components (Money, Link, EarningsHub, etc.) are
 * actually executed by React, so their "use client" hooks / DB imports never
 * run. We only need TodayPage's own inline holdings <ul>/<li>/<Money> element
 * objects, which TodayPage builds directly (not delegated to a subcomponent).
 *
 * Follows the tests/api/routes.test.ts precedent: mock the `@/lib/db`
 * singleton via vi.mock + vi.hoisted BEFORE importing the page module, then
 * swap in an in-memory better-sqlite3 DB per test.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { upsertFxRate } from "@/lib/mutations/fx-rates";
import { Money } from "@/lib/privacy/components";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

let db: Database.Database;

// ─── Seed helpers ──────────────────────────────────────────────────

// Migration 002_seed_accounts.sql already seeds 'IBKR' (+ the two Vanguard
// accounts) via INSERT OR IGNORE — look it up rather than re-inserting.
function getAccountId(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (
    db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as {
      id: number;
    }
  ).id;
}

function seedSecurity(symbol: string, currency: string): number {
  const result = db
    .prepare(
      "INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'stock', ?)"
    )
    .run(symbol, `${symbol} Test Corp`, currency);
  return result.lastInsertRowid as number;
}

function seedHolding(
  accountId: number,
  securityId: number,
  quantity: number,
  asOfDate = "2026-07-01"
) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, ?, ?)"
  ).run(accountId, securityId, quantity, asOfDate);
}

/** Current + prior close so the ranked_prices CTE (rn=1 / rn=2) yields a
 *  today_gain row, matching how the page's real IBKR data looks. */
function seedPrices(securityId: number, currentPrice: number, priorPrice: number) {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')"
  ).run(securityId, "2026-07-01", currentPrice);
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')"
  ).run(securityId, "2026-06-30", priorPrice);
}

// ─── Minimal JSX-tree walker ───────────────────────────────────────
// TodayPage() returns plain React element objects ({type, props}) — we never
// hand them to a renderer, so imported child components (Money included, even
// though it's "use client") are never invoked; we only read their props.

interface ElementLike {
  type: unknown;
  props?: {
    children?: unknown;
    href?: unknown;
    value?: unknown;
    [key: string]: unknown;
  };
}

function isElement(node: unknown): node is ElementLike {
  return typeof node === "object" && node !== null && "type" in node && "props" in node;
}

function collectDescendants(node: unknown, out: ElementLike[]): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) {
    for (const child of node) collectDescendants(child, out);
    return;
  }
  if (!isElement(node)) return;
  out.push(node);
  collectDescendants(node.props?.children, out);
}

function collectStrings(node: unknown, out: string[]): void {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, out);
    return;
  }
  if (isElement(node)) collectStrings(node.props?.children, out);
}

/**
 * Find the <Money value={...}> prop at `index` within the holdings <li> whose
 * symbol text matches `symbol`. Money element order per <li> (pre-order,
 * matches JSX child order in page.tsx): 0 = current_price (precise),
 * 1 = current_value, 2 = today_gain (present only when prior close exists).
 */
function findHoldingMoneyValue(root: unknown, symbol: string, index: number): number | null {
  const all: ElementLike[] = [];
  collectDescendants(root, all);

  const links = all.filter(
    (el) =>
      typeof el.props?.href === "string" &&
      (el.props.href as string).startsWith("/dashboard/security/")
  );

  for (const link of links) {
    const strings: string[] = [];
    collectStrings(link.props?.children, strings);
    if (!strings.includes(symbol)) continue;

    const descendants: ElementLike[] = [];
    collectDescendants(link.props?.children, descendants);
    const moneys = descendants.filter((el) => el.type === Money);
    if (moneys[index] === undefined) return null;
    return (moneys[index].props?.value as number | null) ?? null;
  }
  return null;
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("TodayPage — IBKR holdings list FX conversion (Task 7a)", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    hoisted.db = db;
  });

  it("renders the KRW holding's current_value in USD (~$12,705), not the ₩17.31M notional", async () => {
    const { default: TodayPage } = await import("@/app/dashboard/today/page");

    const acctId = getAccountId("IBKR");

    // KRW holding: 10 sh @ ₩1,731,000 current / ₩1,700,000 prior.
    const krwId = seedSecurity("402340", "KRW");
    seedHolding(acctId, krwId, 10);
    seedPrices(krwId, 1_731_000, 1_700_000);
    upsertFxRate(db, {
      currency: "KRW",
      usdPerUnit: 0.000734,
      asOf: "2026-07-01",
      source: "test",
    });

    // USD control: 5 sh @ $208 current / $205 prior. No fx_rates row for USD —
    // COALESCE(fx.usd_per_unit, 1) falls back to 1, so this must render
    // completely unchanged by the FX join.
    const usdId = seedSecurity("AAPL", "USD");
    seedHolding(acctId, usdId, 5);
    seedPrices(usdId, 208, 205);

    const element = await TodayPage({ searchParams: Promise.resolve({}) });

    const krwValue = findHoldingMoneyValue(element, "402340", 1);
    const usdValue = findHoldingMoneyValue(element, "AAPL", 1);

    expect(krwValue).not.toBeNull();
    expect(usdValue).not.toBeNull();

    const expectedKrwUsd = 10 * 1_731_000 * 0.000734; // ≈ $12,705.54
    expect(krwValue!).toBeCloseTo(expectedKrwUsd, 5);
    expect(krwValue!).toBeLessThan(20_000);

    // Pre-fix this rendered the raw won notional (10 * 1,731,000 = 17,310,000)
    // as if it were dollars — the finding's headline $17.3M phantom.
    expect(krwValue!).not.toBeCloseTo(10 * 1_731_000, 0);

    // USD control unchanged: 5 * 208 = $1,040.
    expect(usdValue).toBe(5 * 208);
  });
});
