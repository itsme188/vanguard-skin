/**
 * QA-1 and QA-2: the summary's tax sections follow `accounts.tax_treatment`.
 *
 * QA-1: a Roth lot is not a harvesting candidate (a loss there is never
 * deductible) and its long-term date changes nothing, so both lists show
 * taxable lots only, and a Roth-only chat says the sections do not apply.
 *
 * QA-2: realized gains are stated per tax year (current Eastern year and the
 * prior year) from the tax report engine, which drops retirement accounts,
 * never as one lifetime figure that adds the Roth in.
 *
 * Seeded accounts: 1 Vanguard Taxable, 2 Vanguard Roth IRA (stamped roth_ira
 * here), 3 IBKR. Synthetic tickers, small round figures.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { generateTaxReport } from "@/lib/compute/tax-report";
import { todayET } from "@/lib/calendar/date-utils";
import { createPendingTestDb, seedSec, seedPx, seedLot } from "../setup/pending-statement-fixtures";

const TAXABLE = 1;
const ROTH = 2;
const IBKR = 3;
const NOT_APPLICABLE = "Not applicable: this account is tax-advantaged.";

let db: Database.Database;
let seq = 0;

function daysAgo(n: number): string {
  const d = new Date(`${todayET()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function section(summary: string, heading: string): string[] {
  const body = summary.split(heading)[1]?.split("\n###")[0] ?? "";
  return body.split("\n").filter((l) => l.startsWith("- ") || l.startsWith("Not applicable"));
}

function seedSale(accountId: number, symbol: string, saleDate: string, gain: number, longTerm: boolean): void {
  const sec = seedSec(db, symbol);
  const lotId = Number(
    db
      .prepare(
        `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price,
                               quantity_acquired, quantity_remaining, cost_basis)
         VALUES (?, ?, '2020-01-02', 100, 10, 0, 1000)`
      )
      .run(accountId, sec).lastInsertRowid
  );
  const txn = Number(
    db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, fees, source_key)
         VALUES (?, ?, ?, 'SELL', 10, ?, 0, ?)`
      )
      .run(accountId, sec, saleDate, 1000 + gain, `qa1-sale-${seq++}`).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, sale_price, quantity_sold,
                                proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days)
     VALUES (?, ?, ?, ?, 10, ?, 1000, ?, ?, ?)`
  ).run(lotId, txn, saleDate, (1000 + gain) / 10, 1000 + gain, gain, longTerm ? 1 : 0, longTerm ? 800 : 100);
}

const year = Number(todayET().slice(0, 4));
const yearLine = (s: string, y: number) => s.split("\n").find((l) => l.startsWith(`- Realized gains ${y} `)) ?? "";

beforeEach(() => {
  db = createPendingTestDb();
  db.prepare("UPDATE accounts SET tax_treatment = 'roth_ira' WHERE id = ?").run(ROTH);
});

describe("QA-1: harvest and long-term lists", () => {
  beforeEach(() => {
    const px = daysAgo(1);
    const lotDate = daysAgo(346); // about 20 days before the long-term date
    // Each lot: 10 bought at 100 (basis 1,000), now 50 -> a 500 loss.
    for (const [accountId, symbol] of [
      [TAXABLE, "TXB"],
      [ROTH, "RTH"],
    ] as const) {
      const sec = seedSec(db, symbol);
      seedLot(db, accountId, sec, { date: lotDate, qty: 10, price: 100 });
      seedPx(db, sec, px, 50);
    }
  });

  it("harvest and long-term lists skip tax-advantaged accounts", () => {
    const s = getPortfolioSummaryForChat(db);
    const harvest = section(s, "### Tax-Loss Harvesting Candidates");
    expect(harvest).toHaveLength(1);
    expect(harvest[0]).toMatch(/^- TXB \(Vanguard Taxable\): -\$500 unrealized loss/);
    const lt = section(s, "### Lots Approaching Long-Term Status");
    expect(lt).toHaveLength(1);
    expect(lt[0]).toMatch(/^- TXB \(Vanguard Taxable\): \d+ days until long-term/);
    expect(s).not.toMatch(/- RTH /);
  });

  it("a Roth-only scope says both sections do not apply", () => {
    for (const scope of ["Vanguard Roth IRA", { accountIds: [ROTH], label: "Vanguard Roth IRA" }]) {
      const s = getPortfolioSummaryForChat(db, scope);
      expect(section(s, "### Tax-Loss Harvesting Candidates")).toEqual([NOT_APPLICABLE]);
      expect(section(s, "### Lots Approaching Long-Term Status")).toEqual([NOT_APPLICABLE]);
      expect(s).not.toMatch(/- RTH .*unrealized loss/);
    }
  });
});

describe("QA-2: realized gains by tax year", () => {
  beforeEach(() => {
    // This year: a Roth gain of 700 (not taxable) and an IBKR short-term loss of 100.
    seedSale(ROTH, "RRR", `${year}-01-01`, 700, false);
    seedSale(IBKR, "III", `${year}-01-01`, -100, false);
    // Last year: a taxable long-term gain of 300.
    seedSale(TAXABLE, "TTT", `${year - 1}-06-15`, 300, true);
  });

  it("realized gains are by tax year and exclude retirement accounts", () => {
    const s = getPortfolioSummaryForChat(db);
    expect(yearLine(s, year)).toBe(
      `- Realized gains ${year} (taxable accounts): short-term -$100, long-term $0 (not for filing)`
    );
    expect(yearLine(s, year - 1)).toBe(
      `- Realized gains ${year - 1} (taxable accounts): short-term $0, long-term $300 (not for filing)`
    );
    // No lifetime line any more.
    expect(s).not.toContain("- Realized gains:");
  });

  it("a Roth-only scope states that realized gains do not apply", () => {
    const s = getPortfolioSummaryForChat(db, { accountIds: [ROTH], label: "Vanguard Roth IRA" });
    expect(s).toContain(`- Realized gains: ${NOT_APPLICABLE}`);
    expect(yearLine(s, year)).toBe("");
  });

  it("a several-account scope sums the per-account reports; all accounts equal the whole-book report", () => {
    const parse = (line: string) => {
      const m = line.match(/short-term (-?)\$([\d,.]+), long-term (-?)\$([\d,.]+)/);
      if (!m) throw new Error(`unparsed: ${line}`);
      return {
        st: (m[1] ? -1 : 1) * Number(m[2].replace(/,/g, "")),
        lt: (m[3] ? -1 : 1) * Number(m[4].replace(/,/g, "")),
      };
    };
    const all = getPortfolioSummaryForChat(db);
    const both = getPortfolioSummaryForChat(db, { accountIds: [TAXABLE, IBKR], label: "Taxable" });
    for (const y of [year, year - 1]) {
      const report = generateTaxReport(db, y);
      const a = parse(yearLine(all, y));
      const b = parse(yearLine(both, y));
      expect(Math.abs(a.st - report.shortTermTotal.gainLoss)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(a.lt - report.longTermTotal.gainLoss)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(b.st - a.st)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(b.lt - a.lt)).toBeLessThanOrEqual(0.01);
    }
  });
});
