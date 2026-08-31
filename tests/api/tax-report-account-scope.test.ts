/**
 * Route contract for the account-scoped tax report (QA finding
 * tax-lots--account-filter-ignored-by-tax-report-card-and-exports).
 *
 * The lib function owns the filtering; this file proves the ROUTE actually
 * parses ?account= and threads it into both the JSON envelope and the
 * download filenames — the exact seam that was missing (the card fetched
 * /api/tax-report?year=… with no account, so a Roth-filtered page served
 * Taxable totals under a full-report filename).
 *
 * Pattern mirrors tests/api/number-trust-contracts.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { NextRequest } from "next/server";
import { runMigrations } from "@/lib/db/migrate";
import { stampTaxLotsConvention, stampBrokerAcceptance } from "@/lib/compute/tax-convention";

const hoisted = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
}));

vi.mock("@/lib/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

import { GET as taxReportGET } from "@/app/api/tax-report/route";

const YEAR = 2022;
let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  hoisted.db = db;
});

/** Migration 002 already seeds the three real account names — reuse the row
 *  rather than inserting a duplicate (accounts.name is UNIQUE). */
function seedAccount(name: string): number {
  db.prepare("INSERT OR IGNORE INTO accounts (name) VALUES (?)").run(name);
  return (db.prepare("SELECT id FROM accounts WHERE name = ?").get(name) as { id: number }).id;
}

function seedSecurity(symbol: string): number {
  return db
    .prepare("INSERT INTO securities (symbol, name, security_type) VALUES (?, ?, 'Stock')")
    .run(symbol, symbol).lastInsertRowid as number;
}

/** One long-term GAIN sale (a gain sidesteps the wash-sale heuristic). */
function seedSale(accountId: number, securityId: number, quantity: number, salePrice: number) {
  const proceeds = quantity * salePrice;
  const costBasis = quantity * 100;
  const saleTxnId = db
    .prepare(
      "INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount) VALUES (?, ?, ?, 'SELL', ?, ?)"
    )
    .run(accountId, securityId, `${YEAR}-06-15`, quantity, proceeds).lastInsertRowid as number;
  const taxLotId = db
    .prepare(
      `INSERT INTO tax_lots
         (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
       VALUES (?, ?, ?, 100, ?, 0, ?)`
    )
    .run(accountId, securityId, `${YEAR - 2}-01-10`, quantity, costBasis).lastInsertRowid as number;
  db.prepare(
    `INSERT INTO tax_lot_sales
       (tax_lot_id, sale_transaction_id, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days, sale_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 400, ?)`
  ).run(
    taxLotId,
    saleTxnId,
    quantity,
    salePrice,
    proceeds,
    costBasis,
    proceeds - costBasis,
    `${YEAR}-06-15`
  );
}

function seedTwoAccounts() {
  const taxable = seedAccount("Vanguard Taxable");
  const roth = seedAccount("Vanguard Roth IRA");
  const sec = seedSecurity("AAPL");
  seedSale(taxable, sec, 10, 150);
  seedSale(roth, sec, 4, 175);
  return { taxable, roth };
}

describe("GET /api/tax-report?account=", () => {
  it("scopes the JSON envelope to the named account and echoes the scope", async () => {
    seedTwoAccounts();

    const res = await taxReportGET(
      new NextRequest(
        `http://localhost/api/tax-report?year=${YEAR}&account=${encodeURIComponent("Vanguard Roth IRA")}`
      ) as never
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.success).toBe(true);
    expect(body.data.accountName).toBe("Vanguard Roth IRA");
    const rows = [...body.data.shortTermRows, ...body.data.longTermRows];
    expect(rows.length).toBe(1);
    expect(rows[0].accountName).toBe("Vanguard Roth IRA");

    const unscoped = await taxReportGET(
      new NextRequest(`http://localhost/api/tax-report?year=${YEAR}`) as never
    );
    const unscopedBody = await unscoped.json();
    expect(unscopedBody.data.accountName).toBeNull();
    expect(
      [...unscopedBody.data.shortTermRows, ...unscopedBody.data.longTermRows].length
    ).toBe(2);
  });

  it.each(["csv", "txf"] as const)(
    "%s download carries the account slug in Content-Disposition and only that account's rows",
    async (format) => {
      seedTwoAccounts();

      const res = await taxReportGET(
        new NextRequest(
          `http://localhost/api/tax-report?year=${YEAR}&format=${format}&account=${encodeURIComponent("Vanguard Roth IRA")}`
        ) as never
      );
      expect(res.status).toBe(200);
      const disposition = res.headers.get("Content-Disposition");
      const expectedBase = format === "csv" ? `form-8949-${YEAR}` : `tax-report-${YEAR}`;
      expect(disposition).toContain(`${expectedBase}-vanguard-roth-ira-NOT-FOR-FILING.${format}`);

      const text = await res.text();
      // 4 sh at 175 is the Roth row; the Taxable row (10 sh at 150) must be absent.
      expect(text).toContain("700.00");
      expect(text).not.toContain("1500.00");
    }
  );

  it("keeps the NOT-FOR-FILING gate per (account, tax-year) for a scoped export", async () => {
    const { roth } = seedTwoAccounts();
    stampTaxLotsConvention(db);
    stampBrokerAcceptance(db, [{ accountId: roth, taxYear: YEAR }]);

    const scoped = await taxReportGET(
      new NextRequest(
        `http://localhost/api/tax-report?year=${YEAR}&format=csv&account=${encodeURIComponent("Vanguard Roth IRA")}`
      ) as never
    );
    expect(scoped.headers.get("Content-Disposition")).toContain(
      `form-8949-${YEAR}-vanguard-roth-ira.csv`
    );
    expect(scoped.headers.get("Content-Disposition")).not.toContain("NOT-FOR-FILING");

    // The taxable account was never accepted — its scoped export (which DOES
    // have rows, so this is a real gate check, not an empty-report artifact)
    // and the all-accounts export both stay marked.
    const taxableScoped = await taxReportGET(
      new NextRequest(
        `http://localhost/api/tax-report?year=${YEAR}&format=csv&account=${encodeURIComponent("Vanguard Taxable")}`
      ) as never
    );
    expect(taxableScoped.headers.get("Content-Disposition")).toContain(
      `form-8949-${YEAR}-vanguard-taxable-NOT-FOR-FILING.csv`
    );
    expect(await taxableScoped.text()).toContain("1500.00");

    const all = await taxReportGET(
      new NextRequest(`http://localhost/api/tax-report?year=${YEAR}&format=csv`) as never
    );
    expect(all.headers.get("Content-Disposition")).toContain("NOT-FOR-FILING");
  });

  it("is unchanged with no ?account= (all accounts, unscoped filename)", async () => {
    seedTwoAccounts();

    const res = await taxReportGET(
      new NextRequest(`http://localhost/api/tax-report?year=${YEAR}&format=csv`) as never
    );
    expect(res.headers.get("Content-Disposition")).toContain(
      `form-8949-${YEAR}-NOT-FOR-FILING.csv`
    );
    const text = await res.text();
    expect(text).toContain("1500.00");
    expect(text).toContain("700.00");
    expect(text).not.toContain("PARTIAL EXPORT");
  });
});
