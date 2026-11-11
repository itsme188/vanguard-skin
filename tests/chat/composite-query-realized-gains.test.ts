/**
 * query_realized_gains (Portfolio Assistant plan, Task 6; P8).
 *
 * Protects: the realized-gain totals the chat quotes are the Tax Report
 * card's own (generateTaxReport, same year and account), retirement-account
 * sales stay out, a one-account answer carries no wash-sale fact about
 * another account, and the figures say NOT FOR FILING until the year is
 * broker-accepted. Bound: the hand-worked book gives short-term gain 200 with
 * a 300 wash-sale adjustment and long-term gain 300, to the cent; the
 * per-account totals sum to the all-accounts totals within 0.01.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";

vi.mock("@/lib/compute/tax-report", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/compute/tax-report")>();
  return { ...actual, generateTaxReport: vi.fn(actual.generateTaxReport) };
});

import { generateTaxReport } from "@/lib/compute/tax-report";
import { queryRealizedGainsTool } from "@/lib/chat/composite/realized-gains";
import { COMPOSITE_MAX_JSON_CHARS } from "@/lib/chat/composite/shared";

const TODAY = "2025-11-20";
const YEAR = 2025;
let db: Database.Database;
const secIds = new Map<string, number>();

function sec(symbol: string): number {
  const existing = secIds.get(symbol);
  if (existing) return existing;
  const id = db
    .prepare("INSERT INTO securities (symbol, name, security_type, currency) VALUES (?, ?, 'Stock', 'USD')")
    .run(symbol, `${symbol} Co`).lastInsertRowid as number;
  secIds.set(symbol, id);
  return id;
}

function lot(accountId: number, symbol: string, acquired: string, qty: number, cost: number): number {
  const remaining = 0;
  return db
    .prepare(
      `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(accountId, sec(symbol), acquired, cost / qty, qty, remaining, cost).lastInsertRowid as number;
}

function sale(lotId: number, accountId: number, symbol: string, date: string, qty: number, proceeds: number, cost: number, longTerm: boolean): void {
  const txId = db
    .prepare(
      "INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, source_key) VALUES (?, ?, ?, 'SELL', ?, ?, ?)",
    )
    .run(accountId, sec(symbol), date, -qty, proceeds, `s-${lotId}`).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, quantity_sold, sale_price, proceeds, cost_basis_allocated,
       realized_gain_loss, is_long_term, holding_period_days, sale_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(lotId, txId, qty, proceeds / qty, proceeds, cost, proceeds - cost, longTerm ? 1 : 0, longTerm ? 800 : 60, date);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  secIds.clear();
  vi.mocked(generateTaxReport).mockClear();
  db.prepare("UPDATE accounts SET tax_treatment = 'roth_ira' WHERE id = 2").run();
  // Taxable (1): short-term gain 200, long-term gain 300, and a 300 loss on
  // CCC that IBKR (3) replaces 14 days later (a wash sale across accounts).
  sale(lot(1, "AAA", "2025-01-10", 10, 1000), 1, "AAA", "2025-03-10", 10, 1200, 1000, false);
  sale(lot(1, "BBB", "2023-01-05", 5, 500), 1, "BBB", "2025-04-01", 5, 800, 500, true);
  sale(lot(1, "CCC", "2025-02-01", 9, 900), 1, "CCC", "2025-06-01", 9, 600, 900, false);
  lot(3, "CCC", "2025-06-15", 9, 610);
  // Roth (2): a 50 gain that is not a taxable event.
  sale(lot(2, "AAA", "2025-01-15", 1, 100), 2, "AAA", "2025-05-01", 1, 150, 100, false);
});

type Total = { proceeds: number; cost_basis: number; adjustments?: number; gain_loss: number; rows: number };
type Out = {
  error?: string;
  year: number;
  filing_ready: boolean;
  not_for_filing?: boolean;
  retirement_account: boolean;
  short_term: Total;
  long_term: Total;
  wash_sales: { count: number; shown?: { symbol: string; replacement_date: string }[]; note?: string };
  excluded: { retirement_accounts: string[]; non_usd_sales: number };
  rows?: Record<string, unknown>[];
  list_info?: { returned: number; truncated: boolean };
};

describe("query_realized_gains", () => {
  it("returns the engine's totals for the same year and account (parity)", () => {
    const out = queryRealizedGainsTool.run(db, {}, { accountIds: undefined, today: TODAY }) as Out;
    const engine = generateTaxReport(db, YEAR, { accountName: null });
    expect(out.year).toBe(YEAR);
    expect(out.short_term.gain_loss).toBe(engine.shortTermTotal.gainLoss);
    expect(out.short_term.proceeds).toBe(engine.shortTermTotal.proceeds);
    expect(out.short_term.adjustments).toBe(engine.shortTermTotal.adjustments);
    expect(out.long_term.gain_loss).toBe(engine.longTermTotal.gainLoss);
    expect(out.filing_ready).toBe(engine.filingReady);
    expect(out.wash_sales.count).toBe(engine.washSaleWarnings.length);
  });

  it("matches the hand-worked book and leaves the Roth sale out", () => {
    const out = queryRealizedGainsTool.run(db, { year: YEAR }, { accountIds: undefined, today: TODAY }) as Out;
    expect(out.short_term).toEqual({ proceeds: 1800, cost_basis: 1900, adjustments: 300, gain_loss: 200, rows: 2 });
    expect(out.long_term).toEqual({ proceeds: 800, cost_basis: 500, adjustments: 0, gain_loss: 300, rows: 1 });
    expect(out.wash_sales.count).toBe(1);
    expect(out.wash_sales.shown?.[0]).toMatchObject({ symbol: "CCC", replacement_date: "2025-06-15" });
    expect(out.excluded.retirement_accounts).toEqual(["Vanguard Roth IRA"]);
    expect(out.filing_ready).toBe(false);
    expect(out.not_for_filing).toBe(true);
  });

  it("a one-account answer gives the wash-sale count only (P8)", () => {
    const out = queryRealizedGainsTool.run(
      db,
      { include_rows: true },
      { accountIds: [1], accountName: "Vanguard Taxable", today: TODAY },
    ) as Out;
    expect(out.short_term.gain_loss).toBe(200);
    expect(out.short_term.adjustments).toBeUndefined();
    expect(out.wash_sales.shown).toBeUndefined();
    expect(out.wash_sales.note).toBe(
      "1 possible wash sale; the replacement purchases may sit in other accounts; see the All Accounts scope.",
    );
    const text = JSON.stringify(out);
    expect(text).not.toContain("2025-06-15");
    expect(text).not.toContain("IBKR");
    expect(text).not.toContain("Roth");
    expect(text).not.toContain("adjustment_code");
    expect(out.rows).toHaveLength(3);
  });

  it("per-account totals sum to the all-accounts totals (conservation)", () => {
    const all = queryRealizedGainsTool.run(db, {}, { accountIds: undefined, today: TODAY }) as Out;
    let st = 0;
    let lt = 0;
    for (const id of [1, 2, 3]) {
      const one = queryRealizedGainsTool.run(db, {}, { accountIds: [id], today: TODAY }) as Out;
      st += one.short_term.gain_loss;
      lt += one.long_term.gain_loss;
    }
    expect(Math.abs(st - all.short_term.gain_loss)).toBeLessThan(0.01);
    expect(Math.abs(lt - all.long_term.gain_loss)).toBeLessThan(0.01);
  });

  it("says when no account is marked tax-advantaged (R6-3)", () => {
    const marked = queryRealizedGainsTool.run(db, {}, { accountIds: undefined, today: TODAY }) as Out & {
      retirement_accounts_marked: boolean;
      retirement_note?: string;
    };
    expect(marked.retirement_accounts_marked).toBe(true);
    expect(marked.retirement_note).toBeUndefined();
    db.prepare("UPDATE accounts SET tax_treatment = 'taxable'").run();
    const unmarked = queryRealizedGainsTool.run(db, {}, { accountIds: undefined, today: TODAY }) as Out & {
      retirement_accounts_marked: boolean;
      retirement_note?: string;
    };
    expect(unmarked.retirement_accounts_marked).toBe(false);
    expect(unmarked.retirement_note).toBe(
      "No account is marked as a retirement account yet, so the sales of an IRA, if any, are still inside these totals.",
    );
    // The Roth's 50 gain is now inside the short-term total: 200 + 50.
    expect(unmarked.short_term.gain_loss).toBe(250);
  });

  it("a Roth-scoped answer is flagged as a retirement account with zero totals", () => {
    const out = queryRealizedGainsTool.run(db, {}, { accountIds: [2], today: TODAY }) as Out;
    expect(out.retirement_account).toBe(true);
    expect(out.short_term.gain_loss).toBe(0);
  });

  it("a scope of several accounts is refused, naming only those accounts", () => {
    const out = queryRealizedGainsTool.run(db, {}, { accountIds: [1, 3], today: TODAY }) as Out;
    expect(out.error).toMatch(/one account at a time/);
    expect(out.error).toContain('"Vanguard Taxable", "IBKR"');
    expect(out.error).not.toContain("Roth");
    expect(generateTaxReport).not.toHaveBeenCalled();
  });

  it("an empty scope answers without calling the engine", () => {
    const out = queryRealizedGainsTool.run(db, {}, { accountIds: [], today: TODAY });
    expect(out).toEqual({ error: "No account is in this chat's scope." });
    expect(generateTaxReport).not.toHaveBeenCalled();
  });

  it("rejects a bad year", () => {
    const out = queryRealizedGainsTool.run(db, { year: "last" }, { accountIds: undefined, today: TODAY }) as Out;
    expect(out.error).toBe("year must be an integer from 2000 to 2100.");
  });

  it("caps rows with list_info, writes nothing and stays under the size cap with 60 sales", () => {
    for (let i = 0; i < 60; i++) {
      sale(lot(1, `Z${i}`, "2025-01-02", 1, 10 + i), 1, `Z${i}`, "2025-07-01", 1, 20 + i, 10 + i, false);
    }
    const before = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    const out = queryRealizedGainsTool.run(db, { include_rows: true, limit: 500 }, { accountIds: undefined, today: TODAY }) as Out;
    const after = (db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    expect(after).toBe(before);
    expect(out.rows).toHaveLength(25);
    expect(out.list_info?.truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThan(COMPOSITE_MAX_JSON_CHARS);
  });
});
