/**
 * Unit C01 (Tax Lots page): the `?pending=1` filter and the security-filter
 * disclosure, checked on the page function itself.
 *
 * Same idiom as tests/pages/tax-lots-page-security-account-filter.test.ts:
 * mock the `@/lib/db` singleton, call the page, and read the props of the
 * child elements in the returned tree (children are never executed).
 * Synthetic tickers and round numbers only.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { getOpenTaxLots, type TaxLotWithSecurity } from "@/lib/queries/tax-lots";
import { TaxLotSummaryCards } from "@/app/dashboard/components/TaxLotSummary";
import { OpenLotsTable } from "@/app/dashboard/components/TaxLotTables";
import { TaxReportCard } from "@/app/dashboard/components/TaxReportCard";
import {
  createPendingTestDb,
  seedSec,
  seedFill,
  seedHold,
  seedPx,
} from "../setup/pending-statement-fixtures";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

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

let db: Database.Database;
let held: number;
let pending: number;

async function render(params: Record<string, string>) {
  const { default: TaxLotsPage } = await import("@/app/dashboard/tax-lots/page");
  const element = await TaxLotsPage({ searchParams: Promise.resolve(params) });
  const table = findByType(element, OpenLotsTable);
  const cards = findByType(element, TaxLotSummaryCards);
  const report = findByType(element, TaxReportCard);
  return {
    lots: (table?.props?.lots ?? []) as TaxLotWithSecurity[],
    pendingOnly: table?.props?.pendingOnly as boolean | undefined,
    pendingFilter: cards?.props?.pendingFilter as { href: string; active: boolean } | undefined,
    summary: cards?.props?.summary as { totalOpenLots: number; totalUnrealizedGain: number },
    reportProps: report?.props ?? {},
  };
}

function seedBook(withPending: boolean) {
  db = createPendingTestDb();
  hoisted.db = db;
  // HELDX: still held per the statement.
  held = seedSec(db, "HELDX");
  seedFill(db, 3, held, "2026-05-01", "BUY", 10, 100);
  seedHold(db, 3, held, "2026-07-10", "stmt", 10);
  seedPx(db, held, "2026-07-10", 120);
  // PENDX: two lots, flat only in live data.
  pending = seedSec(db, "PENDX");
  seedFill(db, 3, pending, "2026-05-01", "BUY", 5, 100);
  seedFill(db, 3, pending, "2026-05-02", "BUY", 5, 100);
  if (withPending) seedHold(db, 3, pending, "2026-07-10", "live-zero");
  else seedHold(db, 3, pending, "2026-07-10", "stmt", 10);
  seedPx(db, pending, "2026-07-10", 150);
  computeTaxLots(db);
}

describe("?pending=1 narrows the Open Lots table to pending-statement lots", () => {
  beforeEach(() => seedBook(true));

  it("without the param the table lists every open lot and the line links to the filter", async () => {
    const r = await render({ year: "2026" });
    expect(r.lots.map((l) => l.symbol).sort()).toEqual(["HELDX", "PENDX", "PENDX"]);
    expect(r.pendingOnly).toBe(false);
    expect(r.pendingFilter).toEqual({ href: "/dashboard/tax-lots?year=2026&pending=1", active: false });
  });

  it("with the param only the flagged lots are listed, and the link leads back", async () => {
    const r = await render({ year: "2026", pending: "1" });
    expect(r.lots.map((l) => l.symbol)).toEqual(["PENDX", "PENDX"]);
    expect(r.lots.every((l) => l.pending_statement)).toBe(true);
    expect(r.pendingOnly).toBe(true);
    expect(r.pendingFilter).toEqual({ href: "/dashboard/tax-lots?year=2026", active: true });
  });

  it("the tiles do not move when the table is narrowed", async () => {
    const all = await render({ year: "2026" });
    const narrowed = await render({ year: "2026", pending: "1" });
    expect(narrowed.summary.totalOpenLots).toBe(all.summary.totalOpenLots);
    expect(narrowed.summary.totalUnrealizedGain).toBe(all.summary.totalUnrealizedGain);
    expect(all.summary.totalOpenLots).toBe(3);
  });

  it("the filter link keeps the account, the security filter and the table sort", async () => {
    const r = await render({
      account: "IBKR",
      security: String(pending),
      openLotsSort: "symbol",
      openLotsDir: "asc",
    });
    const url = new URL(r.pendingFilter!.href, "http://localhost");
    expect(url.pathname).toBe("/dashboard/tax-lots");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      account: "IBKR",
      security: String(pending),
      openLotsSort: "symbol",
      openLotsDir: "asc",
      pending: "1",
    });
  });

  it("the page reads the flag from the shared read model, the same rows getOpenTaxLots flags", async () => {
    const r = await render({ pending: "1" });
    const flagged = getOpenTaxLots(db).filter((l) => l.pending_statement).map((l) => l.id).sort();
    expect(r.lots.map((l) => l.id).sort()).toEqual(flagged);
  });
});

describe("?pending=1 with nothing pending", () => {
  beforeEach(() => seedBook(false));

  it("is ignored: the table keeps every open lot and no filter link is offered", async () => {
    const r = await render({ pending: "1" });
    expect(r.lots).toHaveLength(3);
    expect(r.pendingOnly).toBe(false);
    expect(r.pendingFilter).toBeUndefined();
  });

  it("is ignored when the pending lots sit outside the narrowed scope", async () => {
    seedBook(true);
    const r = await render({ pending: "1", security: String(held) });
    expect(r.lots.map((l) => l.symbol)).toEqual(["HELDX"]);
    expect(r.pendingOnly).toBe(false);
    expect(r.pendingFilter).toBeUndefined();
  });
});

describe("the security filter is disclosed to the Tax Report card, never applied to it", () => {
  beforeEach(() => seedBook(true));

  it("passes the filtered symbol as a label and still scopes the card by account only", async () => {
    const r = await render({ security: String(held), account: "IBKR" });
    expect(r.reportProps.unappliedSecuritySymbol).toBe("HELDX");
    expect(r.reportProps.accountName).toBe("IBKR");
    expect(Object.keys(r.reportProps)).not.toContain("securityId");
  });

  it("passes nothing when no security filter is active or the id does not resolve", async () => {
    expect((await render({})).reportProps.unappliedSecuritySymbol).toBeUndefined();
    expect((await render({ security: "999999" })).reportProps.unappliedSecuritySymbol).toBeUndefined();
  });
});

describe("open-lot rows carry the contract multiplier for the unit label", () => {
  it("COALESCEs a NULL multiplier to 1 and reads a stored one", () => {
    seedBook(false);
    const opt = seedSec(db, "AAA   270115C00100000", "Option");
    db.prepare("UPDATE securities SET multiplier = 100 WHERE id = ?").run(opt);
    db.prepare("UPDATE securities SET multiplier = NULL WHERE id = ?").run(held);
    seedFill(db, 3, opt, "2026-05-01", "BUY", 2, 3);
    computeTaxLots(db);
    const lots = getOpenTaxLots(db);
    expect(lots.find((l) => l.security_id === opt)!.multiplier).toBe(100);
    expect(lots.find((l) => l.security_id === held)!.multiplier).toBe(1);
  });
});
