/**
 * scripts/repair-account-tax-treatment.ts — the user-run stamp that tells the
 * tax report which accounts are outside Form 8949 (QA finding
 * tax-lots--form-8949-export-and-taxable-totals-include-roth-ira-sales,
 * ruling 2026-09-14: "migration shown first, Roth stamped once").
 *
 * Every account name below is synthetic.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import {
  parseArgs,
  planAccountTaxTreatmentRepair,
  runAccountTaxTreatmentRepair,
  resolveAccount,
  listAccountTaxTreatments,
} from "@/scripts/repair-account-tax-treatment";

const RETIREMENT = "Beta Plan";
const TAXABLE = "Alpha Brokerage";

let db: Database.Database;

function treatmentOf(name: string): string {
  return (
    db.prepare("SELECT tax_treatment FROM accounts WHERE name = ?").get(name) as {
      tax_treatment: string;
    }
  ).tax_treatment;
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  // Migration 001 seeds accounts of its own; add two synthetic ones to work on.
  db.prepare("INSERT INTO accounts (name) VALUES (?)").run(TAXABLE);
  db.prepare("INSERT INTO accounts (name) VALUES (?)").run(RETIREMENT);
});

afterEach(() => {
  db.close();
});

describe("arg parsing", () => {
  it("requires --account and --treatment", () => {
    expect(() => parseArgs(["--treatment", "roth_ira"])).toThrow(/--account/);
    expect(() => parseArgs(["--account", TAXABLE])).toThrow(/--treatment/);
  });

  it("refuses an unknown treatment before touching the database", () => {
    expect(() => parseArgs(["--account", TAXABLE, "--treatment", "brokerage"])).toThrow(
      /unknown tax treatment/i
    );
  });

  it("defaults to a dry run and opts in with --apply", () => {
    expect(parseArgs(["--account", TAXABLE, "--treatment", "roth_ira"]).apply).toBe(false);
    expect(
      parseArgs(["--account", TAXABLE, "--treatment", "roth_ira", "--apply"]).apply
    ).toBe(true);
  });
});

describe("account resolution", () => {
  it("resolves by exact name and by id, and refuses anything else", () => {
    const byName = resolveAccount(db, RETIREMENT);
    expect(byName.name).toBe(RETIREMENT);
    expect(resolveAccount(db, String(byName.id)).name).toBe(RETIREMENT);
    expect(() => resolveAccount(db, "Beta")).toThrow(/no account matches/i);
  });

  it("lists every account with its current treatment", () => {
    const rows = listAccountTaxTreatments(db);
    expect(rows.map((r) => r.name)).toContain(RETIREMENT);
    expect(rows.every((r) => r.treatment === "taxable")).toBe(true);
  });
});

describe("dry run", () => {
  it("reports current -> proposed and writes nothing", () => {
    const { plan, applied } = runAccountTaxTreatmentRepair(db, {
      account: RETIREMENT,
      treatment: "roth_ira",
    });
    expect(plan.account.treatment).toBe("taxable");
    expect(plan.proposed).toBe("roth_ira");
    expect(plan.alreadySet).toBe(false);
    expect(applied).toBe(false);
    expect(treatmentOf(RETIREMENT)).toBe("taxable");
  });

  it("counts the closed sales that would leave the tax report", () => {
    const accountId = resolveAccount(db, RETIREMENT).id;
    const securityId = db
      .prepare("INSERT INTO securities (symbol, name) VALUES ('AAA', 'Alpha Test Co')")
      .run().lastInsertRowid as number;
    const lotId = db
      .prepare(
        `INSERT INTO tax_lots (account_id, security_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
         VALUES (?, ?, '2022-02-01', 100, 10, 0, 1000)`
      )
      .run(accountId, securityId).lastInsertRowid as number;
    const txnId = db
      .prepare(
        `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount)
         VALUES (?, ?, '2022-06-01', 'SELL', 10, 110, 1100)`
      )
      .run(accountId, securityId).lastInsertRowid as number;
    db.prepare(
      `INSERT INTO tax_lot_sales (tax_lot_id, sale_transaction_id, sale_date, quantity_sold, sale_price, proceeds, cost_basis_allocated, realized_gain_loss, is_long_term, holding_period_days)
       VALUES (?, ?, '2022-06-01', 10, 110, 1100, 1000, 100, 0, 120)`
    ).run(lotId, txnId);

    const plan = planAccountTaxTreatmentRepair(db, {
      account: RETIREMENT,
      treatment: "roth_ira",
    });
    expect(plan.closedSalesCount).toBe(1);
    // A different account's blast radius is its own.
    expect(
      planAccountTaxTreatmentRepair(db, { account: TAXABLE, treatment: "roth_ira" })
        .closedSalesCount
    ).toBe(0);
  });
});

describe("--apply", () => {
  it("writes the stamp and leaves every other account alone", () => {
    const { applied } = runAccountTaxTreatmentRepair(db, {
      account: RETIREMENT,
      treatment: "roth_ira",
      apply: true,
    });
    expect(applied).toBe(true);
    expect(treatmentOf(RETIREMENT)).toBe("roth_ira");
    expect(treatmentOf(TAXABLE)).toBe("taxable");
  });

  it("is idempotent — a second identical apply is a no-op", () => {
    runAccountTaxTreatmentRepair(db, {
      account: RETIREMENT,
      treatment: "roth_ira",
      apply: true,
    });
    const second = runAccountTaxTreatmentRepair(db, {
      account: RETIREMENT,
      treatment: "roth_ira",
      apply: true,
    });
    expect(second.plan.alreadySet).toBe(true);
    expect(second.applied).toBe(false);
    expect(treatmentOf(RETIREMENT)).toBe("roth_ira");
  });

  it("can stamp an account back to taxable", () => {
    runAccountTaxTreatmentRepair(db, {
      account: RETIREMENT,
      treatment: "traditional_ira",
      apply: true,
    });
    runAccountTaxTreatmentRepair(db, { account: RETIREMENT, treatment: "taxable", apply: true });
    expect(treatmentOf(RETIREMENT)).toBe("taxable");
  });

  it("refuses an unknown treatment even when called directly", () => {
    expect(() =>
      runAccountTaxTreatmentRepair(db, { account: RETIREMENT, treatment: "roth", apply: true })
    ).toThrow(/unknown tax treatment/i);
    expect(treatmentOf(RETIREMENT)).toBe("taxable");
  });
});

describe("REPAIR_DB_PATH-style file database", () => {
  it("stamps a database opened from a path, the way the CLI does", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repair-account-tax-treatment-"));
    const dbPath = path.join(tmpDir, "rehearsal.db");
    try {
      const fileDb = new Database(dbPath);
      fileDb.pragma("foreign_keys = ON");
      runMigrations(fileDb);
      fileDb.prepare("INSERT INTO accounts (name) VALUES (?)").run(RETIREMENT);
      runAccountTaxTreatmentRepair(fileDb, {
        account: RETIREMENT,
        treatment: "roth_ira",
        apply: true,
      });
      fileDb.close();

      const reopened = new Database(dbPath, { readonly: true });
      expect(
        (
          reopened.prepare("SELECT tax_treatment FROM accounts WHERE name = ?").get(RETIREMENT) as {
            tax_treatment: string;
          }
        ).tax_treatment
      ).toBe("roth_ira");
      reopened.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
