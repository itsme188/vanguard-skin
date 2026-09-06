/**
 * QA finding tax-lots--non-numeric-year-renders-nan-tiles-and-tax-report-400:
 * `/dashboard/tax-lots?year=all` (any non-numeric year) rendered the
 * headline tiles as "NAN REALIZED / NAN LONG-TERM / NAN SHORT-TERM" and the
 * TaxReportCard fetched `/api/tax-report?year=NaN`, which 400s — the CSV and
 * TXF export buttons vanished with it.
 *
 * Root cause: app/dashboard/tax-lots/page.tsx did a bare
 * `parseInt(searchParams.year, 10)` with no validation, so NaN flowed into
 * every consumer. Fix: `resolveSelectedYear` (app/dashboard/tax-lots/
 * select-year.ts) accepts only an integer inside the same [2000, 2100]
 * window the API enforces and otherwise falls back exactly like an absent
 * param.
 *
 * The page-level check is clock-independent on purpose: it compares the
 * `?year=all` render against the no-param render instead of asserting a
 * literal year, so it cannot go stale when the calendar year rolls over.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { YearSelector } from "@/app/dashboard/components/YearSelector";
import { TaxReportCard } from "@/app/dashboard/components/TaxReportCard";
import { TaxLotSummaryCards } from "@/app/dashboard/components/TaxLotSummary";
import { resolveSelectedYear } from "@/app/dashboard/tax-lots/select-year";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

let db: Database.Database;

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

function seedOneClosedSale(): void {
  const ibkr = (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;
  const secId = db
    .prepare("INSERT INTO securities (symbol, name, security_type) VALUES ('AAPL', 'AAPL Corp', 'stock')")
    .run().lastInsertRowid as number;
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
     VALUES (?, ?, '2024-01-05', 'BUY', 10, 100, -1000, 'buy-year-param')`,
  ).run(ibkr, secId);
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, source_key)
     VALUES (?, ?, '2024-02-01', 'SELL', 10, 120, 1200, 'sell-year-param')`,
  ).run(ibkr, secId);
  computeTaxLots(db);
}

describe("resolveSelectedYear", () => {
  const available = [2026, 2025, 2024];

  it("keeps a valid four-digit year even when it has no sales", () => {
    expect(resolveSelectedYear("2019", available, 2026)).toBe(2019);
    expect(resolveSelectedYear("2024", available, 2026)).toBe(2024);
  });

  it("falls back like an absent param for non-numeric input", () => {
    for (const raw of ["all", "NaN", "abc", "", undefined]) {
      expect(resolveSelectedYear(raw, available, 2026)).toBe(2026);
    }
  });

  it("falls back for out-of-range years and never returns NaN", () => {
    expect(resolveSelectedYear("1999", available, 2026)).toBe(2026);
    expect(resolveSelectedYear("2101", available, 2026)).toBe(2026);
    expect(resolveSelectedYear("-5", available, 2026)).toBe(2026);
    expect(Number.isNaN(resolveSelectedYear("all", [], 2026))).toBe(false);
  });

  it("prefers the current calendar year when it has sales, else the latest sale year", () => {
    expect(resolveSelectedYear(undefined, [2026, 2025], 2026)).toBe(2026);
    expect(resolveSelectedYear("all", [2025, 2024], 2026)).toBe(2025);
    expect(resolveSelectedYear("all", [], 2026)).toBe(2026);
  });
});

describe("TaxLotsPage — non-numeric ?year= (QA regression)", () => {
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    hoisted.db = db;
    seedOneClosedSale();
  });

  it("renders ?year=all exactly like the no-param page — a finite year everywhere, never NaN", async () => {
    const { default: TaxLotsPage } = await import("@/app/dashboard/tax-lots/page");

    const baseline = await TaxLotsPage({ searchParams: Promise.resolve({}) });
    const withAll = await TaxLotsPage({ searchParams: Promise.resolve({ year: "all" }) });

    const baselineYear = findByType(baseline, YearSelector)!.props!.currentYear as number;
    const selector = findByType(withAll, YearSelector);
    const report = findByType(withAll, TaxReportCard);
    const cards = findByType(withAll, TaxLotSummaryCards);
    expect(selector, "YearSelector must render").not.toBeNull();
    expect(report, "TaxReportCard must render").not.toBeNull();
    expect(cards, "TaxLotSummaryCards must render").not.toBeNull();

    expect(Number.isFinite(baselineYear)).toBe(true);
    expect(selector!.props!.currentYear).toBe(baselineYear);
    expect(report!.props!.year).toBe(baselineYear);
    expect(cards!.props!.year).toBe(baselineYear);
  });

  it("still honors an explicit valid year", async () => {
    const { default: TaxLotsPage } = await import("@/app/dashboard/tax-lots/page");
    const element = await TaxLotsPage({ searchParams: Promise.resolve({ year: "2024" }) });
    expect(findByType(element, YearSelector)!.props!.currentYear).toBe(2024);
    expect(findByType(element, TaxReportCard)!.props!.year).toBe(2024);
  });
});
