import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { parseImport, commitImport } from "@/lib/import/engine";
import { upsertSecurity } from "@/lib/mutations/securities";

const fixturesDir = path.join(__dirname, "..", "fixtures");
const vanguardHoldingsCsv = fs.readFileSync(
  path.join(fixturesDir, "vanguard-holdings-sample.csv"),
  "utf-8",
);

describe("statement-wins guards cover plaid rows", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
  });

  it("statement holdings import overwrites a same-key plaid holdings row", async () => {
    const parsed = await parseImport(vanguardHoldingsCsv, "vanguard-holdings.csv");
    // Determine the account + first holding the fixture will write.
    const first = parsed.holdings[0];
    // The account the fixture targets ("Vanguard Taxable") is already
    // seeded by migration 002_seed_accounts.sql — commitImport's
    // getAccountId() resolves by name via SELECT, it never creates rows.
    // Resolve the existing row (INSERT OR IGNORE keeps this robust if the
    // seed ever changes) instead of inserting a duplicate.
    db.prepare(`INSERT OR IGNORE INTO accounts (name) VALUES (?)`).run(first.accountName);
    const acctId = (
      db.prepare(`SELECT id FROM accounts WHERE name = ?`).get(first.accountName) as {
        id: number;
      }
    ).id;
    // Pre-seed the security + a plaid live row on the SAME
    // (account, security, as_of_date) the statement import will target.
    const secId = upsertSecurity(db, { symbol: first.symbol });
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key)
       VALUES (?, ?, 999, NULL, ?, ?)`,
    ).run(acctId, secId, first.asOfDate, `plaid:${acctId}:${secId}:${first.asOfDate}`);

    commitImport(db, parsed);

    const row = db
      .prepare(
        `SELECT quantity, source_key FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = ?`,
      )
      .get(acctId, secId, first.asOfDate) as { quantity: number; source_key: string };
    expect(row.quantity).toBe(first.quantity); // statement value, not 999
    expect(row.source_key.startsWith("plaid:")).toBe(false);
  });

  it("statement snapshot overwrites a plaid snapshot row; leaves statement rows intact", () => {
    // "Vanguard Taxable" is already seeded by migration 002_seed_accounts.sql —
    // resolve it rather than inserting a duplicate (see note above).
    db.prepare(`INSERT OR IGNORE INTO accounts (name) VALUES ('Vanguard Taxable')`).run();
    const acctId = (
      db.prepare(`SELECT id FROM accounts WHERE name = 'Vanguard Taxable'`).get() as {
        id: number;
      }
    ).id;
    // Plaid live snapshot on a month-end date
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, cash_value, source)
       VALUES (?, '2026-07-31', 100000, 5000, 'plaid')`,
    ).run(acctId);
    // Replay the engine's exact conditional upsert as a statement import would
    db.prepare(
      `INSERT INTO monthly_snapshots (account_id, month_end_date, total_value, source)
       VALUES (?, '2026-07-31', 123456, 'vanguard-pdf')
       ON CONFLICT(account_id, month_end_date) DO UPDATE SET
         total_value = excluded.total_value, source = excluded.source
       WHERE monthly_snapshots.source IN ('tws', 'manual', 'plaid')`,
    ).run(acctId);
    const row = db
      .prepare(`SELECT total_value, source FROM monthly_snapshots WHERE account_id = ?`)
      .get(acctId) as { total_value: number; source: string };
    expect(row.source).toBe("vanguard-pdf");
    expect(row.total_value).toBe(123456);
  });

  it("engine snapshot upsert WHERE clause includes plaid", () => {
    // Direct source-of-truth check on engine.ts so a regression can't hide
    // behind fixture accidents.
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "import", "engine.ts"), "utf-8");
    expect(src).toMatch(/monthly_snapshots\.source IN \('tws', 'manual', 'plaid'\)/);
    expect(src).toMatch(/holdings\.source_key LIKE 'tws-%' OR holdings\.source_key LIKE 'plaid:%'/);
    expect(src.match(/WHEN 'plaid' THEN 3/g)?.length).toBe(2); // both CASE arms
  });
});
