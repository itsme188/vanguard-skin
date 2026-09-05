/**
 * Today page — IBKR "today's move" one-line snapshot, FX conversion.
 *
 * Commit bdb62a4 added the fx_rates join to the market-value SQL behind the
 * Today page's IBKR figures — pre-fix, a KRW holding rendered its won notional
 * as if it were dollars (10 sh @ ₩1,731,000 read as a $17.3M phantom). That
 * conversion now lives in lib/queries/today-holdings.ts, which multiplies both
 * prices and all three market values by COALESCE(fx.usd_per_unit, 1).
 *
 * RE-POINTED BY SLICE F (ruling R-F30): Task 10 deliberately deleted Today's
 * per-name IBKR holdings list — spec §2 / M-F1, "the per-name list is gone from
 * Today — it lives on Accounts" — so the original assertion pinned a surface
 * that no longer exists. Today still renders money, though: the one-line
 * snapshot sums `today_gain` and `current_value` across every holding and
 * renders `<Money value={todayGain} signed />` plus a `<Pct>`. That SUM is now
 * where a dropped conversion would surface, so the FX protection moved there.
 * The KRW fixture is kept deliberately: a holding whose notional is ~1,400x its
 * dollar value makes a missing conversion unmissable in the summed figure.
 *
 * TodayPage is a plain `export default async function TodayPage(props)` with
 * no cookies()/headers()/redirect()/notFound() — it's directly invocable. We
 * call it and walk the RETURNED REACT ELEMENT TREE without rendering: none of
 * TodayPage's imported child components (Money, Link, EarningsHub, etc.) are
 * actually executed by React, so their "use client" hooks / DB imports never
 * run. We only need TodayPage's own inline snapshot <Money>/<Pct> element
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
import { Money, Pct } from "@/lib/privacy/components";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

let db: Database.Database;

// The move pair getIbkrTodayHoldings uses is resolved from SPY's two most
// recent CONSECUTIVE trading days (resolveTradingDayPair), read purely from
// `prices` rows — no wall clock — so these fixed dates never go stale.
// 2026-06-30 (Tue) and 2026-07-01 (Wed) are consecutive open sessions.
const PAIR_LATEST = "2026-07-01";
const PAIR_PRIOR = "2026-06-30";

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
  asOfDate = PAIR_LATEST
) {
  db.prepare(
    "INSERT INTO holdings (account_id, security_id, quantity, as_of_date) VALUES (?, ?, ?, ?)"
  ).run(accountId, securityId, quantity, asOfDate);
}

/** Closes on both pair dates so the holding contributes a today_gain, matching
 *  how the page's real IBKR data looks. */
function seedPrices(securityId: number, currentPrice: number, priorPrice: number) {
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')"
  ).run(securityId, PAIR_LATEST, currentPrice);
  db.prepare(
    "INSERT INTO prices (security_id, date, close_price, source) VALUES (?, ?, ?, 'test')"
  ).run(securityId, PAIR_PRIOR, priorPrice);
}

/** SPY is the market clock resolveTradingDayPair reads — it is not held, it
 *  only supplies the two consecutive session dates. */
function seedMarketClock() {
  seedPrices(seedSecurity("SPY", "USD"), 500, 498);
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
 * The one-line IBKR snapshot row: the INNERMOST element that carries both the
 * "IBKR today" heading text and at least one <Money> descendant. Anchoring on
 * the heading (rather than on element order) keeps the finder pinned to this
 * surface even as siblings move around it.
 */
function findSnapshotRow(root: unknown): ElementLike | null {
  const all: ElementLike[] = [];
  collectDescendants(root, all);

  let best: ElementLike | null = null;
  let bestSize = Infinity;

  for (const el of all) {
    const strings: string[] = [];
    collectStrings(el.props?.children, strings);
    if (!strings.some((s) => s.includes("IBKR today"))) continue;

    const descendants: ElementLike[] = [];
    collectDescendants(el.props?.children, descendants);
    if (!descendants.some((d) => d.type === Money)) continue;

    if (descendants.length < bestSize) {
      best = el;
      bestSize = descendants.length;
    }
  }
  return best;
}

/** The `value` prop of the single <Money>/<Pct> inside the snapshot row. */
function snapshotValue(row: ElementLike | null, kind: unknown): number | null {
  if (row === null) return null;
  const descendants: ElementLike[] = [];
  collectDescendants(row.props?.children, descendants);
  const matches = descendants.filter((el) => el.type === kind);
  if (matches.length !== 1) return null;
  return (matches[0].props?.value as number | null) ?? null;
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("TodayPage — IBKR one-line snapshot FX conversion", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    hoisted.db = db;
  });

  it("sums today's move in CONVERTED dollars — a KRW name contributes ~$228, not its ₩310k notional", async () => {
    const { default: TodayPage } = await import("@/app/dashboard/today/page");

    seedMarketClock();
    const acctId = getAccountId("IBKR");

    // KRW holding: 10 sh @ ₩1,731,000 current / ₩1,700,000 prior.
    const KRW_PER_USD = 0.000734;
    const krwQty = 10;
    const krwCurrent = 1_731_000;
    const krwPrior = 1_700_000;
    const krwId = seedSecurity("XMPL1", "KRW");
    seedHolding(acctId, krwId, krwQty);
    seedPrices(krwId, krwCurrent, krwPrior);
    upsertFxRate(db, {
      currency: "KRW",
      usdPerUnit: KRW_PER_USD,
      asOf: PAIR_LATEST,
      source: "test",
    });

    // USD control: 5 sh @ $208 current / $205 prior. No fx_rates row for USD —
    // COALESCE(fx.usd_per_unit, 1) falls back to 1, so this leg must be
    // completely unchanged by the FX join.
    const usdQty = 5;
    const usdCurrent = 208;
    const usdPrior = 205;
    const usdId = seedSecurity("XMPL2", "USD");
    seedHolding(acctId, usdId, usdQty);
    seedPrices(usdId, usdCurrent, usdPrior);

    const element = await TodayPage({ searchParams: Promise.resolve({}) });
    const row = findSnapshotRow(element);
    expect(row).not.toBeNull();

    const renderedGain = snapshotValue(row, Money);
    const renderedPct = snapshotValue(row, Pct);
    expect(renderedGain).not.toBeNull();
    expect(renderedPct).not.toBeNull();

    // Expected: each leg's move converted to USD, then summed.
    const krwGainUsd = krwQty * (krwCurrent - krwPrior) * KRW_PER_USD; // ≈ $227.54
    const usdGain = usdQty * (usdCurrent - usdPrior); //                  = $15.00
    const expectedGain = krwGainUsd + usdGain; //                         ≈ $242.54
    expect(renderedGain!).toBeCloseTo(expectedGain, 6);

    // Drop the conversion and the KRW leg alone contributes its raw won move
    // (10 × 31,000 = ₩310,000) as if it were dollars — a ~1,280x inflation of
    // the whole line. This is the assertion that sees a lost FX factor.
    const unconvertedGain = krwQty * (krwCurrent - krwPrior) + usdGain;
    expect(renderedGain!).not.toBeCloseTo(unconvertedGain, 0);
    expect(renderedGain!).toBeLessThan(1_000);

    // The percent is gain ÷ prior close, both summed from the same converted
    // market values. It is a WEAKER signal than the dollar figure (dropping FX
    // from both numerator and denominator nearly cancels), so it is pinned as
    // a consistency check, not as the FX guard.
    const krwCurrentValueUsd = krwQty * krwCurrent * KRW_PER_USD; // ≈ $12,705.54
    const usdCurrentValue = usdQty * usdCurrent; //                   = $1,040.00
    const priorClose = krwCurrentValueUsd + usdCurrentValue - expectedGain;
    expect(renderedPct!).toBeCloseTo((expectedGain / priorClose) * 100, 6);
  });
});
