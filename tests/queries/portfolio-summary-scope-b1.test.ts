/**
 * B1 + Contract I: the chat summary reads exactly the scope's account ids.
 *
 * Before this fix the summary looked an account up by exact name and, when
 * the name matched nothing (the IBKR chat passed the scope word), filtered
 * nothing: an IBKR chat was handed the whole book, Vanguard included.
 *
 * Accounts are the three migration seeds, renamed: 1 "IBKR Main", 2 "IBKR
 * Two", 3 "Vanguard Taxable". Synthetic tickers, small round figures.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getPortfolioSummaryForChat, type PortfolioSummaryScope } from "@/lib/queries/portfolio-summary";
import { todayET } from "@/lib/calendar/date-utils";
import { createPendingTestDb, seedSec, seedHold, seedPx, seedLot } from "../setup/pending-statement-fixtures";

let db: Database.Database;
let seq = 0;

function daysAgo(n: number): string {
  const d = new Date(`${todayET()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function seedTxn(accountId: number, securityId: number, date: string, type: string, qty: number, amount: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, fees, source_key)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
      )
      .run(accountId, securityId, date, type, qty, amount, `scope-b1-${seq++}`).lastInsertRowid
  );
}

function seedSnapshot(accountId: number, monthEnd: string, dividends: number): void {
  db.prepare(
    `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, dividends) VALUES (?, ?, 1000, ?)`
  ).run(accountId, monthEnd, dividends);
}

function section(summary: string, heading: string): string[] {
  const body = summary.split(heading)[1]?.split("\n###")[0] ?? "";
  return body.split("\n").filter((l) => l.startsWith("- "));
}

const SYMBOLS = ["AAA", "BBB", "VVV"];
const IBKR_SCOPE = { accountIds: [1, 2], label: "IBKR" };

beforeEach(() => {
  db = createPendingTestDb();
  db.prepare("UPDATE accounts SET name = 'IBKR Main', tax_treatment = 'taxable' WHERE id = 1").run();
  db.prepare("UPDATE accounts SET name = 'IBKR Two', tax_treatment = 'taxable' WHERE id = 2").run();
  db.prepare("UPDATE accounts SET name = 'Vanguard Taxable', tax_treatment = 'taxable' WHERE id = 3").run();

  const px = daysAgo(2);
  const lotDate = daysAgo(340); // inside the 60-day approaching-long-term window

  // AAA: 10 held at 10 = 100; lot bought 10 at 30 (basis 300) -> -200 unrealized.
  const aaa = seedSec(db, "AAA");
  seedHold(db, 1, aaa, px, "tws", 10);
  seedPx(db, aaa, px, 10);
  seedLot(db, 1, aaa, { date: lotDate, qty: 10, price: 30 });
  seedTxn(1, aaa, daysAgo(5), "BUY", 10, -300);
  seedSnapshot(1, daysAgo(40).slice(0, 8) + "28", 10);

  // BBB: 5 held at 20 = 100; lot bought 5 at 50 (basis 250) -> -150 unrealized.
  const bbb = seedSec(db, "BBB");
  seedHold(db, 2, bbb, px, "tws", 5);
  seedPx(db, bbb, px, 20);
  seedLot(db, 2, bbb, { date: lotDate, qty: 5, price: 50 });
  seedTxn(2, bbb, daysAgo(5), "BUY", 5, -250);
  seedSnapshot(2, daysAgo(40).slice(0, 8) + "28", 20);

  // VVV (outside the IBKR scope): 100 held at 50 = 5,000; basis 6,000.
  const vvv = seedSec(db, "VVV");
  seedHold(db, 3, vvv, px, "tws", 100);
  seedPx(db, vvv, px, 50);
  seedLot(db, 3, vvv, { date: lotDate, qty: 100, price: 60 });
  seedTxn(3, vvv, daysAgo(5), "BUY", 100, -6000);
  seedSnapshot(3, daysAgo(40).slice(0, 8) + "28", 400);
  db.prepare("UPDATE securities SET sector = 'Technology' WHERE symbol IN ('AAA', 'BBB')").run();
  db.prepare("UPDATE securities SET sector = 'Energy' WHERE symbol = 'VVV'").run();

  // VSH (outside the IBKR scope): a short of 7 shares at 40 in Vanguard Taxable.
  const vsh = seedSec(db, "VSH");
  seedHold(db, 3, vsh, px, "tws", -7);
  seedPx(db, vsh, px, 40);
});

describe("B1: the summary reads exactly the scope's accounts", () => {
  it("a two-account scope reads exactly those accounts", () => {
    const s = getPortfolioSummaryForChat(db, IBKR_SCOPE);
    expect(s).toContain("AAA");
    expect(s).toContain("BBB");
    expect(s).not.toContain("VVV");
    expect(s).not.toContain("Vanguard Taxable");

    // Holdings (both accounts) and allocation: 100 + 100 = $200, all of it Stock.
    expect(s).toContain("- AAA (IBKR Main): 10 shares");
    expect(s).toContain("- BBB (IBKR Two): 5 shares");
    // Each is half the scoped book: weights are over the scope, not the whole portfolio.
    expect(s).toMatch(/- AAA \(IBKR Main\):.*; weight 50\.0%/);
    const alloc = section(s, "### Asset Allocation");
    expect(alloc).toEqual(["- Stock: $200 (100.0% share, 2 positions)"]);

    // Open lots: 300 + 250 = $550 long basis (VVV's 6,000 left out).
    expect(s).toContain("- Open lots: 2 (long cost basis: $550)");

    // Harvest and long-term lists: both scoped lots, nothing from VVV.
    const harvest = section(s, "### Tax-Loss Harvesting Candidates");
    expect(harvest.map((l) => l.slice(2, 5)).sort()).toEqual(["AAA", "BBB"]);
    const lt = section(s, "### Lots Approaching Long-Term Status");
    expect(lt.map((l) => l.slice(2, 5)).sort()).toEqual(["AAA", "BBB"]);

    // Sector allocation: only the scope's Technology $200; VVV's Energy $5,000 left out.
    expect(section(s, "### Sector Allocation")).toEqual(["- Technology: $200 (100.0% share)"]);
    expect(s).not.toContain("Energy");
    // Short positions: VSH is held short outside the scope, so no short section at all.
    expect(s).not.toContain("VSH");
    expect(s).not.toContain("### Current Short Positions");

    // Income: 10 + 20 = $30 (the 400 in Vanguard Taxable left out).
    expect(s).toContain("- Dividends: $30");

    // Recent transactions: two rows, one per scoped account.
    const txns = section(s, "### Recent Transactions");
    expect(txns).toHaveLength(2);

    // The total line names the scope, not the Portfolio strip.
    expect(s).toContain("This total covers the IBKR accounts only");
  });

  it("an empty or unknown scope reads nothing", () => {
    const scopes: Array<PortfolioSummaryScope> = [{ accountIds: [], label: "IBKR" }, "No Such Account"];
    for (const scope of scopes) {
      const s = getPortfolioSummaryForChat(db, scope);
      expect(s).toContain("No account matches this chat's scope.");
      for (const sym of SYMBOLS) expect(s).not.toContain(sym);
      for (const name of ["IBKR Main", "IBKR Two", "Vanguard Taxable"]) expect(s).not.toContain(name);
    }
  });

  it("ids that match no account are the empty scope", () => {
    const s = getPortfolioSummaryForChat(db, { accountIds: [999], label: "IBKR" });
    expect(s).toContain("No account matches this chat's scope.");
    for (const sym of SYMBOLS) expect(s).not.toContain(sym);
  });

  it("the total sentence counts accounts that exist, not ids", () => {
    // 999 is no account: the scope is one account, so the sentence is singular.
    const s = getPortfolioSummaryForChat(db, { accountIds: [999, 3], label: "Vanguard" });
    expect(s).toContain("This total covers the Vanguard account only");
    expect(s).not.toContain("Vanguard accounts only");
  });

  it("the legacy string form reads the one account with that exact name", () => {
    const s = getPortfolioSummaryForChat(db, "IBKR Two");
    expect(s).toContain("BBB");
    expect(s).not.toContain("AAA");
    expect(s).not.toContain("VVV");
    expect(s).toContain("This total covers the IBKR Two account only");
  });

  it("freshness lines read the scope's own dates", () => {
    // Account 1's newest holdings row is older than account 3's.
    db.prepare("DELETE FROM holdings").run();
    db.prepare("DELETE FROM prices").run();
    const aaa = (db.prepare("SELECT id FROM securities WHERE symbol = 'AAA'").get() as { id: number }).id;
    const vvv = (db.prepare("SELECT id FROM securities WHERE symbol = 'VVV'").get() as { id: number }).id;
    seedHold(db, 1, aaa, "2026-10-30", "tws", 10);
    seedHold(db, 3, vvv, "2026-11-06", "tws", 100);
    seedPx(db, aaa, "2026-10-29", 10);
    seedPx(db, vvv, "2026-11-05", 50);
    db.prepare("DELETE FROM monthly_snapshots").run();
    seedSnapshot(1, "2026-09-30", 0);
    seedSnapshot(3, "2026-10-31", 0);

    const s = getPortfolioSummaryForChat(db, { accountIds: [1], label: "IBKR" });
    expect(s).toContain("- Latest holdings: 2026-10-30");
    expect(s).toContain("- Latest price date: 2026-10-29");
    expect(s).toContain("- Latest snapshot: 2026-09-30");

    // The whole book still reads the newest of every account.
    const all = getPortfolioSummaryForChat(db);
    expect(all).toContain("- Latest holdings: 2026-11-06");
    expect(all).toContain("- Latest price date: 2026-11-05");
    expect(all).toContain("- Latest snapshot: 2026-10-31");
  });

  it("a scoped summary shows no wash-sale replacement from another account", () => {
    // P8: a loss sale in IBKR Main; the replacement purchase sits in Vanguard Taxable.
    const wsx = seedSec(db, "WSX");
    const saleDate = daysAgo(20);
    const replacementDate = daysAgo(10);
    const lotId = Number(
      db
        .prepare(
          `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price,
                                 quantity_acquired, quantity_remaining, cost_basis)
           VALUES (1, ?, ?, 100, 10, 0, 1000)`
        )
        .run(wsx, daysAgo(200)).lastInsertRowid
    );
    const saleTxn = seedTxn(1, wsx, saleDate, "SELL", 10, 800);
    db.prepare(
      `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, sale_price, quantity_sold,
                                  proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days)
       VALUES (?, ?, ?, 80, 10, 800, 1000, -200, 0, 180)`
    ).run(lotId, saleTxn, saleDate);
    seedLot(db, 3, wsx, { date: replacementDate, qty: 10, price: 85 });

    const scoped = getPortfolioSummaryForChat(db, IBKR_SCOPE);
    expect(scoped).toContain(
      "1 possible wash sale; the replacement purchases may sit in other accounts; see the All Accounts scope"
    );
    expect(scoped).not.toContain(replacementDate);
    expect(scoped).not.toContain("Vanguard Taxable");

    // The All Accounts scope shows the detail, replacement date included.
    const all = getPortfolioSummaryForChat(db);
    expect(all).toContain(replacementDate);
  });
});
