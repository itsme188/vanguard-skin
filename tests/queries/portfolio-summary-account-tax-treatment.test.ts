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
import { createPendingTestDb } from "../setup/pending-statement-fixtures";

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

  it("a single-account scope prints its own treatment", () => {
    const roth = (db.prepare("SELECT name FROM accounts WHERE id = 2").get() as { name: string }).name;
    const s = getPortfolioSummaryForChat(db, { accountIds: [2], label: roth });
    const lines = accountLines(s);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/tax treatment: tax-advantaged\)?$/);
  });
});
