import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import {
  getTransactionsBySecurity,
  getRelatedOptionTransactions,
  countTransactionsBySecurity,
  countRelatedOptionTransactions,
  getSecurityDetail,
  getSecurityTransactionTotals,
  listsRelatedOptionTransactions,
  type SecurityDetailTransaction,
} from "@/lib/queries/security-detail";
import { countTransactionScopes } from "@/app/dashboard/components/TransactionsSection";
import { anchorIndex, sliceBetween } from "../helpers/source-anchor";

// Far above any seeded row count: "the list with no cap".
const NO_CAP = 100000;

let seq = 0;
function seedAccount(db: Database.Database, name: string): number {
  const found = db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number } | undefined;
  if (found) return found.id;
  return db.prepare("INSERT INTO accounts (name) VALUES (?)").run(name).lastInsertRowid as number;
}
function seedSecurity(db: Database.Database, symbol: string, type: string | null, underlying: string | null = null): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type, underlying_symbol) VALUES (?, ?, ?, ?)")
    .run(symbol, `${symbol} Corp`, type, underlying).lastInsertRowid as number;
}
function seedTxn(db: Database.Database, securityId: number, type = "BUY", accountId = 1): void {
  seq += 1;
  db.prepare(
    `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, price_per_share, source_key)
     VALUES (?, ?, '2026-06-29', ?, 10, 100, 10, ?)`
  ).run(accountId, securityId, type, `test:count:${seq}`);
}
function seedMany(db: Database.Database, n: number, securityId: number, type: string, accountId: number): void {
  for (let i = 0; i < n; i++) seedTxn(db, securityId, type, accountId);
}

describe("security-detail transaction count readers", () => {
  let db: Database.Database;
  let aaa: number;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    const acct = seedAccount(db, "Acct One");
    aaa = seedSecurity(db, "AAA", "Stock");
    const zzz = seedSecurity(db, "ZZZ", "Stock");
    const o1 = seedSecurity(db, "AAA  261218C00100000", "Option", "AAA");
    const o2 = seedSecurity(db, "AAA  261218P00100000", "Option", "AAA");
    const o3 = seedSecurity(db, "AAA  270115C00100000", "Option", null); // prefix rule only
    const oz = seedSecurity(db, "ZZZ  261218C00100000", "Option", "ZZZ");
    seedMany(db, 7, aaa, "BUY", acct);
    seedMany(db, 2, zzz, "BUY", acct);
    seedTxn(db, o1, "BUY", acct);
    seedTxn(db, o1, "BUY", acct);
    seedTxn(db, o2, "BUY", acct);
    seedTxn(db, o3, "BUY", acct);
    seedTxn(db, oz, "BUY", acct);
  });

  it("counts the stock and related-option rows with the list predicates", () => {
    expect(countTransactionsBySecurity(db, aaa)).toBe(7);
    expect(countRelatedOptionTransactions(db, "AAA")).toBe(4);
  });

  it("keeps the list capped while the count stays true", () => {
    expect(getTransactionsBySecurity(db, aaa, 5)).toHaveLength(5);
    expect(getRelatedOptionTransactions(db, "AAA", 2)).toHaveLength(2);
    expect(countTransactionsBySecurity(db, aaa)).toBe(7);
    expect(countRelatedOptionTransactions(db, "AAA")).toBe(4);
  });
});

describe("per-account transaction totals for the card", () => {
  let db: Database.Database;
  let bbb: number;
  let one: number;
  let two: number;

  /** Every row the card could hold, with no cap: both lists, as the page loads them. */
  function uncapped(securityId: number, symbol: string, withRelated: boolean): SecurityDetailTransaction[] {
    return [
      ...getTransactionsBySecurity(db, securityId, NO_CAP),
      ...(withRelated ? getRelatedOptionTransactions(db, symbol, NO_CAP) : []),
    ];
  }

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    one = seedAccount(db, "Acct One");
    two = seedAccount(db, "Acct Two");
    // Mixed-case types on purpose: the type compare must ignore case.
    bbb = seedSecurity(db, "BBB", "stock");
    const call = seedSecurity(db, "BBB  270115C00050000", "OPTION", "BBB");
    const put = seedSecurity(db, "BBB  270115P00050000", "Option", null); // prefix rule only
    // Acct One sits OVER the default cap of 100 on both lists; Acct Two under.
    seedMany(db, 120, bbb, "BUY", one);
    seedMany(db, 65, call, "SELL_TO_OPEN", one);
    seedMany(db, 40, put, "BUY_TO_OPEN", one);
    seedMany(db, 30, bbb, "SELL", two);
    seedMany(db, 12, call, "BUY_TO_CLOSE", two);
    // One row in the STOCK list that the per-row rule calls an option row: a
    // stock-typed security with an option open booked against it.
    seedTxn(db, bbb, "SELL_TO_OPEN", two);
  });

  it("each account's totals equal its uncapped list lengths, over and under the cap", () => {
    const totals = getSecurityTransactionTotals(db, { id: bbb, symbol: "BBB", security_type: "stock" });
    const rows = uncapped(bbb, "BBB", true);

    for (const name of ["Acct One", "Acct Two"]) {
      const want = countTransactionScopes(rows, name);
      expect(totals.byAccount[name]).toEqual({ stocks: want.stocks, options: want.options });
    }
    expect(Object.keys(totals.byAccount).sort()).toEqual(["Acct One", "Acct Two"]);
    expect(totals.byAccount["Acct One"]).toEqual({ stocks: 120, options: 105 });
    expect(totals.byAccount["Acct Two"]).toEqual({ stocks: 30, options: 13 });

    const wantAll = countTransactionScopes(rows, "All");
    expect(totals.all).toEqual({ stocks: wantAll.stocks, options: wantAll.options });
    expect(totals.all.stocks + totals.all.options).toBe(rows.length);

    // The default (capped) lists really are short of these totals.
    expect(getTransactionsBySecurity(db, bbb)).toHaveLength(100);
    expect(getRelatedOptionTransactions(db, "BBB")).toHaveLength(100);
  });

  it("splits by the card's per-row rule, not by which list a row came from", () => {
    const totals = getSecurityTransactionTotals(db, { id: bbb, symbol: "BBB", security_type: "stock" });
    // By list, the stock list holds 151 rows and the option list 117. The
    // option open booked on the stock is an option row to the chips, so the
    // split is 150 / 118.
    expect(countTransactionsBySecurity(db, bbb)).toBe(151);
    expect(countRelatedOptionTransactions(db, "BBB")).toBe(117);
    expect(totals.all).toEqual({ stocks: 150, options: 118 });
  });

  it("an option page counts its own rows as option rows and lists no siblings", () => {
    const callId = (db.prepare("SELECT id FROM securities WHERE symbol = ?").get("BBB  270115C00050000") as { id: number }).id;
    const security = { id: callId, symbol: "BBB  270115C00050000", security_type: "OPTION" };
    expect(listsRelatedOptionTransactions(security)).toBe(false);
    const totals = getSecurityTransactionTotals(db, security);
    const rows = uncapped(callId, security.symbol, false);
    expect(totals.all).toEqual({ stocks: 0, options: 77 });
    expect(totals.byAccount["Acct One"]).toEqual({ stocks: 0, options: 65 });
    expect(countTransactionScopes(rows, "All")).toEqual({ all: 77, stocks: 0, options: 77 });
  });

  it("a security with no transactions has empty totals", () => {
    const empty = seedSecurity(db, "EEE", "Stock");
    expect(getSecurityTransactionTotals(db, { id: empty, symbol: "EEE", security_type: "Stock" })).toEqual({
      all: { stocks: 0, options: 0 },
      byAccount: {},
    });
  });

  it("the page aggregator returns the same totals", () => {
    const detail = getSecurityDetail(db, bbb)!;
    expect(detail.transactionTotals).toEqual(
      getSecurityTransactionTotals(db, { id: bbb, symbol: "BBB", security_type: "stock" }),
    );
    expect(detail.recentTransactions).toHaveLength(100);
  });

  it("the related-options decision has one answer per kind of page", () => {
    expect(listsRelatedOptionTransactions({ symbol: "BBB", security_type: "Stock" })).toBe(true);
    expect(listsRelatedOptionTransactions({ symbol: "BBB", security_type: null })).toBe(true);
    expect(listsRelatedOptionTransactions({ symbol: "BBB  270115C00050000", security_type: "option" })).toBe(false);
    expect(listsRelatedOptionTransactions({ symbol: "", security_type: "Stock" })).toBe(false);
  });
});

describe("TransactionsSection reads the true totals", () => {
  const src = readFileSync("app/dashboard/components/TransactionsSection.tsx", "utf8");
  // The component body, from its signature to the first helper after it.
  const body = sliceBetween(src, "export function TransactionsSection(", "\nfunction FilterPill(");

  it("takes the totals as one prop and picks the selected account's own", () => {
    anchorIndex(body, "totals: SecurityTransactionTotals;");
    const pick = sliceBetween(body, "const scopeTotals: TransactionScopeTotals =", "const totalInView =");
    expect(pick).toContain("totals.all");
    expect(pick).toContain("totals.byAccount[account]");
  });

  it("the header prints the view's true total through <Count>, never a loaded-row count", () => {
    const total = sliceBetween(body, "const totalInView =", "const viewTruncated =");
    expect(total).toContain("scopeTotals.stocks");
    expect(total).toContain("scopeTotals.options");
    expect(total).not.toMatch(/\.length/);

    const header = sliceBetween(body, 'title="Recent Transactions"', "\n    >");
    expect(header).toContain("<Count value={filtered.length} /> of <Count value={totalInView} />");
    // No bare number in the header: every braced figure sits inside <Count>.
    expect(header.replace(/<Count value=\{[^}]*\} \/>/g, "")).not.toMatch(/\.length|Total|totals/);
    expect(header).not.toContain("all.length");
  });

  it("the chips print the per-account totals through <Count>", () => {
    anchorIndex(body, "label={<>Stocks (<Count value={scopeTotals.stocks} />)</>}");
    anchorIndex(body, "label={<>Options (<Count value={scopeTotals.options} />)</>}");
    expect(body).not.toContain("countTransactionScopes(");
  });

  it("the newest-loaded note follows the view on screen and is fixed under Hide amounts", () => {
    const note = sliceBetween(body, "const viewTruncated =", "// Hide filters entirely");
    expect(note).toContain("filtered.length < totalInView");
    // Masked: one sentence whatever the size. Unmasked: only when truncated.
    const privateAt = anchorIndex(note, "isPrivate");
    const truncatedAt = anchorIndex(note, ": viewTruncated", privateAt);
    expect(truncatedAt).toBeGreaterThan(privateAt);
    expect(body).not.toContain("all.length <");
  });
});

describe("the security page takes the totals from the query layer", () => {
  const page = readFileSync("app/dashboard/security/[id]/page.tsx", "utf8");
  it("passes the aggregator's totals and repeats no option-page condition for them", () => {
    const start = anchorIndex(page, "<TransactionsSection");
    const tag = page.slice(start, anchorIndex(page, "/>", start));
    expect(tag).toContain("totals={transactionTotals}");
    expect(tag).not.toContain("security_type");
    expect(page).not.toContain("countRelatedOptionTransactions");
    anchorIndex(page, 'export const dynamic = "force-dynamic";');
  });
});
