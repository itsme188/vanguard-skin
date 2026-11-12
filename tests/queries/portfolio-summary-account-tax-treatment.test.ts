/**
 * The Account Values section names each account's tax treatment (run 4,
 * 2026-11-12): with a second taxable account the chat called it
 * non-taxable, because the summary never said which accounts are taxable.
 * Each line reads "tax treatment: taxable" or "tax treatment:
 * tax-advantaged", from `isTaxableAccount`, in every scope, whether or not
 * the account has a value yet.
 *
 * Seeded accounts: 1 Vanguard Taxable, 2 Vanguard Roth IRA, 3 IBKR. Here 1
 * and 3 are taxable and 2 is a Roth. Synthetic figures.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { getPortfolioSummaryForChat } from "@/lib/queries/portfolio-summary";
import { createPendingTestDb, seedLot, seedSec } from "../setup/pending-statement-fixtures";
import { addDays, todayET } from "@/lib/calendar/date-utils";

let db: Database.Database;

function accountLines(summary: string): string[] {
  const body = summary.split("### Account Values")[1]?.split("\n###")[0] ?? "";
  return body.split("\n").filter((l) => l.startsWith("- ") && !l.startsWith("- **Total") && !l.startsWith("- This total"));
}

function lineFor(summary: string, name: string): string {
  return accountLines(summary).find((l) => l.startsWith(`- ${name}:`)) ?? "";
}

beforeEach(() => {
  db = createPendingTestDb();
  db.prepare("UPDATE accounts SET tax_treatment = 'taxable' WHERE id IN (1, 3)").run();
  db.prepare("UPDATE accounts SET tax_treatment = 'roth_ira' WHERE id = 2").run();
  // Account 1 has a value; 2 and 3 have none yet ("No data yet").
  db.prepare("INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source) VALUES (1, '2026-09-30', 1000, 'statement')").run();
});

describe("Account Values: tax treatment on each account line", () => {
  it("two taxable accounts and one tax-advantaged, whole book", () => {
    const names = (db.prepare("SELECT id, name FROM accounts ORDER BY id").all() as { id: number; name: string }[]).map((a) => a.name);
    const s = getPortfolioSummaryForChat(db);
    expect(lineFor(s, names[0])).toMatch(/tax treatment: taxable\)?$/);
    expect(lineFor(s, names[1])).toMatch(/tax treatment: tax-advantaged\)?$/);
    expect(lineFor(s, names[2])).toMatch(/tax treatment: taxable\)?$/);
    // The line with a value keeps its value, date and source.
    expect(lineFor(s, names[0])).toMatch(/\$1,000.*as of 2026-09-30/);
  });

  // Run 5: the wash-sale line named the repurchase but not that it sat in a
  // Roth, which is what makes the loss disallowed for good, not deferred.
  it("a wash-sale line says when the replacement is in a tax-advantaged account", () => {
    const today = todayET();
    const daysAgo = (n: number) => addDays(today, -n);
    const wash = (symbol: string, replacementAccount: number) => {
      const sec = seedSec(db, symbol);
      const lotId = Number(
        db
          .prepare(
            `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
             VALUES (1, ?, ?, 100, 10, 0, 1000)`,
          )
          .run(sec, daysAgo(200)).lastInsertRowid,
      );
      const txn = Number(
        db
          .prepare(
            `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, fees, source_key)
             VALUES (1, ?, ?, 'SELL', 10, 800, 0, ?)`,
          )
          .run(sec, daysAgo(20), `wash-${symbol}`).lastInsertRowid,
      );
      db.prepare(
        `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, sale_price, quantity_sold,
                                    proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days)
         VALUES (?, ?, ?, 80, 10, 800, 1000, -200, 0, 180)`,
      ).run(lotId, txn, daysAgo(20));
      seedLot(db, replacementAccount, sec, { date: daysAgo(10), qty: 10, price: 85 });
    };
    wash("WSR", 2); // replaced in the Roth
    wash("WST", 3); // replaced in a taxable account
    const roth = (db.prepare("SELECT name FROM accounts WHERE id = 2").get() as { name: string }).name;
    const lines = getPortfolioSummaryForChat(db).split("\n");
    const wsr = lines.find((l) => /^ {2}- WSR sold /.test(l)) ?? "";
    const wst = lines.find((l) => /^ {2}- WST sold /.test(l)) ?? "";
    expect(wsr).toContain(`; ${roth} is tax-advantaged, so the loss is disallowed for good`);
    expect(wst).not.toContain("tax-advantaged");
    expect(wst).toMatch(/^ {2}- WST sold /);
  });

  it("a single-account scope prints its own treatment", () => {
    const roth = (db.prepare("SELECT name FROM accounts WHERE id = 2").get() as { name: string }).name;
    const s = getPortfolioSummaryForChat(db, { accountIds: [2], label: roth });
    const lines = accountLines(s);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/tax treatment: tax-advantaged\)?$/);
  });
});
