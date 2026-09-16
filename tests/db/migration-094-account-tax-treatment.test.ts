/**
 * Migration 094 — accounts.tax_treatment.
 *
 * Additive and data-free by ruling (2026-09-14): the column arrives with a
 * 'taxable' default so nothing changes until the user runs the stamp script.
 * The CHECK constraint pins the same vocabulary the code single-sources in
 * lib/compute/tax-treatment.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { TAX_TREATMENTS, DEFAULT_TAX_TREATMENT } from "@/lib/compute/tax-treatment";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe("migration 094", () => {
  it("is recorded as applied", () => {
    const row = db
      .prepare("SELECT filename FROM schema_migrations WHERE filename LIKE '094%'")
      .get() as { filename: string } | undefined;
    expect(row?.filename).toBe("094_accounts_tax_treatment.sql");
  });

  it("adds a NOT NULL tax_treatment column defaulting to taxable", () => {
    const col = (
      db.prepare("PRAGMA table_info(accounts)").all() as {
        name: string;
        notnull: number;
        dflt_value: string | null;
      }[]
    ).find((c) => c.name === "tax_treatment");
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(1);
    expect(col!.dflt_value).toBe(`'${DEFAULT_TAX_TREATMENT}'`);
  });

  it("leaves every pre-existing account taxable — the stamp is a separate user-run step", () => {
    const rows = db.prepare("SELECT tax_treatment FROM accounts").all() as {
      tax_treatment: string;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tax_treatment === DEFAULT_TAX_TREATMENT)).toBe(true);
  });

  it("accepts every treatment in the shared vocabulary", () => {
    const id = db.prepare("INSERT INTO accounts (name) VALUES ('Synthetic Account')").run()
      .lastInsertRowid as number;
    for (const t of TAX_TREATMENTS) {
      expect(() =>
        db.prepare("UPDATE accounts SET tax_treatment = ? WHERE id = ?").run(t, id)
      ).not.toThrow();
    }
  });

  it("refuses a value outside the vocabulary (CHECK constraint)", () => {
    const id = db.prepare("INSERT INTO accounts (name) VALUES ('Another Synthetic')").run()
      .lastInsertRowid as number;
    expect(() =>
      db.prepare("UPDATE accounts SET tax_treatment = ? WHERE id = ?").run("brokerage", id)
    ).toThrow(/CHECK constraint failed/i);
    expect(() =>
      db.prepare("INSERT INTO accounts (name, tax_treatment) VALUES ('Third', 'ira')").run()
    ).toThrow(/CHECK constraint failed/i);
  });

  it("does not disturb the foreign keys or the integrity of the database", () => {
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect((db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check).toBe("ok");
  });
});
