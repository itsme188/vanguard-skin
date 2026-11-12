/**
 * query_realized_gains (Portfolio Assistant plan, Task 6; P8).
 *
 * Protects: the realized-gain totals the chat quotes are the Tax Report
 * card's own (generateTaxReport, same year and account), retirement-account
 * sales stay out, every answer (one account or all) carries the wash-sale
 * detail with the replacement purchase's account named (owner ruling
 * 2026-11-12, replacing P8's count-only rule), every row and total
 * reconciles as gain = proceeds - cost basis + adjustment, and the figures
 * say NOT FOR FILING until the year is broker-accepted. Bound: the hand-worked book gives short-term gain 200 with
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
import { compactToolOutput } from "@/lib/chat/tools";

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
  wash_sales: {
    count: number;
    shown?: { symbol: string; account: string; replacement_date: string; replacement_accounts: string[]; replacement_outside_this_answer?: string[] }[];
    note?: string;
  };
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

  it("a one-account answer carries the wash-sale detail and names the replacement's account outside the answer", () => {
    const out = queryRealizedGainsTool.run(
      db,
      { include_rows: true },
      { accountIds: [1], accountName: "Vanguard Taxable", today: TODAY },
    ) as Out;
    expect(out.short_term).toEqual({ proceeds: 1800, cost_basis: 1900, adjustments: 300, gain_loss: 200, rows: 2 });
    expect(out.wash_sales.count).toBe(1);
    expect(out.wash_sales.note).toBeUndefined();
    expect(out.wash_sales.shown).toEqual([
      {
        symbol: "CCC",
        account: "Vanguard Taxable",
        sale_date: "2025-06-01",
        replacement_date: "2025-06-15",
        replacement: "after",
        days_from_sale: 14,
        loss: -300,
        replacement_accounts: ["IBKR"],
        replacement_outside_this_answer: ["IBKR"],
      },
    ]);
    const ccc = out.rows?.find((r) => r.symbol === "CCC");
    expect(ccc).toMatchObject({
      account: "Vanguard Taxable",
      proceeds: 600,
      cost_basis: 900,
      gain_loss: 0,
      wash_sale: true,
      adjustment_code: "W",
      adjustment_amount: 300,
      replacement_date: "2025-06-15",
      replacement_accounts: ["IBKR"],
      replacement_outside_this_answer: ["IBKR"],
    });
    expect(out.rows).toHaveLength(3);
    // A non-wash row carries no wash fields.
    const aaa = out.rows?.find((r) => r.symbol === "AAA");
    expect(aaa).not.toHaveProperty("wash_sale");
    expect(aaa).not.toHaveProperty("replacement_accounts");
  });

  it("the all-accounts answer names the replacement's account and flags nothing as outside the answer", () => {
    const out = queryRealizedGainsTool.run(db, {}, { accountIds: undefined, today: TODAY }) as Out;
    expect(out.wash_sales.shown?.[0]).toMatchObject({ account: "Vanguard Taxable", replacement_accounts: ["IBKR"] });
    expect(out.wash_sales.shown?.[0]).not.toHaveProperty("replacement_outside_this_answer");
    const ccc = out.rows?.find((r) => r.symbol === "CCC");
    expect(ccc).toMatchObject({ wash_sale: true, replacement_accounts: ["IBKR"] });
    expect(ccc).not.toHaveProperty("replacement_outside_this_answer");
  });

  it("a replacement inside the chat's own account is named and not flagged as outside", () => {
    // DDD: a 120 loss in Vanguard Taxable, bought back there 5 days earlier.
    sale(lot(1, "DDD", "2025-02-01", 4, 520), 1, "DDD", "2025-07-10", 4, 400, 520, false);
    lot(1, "DDD", "2025-07-05", 4, 410);
    const out = queryRealizedGainsTool.run(db, {}, { accountIds: [1], accountName: "Vanguard Taxable", today: TODAY }) as Out;
    const ddd = out.rows?.find((r) => r.symbol === "DDD");
    expect(ddd).toMatchObject({
      wash_sale: true,
      adjustment_amount: 120,
      replacement_date: "2025-07-05",
      replacement_accounts: ["Vanguard Taxable"],
    });
    expect(ddd).not.toHaveProperty("replacement_outside_this_answer");
    expect(out.short_term.adjustments).toBe(420);
  });

  it("a scoped answer lists other accounts' loss sales that a purchase in its own account washed, outside its totals", () => {
    // HHH: a 200 loss in Vanguard Taxable, bought back in the Roth 3 days later.
    sale(lot(1, "HHH", "2025-02-01", 4, 600), 1, "HHH", "2025-07-01", 4, 400, 600, false);
    lot(2, "HHH", "2025-07-04", 4, 410);
    type Washed = {
      count: number;
      note: string;
      shown: { symbol: string; sale_account: string; sale_date: string; loss: number; replacement_date: string; replacement_accounts: string[] }[];
    };

    // The Roth chat: its own totals are zero (a retirement account), and the
    // washed taxable loss is listed in its own block.
    const roth = queryRealizedGainsTool.run(db, {}, { accountIds: [2], accountName: "Vanguard Roth IRA", today: TODAY }) as Out & {
      washed_by_purchases_in_this_scope?: Washed;
    };
    expect(roth.retirement_account).toBe(true);
    expect(roth.short_term.gain_loss).toBe(0);
    expect(roth.short_term.adjustments).toBe(0);
    expect(roth.washed_by_purchases_in_this_scope).toEqual({
      count: 1,
      note: "Loss sales in other accounts that a purchase in this chat's accounts washed. They are not in this answer's totals or rows.",
      shown: [
        {
          symbol: "HHH",
          sale_account: "Vanguard Taxable",
          sale_date: "2025-07-01",
          loss: -200,
          replacement_date: "2025-07-04",
          replacement_accounts: ["Vanguard Roth IRA"],
        },
      ],
    });

    // The IBKR chat: CCC's replacement sits there; its totals are the engine's
    // own for IBKR, unchanged by the block.
    const ibkr = queryRealizedGainsTool.run(db, {}, { accountIds: [3], accountName: "IBKR", today: TODAY }) as Out & {
      washed_by_purchases_in_this_scope?: Washed;
    };
    const engine = generateTaxReport(db, YEAR, { accountName: "IBKR" });
    expect(ibkr.short_term).toEqual({
      proceeds: engine.shortTermTotal.proceeds,
      cost_basis: engine.shortTermTotal.costBasis,
      adjustments: engine.shortTermTotal.adjustments,
      gain_loss: engine.shortTermTotal.gainLoss,
      rows: engine.shortTermRows.length,
    });
    expect(ibkr.short_term.gain_loss).toBe(0);
    expect(ibkr.wash_sales.count).toBe(0);
    expect(ibkr.rows).toEqual([]);
    expect(ibkr.washed_by_purchases_in_this_scope?.shown.map((w) => [w.symbol, w.sale_account])).toEqual([["CCC", "Vanguard Taxable"]]);

    // The taxable chat sees both in its own wash_sales, and has no such block
    // (its own sales are not "other accounts").
    const taxable = queryRealizedGainsTool.run(db, {}, { accountIds: [1], accountName: "Vanguard Taxable", today: TODAY }) as Out & {
      washed_by_purchases_in_this_scope?: Washed;
    };
    expect(taxable.wash_sales.count).toBe(2);
    expect(taxable.washed_by_purchases_in_this_scope).toBeUndefined();

    // The All Accounts answer has no such block.
    const all = queryRealizedGainsTool.run(db, {}, { accountIds: undefined, today: TODAY }) as Out & {
      washed_by_purchases_in_this_scope?: Washed;
    };
    expect(all.washed_by_purchases_in_this_scope).toBeUndefined();
  });

  it("every row and every total reconciles: gain = proceeds - cost basis + adjustment", () => {
    // Two more synthetic wash sales (one in each direction) and a plain loss.
    sale(lot(1, "EEE", "2025-01-03", 3, 330), 1, "EEE", "2025-08-20", 3, 255, 330, false);
    lot(3, "EEE", "2025-08-01", 3, 260);
    sale(lot(1, "FFF", "2022-02-01", 7, 1400), 1, "FFF", "2025-09-02", 7, 1050.5, 1400, true);
    lot(1, "FFF", "2025-09-20", 7, 1060);
    sale(lot(1, "GGG", "2025-01-03", 2, 90), 1, "GGG", "2025-10-01", 2, 61.25, 90, false);
    for (const accountIds of [undefined, [1]]) {
      const out = queryRealizedGainsTool.run(
        db,
        { limit: 25 },
        { accountIds, accountName: accountIds ? "Vanguard Taxable" : undefined, today: TODAY },
      ) as Out;
      const rows = out.rows as { proceeds: number; cost_basis: number; gain_loss: number; adjustment_amount?: number; term: string }[];
      for (const r of rows) {
        expect(Math.abs(r.proceeds - r.cost_basis + (r.adjustment_amount ?? 0) - r.gain_loss)).toBeLessThan(0.005);
      }
      for (const [t, term] of [[out.short_term, "short"], [out.long_term, "long"]] as const) {
        expect(Math.abs(t.proceeds - t.cost_basis + (t.adjustments ?? NaN) - t.gain_loss)).toBeLessThan(0.005);
        const mine = rows.filter((r) => r.term === term);
        expect(Math.abs(mine.reduce((x, r) => x + (r.adjustment_amount ?? 0), 0) - (t.adjustments ?? NaN))).toBeLessThan(0.005);
      }
      // Hand-worked: short-term wash adjustments 300 (CCC) + 75 (EEE); long-term 349.5 (FFF).
      expect(out.short_term.adjustments).toBe(375);
      expect(out.long_term.adjustments).toBeCloseTo(349.5, 2);
      expect(out.wash_sales.count).toBe(3);
    }
  });

  it("the result is identical on a second call (replay)", () => {
    const ctx = { accountIds: [1], accountName: "Vanguard Taxable", today: TODAY };
    const a = JSON.stringify(queryRealizedGainsTool.run(db, {}, ctx));
    const b = JSON.stringify(queryRealizedGainsTool.run(db, {}, ctx));
    expect(a).toBe(b);
    expect(JSON.stringify(compactToolOutput("query_realized_gains", JSON.parse(a)))).toBe(
      JSON.stringify(compactToolOutput("query_realized_gains", JSON.parse(b))),
    );
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

  it("returns the engine's sale rows by default, largest absolute gain first, named (Q6)", () => {
    const out = queryRealizedGainsTool.run(db, {}, { accountIds: undefined, today: TODAY }) as Out;
    const rows = out.rows as { symbol: string; name: string; account: string; quantity: string; sold: string; term: string; gain_loss: number; wash_sale?: boolean }[];
    expect(rows.map((r) => [r.symbol, r.gain_loss])).toEqual([
      ["BBB", 300],
      ["AAA", 200],
      ["CCC", 0],
    ]);
    expect(rows[0]).toMatchObject({ name: "BBB Co", account: "Vanguard Taxable", quantity: "5 sh BBB", sold: "2025-04-01", term: "long" });
    expect(rows[2]).toMatchObject({ symbol: "CCC", wash_sale: true });
    expect(out.list_info).toEqual({ returned: 3, limit: 15, truncated: false });
    const none = queryRealizedGainsTool.run(db, { include_rows: false }, { accountIds: undefined, today: TODAY }) as Out;
    expect(none.rows).toBeUndefined();
  });

  it("120 sales, limit 25: the 25 largest by |gain|, and the full row set sums to the totals to the cent", () => {
    for (let i = 0; i < 120; i++) {
      const gain = i % 3 === 0 ? -(i + 1) * 1.37 : (i + 1) * 2.11;
      const cost = 100 + i;
      sale(lot(1, `R${i}`, "2025-01-02", 1, cost), 1, `R${i}`, "2025-08-01", 1, cost + gain, cost, false);
    }
    const out = queryRealizedGainsTool.run(db, { limit: 25 }, { accountIds: undefined, today: TODAY }) as Out;
    const engine = generateTaxReport(db, YEAR, { accountName: null });
    const all = [...engine.shortTermRows, ...engine.longTermRows];
    const expected = [...all].sort((a, b) => Math.abs(b.gainOrLoss) - Math.abs(a.gainOrLoss)).slice(0, 25);
    const rows = out.rows as { symbol: string; gain_loss: number }[];
    expect(rows.map((r) => r.symbol)).toEqual(expected.map((r) => r.symbol));
    expect(out.list_info).toMatchObject({ returned: 25, limit: 25, truncated: true });
    const st = all.filter((r) => !r.isLongTerm).reduce((t, r) => t + r.gainOrLoss, 0);
    const lt = all.filter((r) => r.isLongTerm).reduce((t, r) => t + r.gainOrLoss, 0);
    expect(Math.abs(st - out.short_term.gain_loss)).toBeLessThan(0.005);
    expect(Math.abs(lt - out.long_term.gain_loss)).toBeLessThan(0.005);
    expect(out.short_term.rows + out.long_term.rows).toBe(all.length);
    expect(all.length).toBe(123);
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
    // At the most rows allowed, the model-facing compact form stays under the target.
    expect(JSON.stringify(compactToolOutput("query_realized_gains", out)).length).toBeLessThan(COMPOSITE_MAX_JSON_CHARS);
    // At the default (15 rows), the full form does too.
    const dflt = queryRealizedGainsTool.run(db, {}, { accountIds: undefined, today: TODAY });
    expect(JSON.stringify(dflt).length).toBeLessThan(COMPOSITE_MAX_JSON_CHARS);
  });
});
