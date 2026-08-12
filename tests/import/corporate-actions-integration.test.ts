import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { parseImport, commitImport, undoImport } from "@/lib/import/engine";
import { computeTaxLots } from "@/lib/compute/tax-lots";
import { computeDailyValuations } from "@/lib/compute/daily-valuation";

const csv = readFileSync(join(__dirname, "../fixtures/ibkr-corporate-actions.csv"), "utf-8");

describe("corporate actions end-to-end (disposable DB)", () => {
  let db: Database.Database;
  let acct: number;
  let sec: number;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    // Migration 002 seeds an 'IBKR' account via INSERT OR IGNORE — reuse it
    // rather than re-inserting (accounts.name is UNIQUE). Mirrors
    // tests/import/engine-corporate-actions.test.ts's precedent.
    acct = (db.prepare("SELECT id FROM accounts WHERE name='IBKR'").get() as { id: number }).id;
    db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
    db.prepare("INSERT INTO securities (symbol) VALUES ('BBBB')").run();
    db.prepare("INSERT INTO securities (symbol) VALUES ('402340')").run();  // suffix-normalized target
    db.prepare("INSERT INTO securities (symbol) VALUES ('GGGG')").run();    // null-delta row's security
    sec = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, '2026-06-01', 'BUY', 100, 400, 40000, 0, 'seed-buy')`,
    ).run(acct, sec);
    // Holdings + prices on BOTH sides of the split (AAAA's statement-parsed
    // effective date is 2026-07-01 — the Date/Time field, not the 2026-07-02
    // Report Date column; see tests/import/ibkr-corporate-actions-parser.test.ts).
    // Corporate actions never touch holdings rows — each statement snapshot is
    // already in its own date's basis — so valuation continuity requires a
    // post-split holdings row (400 shares) exactly as a real post-split
    // statement would carry.
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 100, '2026-06-30', 'seed-h1')`,
    ).run(acct, sec);
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 400, '2026-07-02', 'seed-h2')`,
    ).run(acct, sec);
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-06-30', 400, 'test')").run(sec);
    db.prepare("INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-07-02', 100, 'test')").run(sec);
  });

  it("import → recompute → invariants → valuation continuity → undo → restore → re-import idempotent", async () => {
    const parsed = await parseImport(csv, "ibkr-corporate-actions.csv");
    const commit1 = commitImport(db, parsed);
    expect(commit1.newCorporateActions).toBe(4);   // AAAA split, BBBB reverse, 402340 (suffix-normalized), GGGG (null delta)

    computeTaxLots(db);
    const lot = db.prepare("SELECT quantity_remaining, acquisition_price, cost_basis FROM tax_lots WHERE security_id = ?").get(sec) as Record<string, number>;
    expect(lot.quantity_remaining).toBeCloseTo(400);
    expect(lot.acquisition_price).toBeCloseTo(100);
    expect(lot.cost_basis).toBeCloseTo(40000);      // total basis invariant

    // Valuation continuity across the split — UNCONDITIONAL: both rows must exist
    computeDailyValuations(db);
    const vals = db.prepare(
      `SELECT total_value FROM daily_valuations
       WHERE valuation_date IN ('2026-06-30','2026-07-02') ORDER BY valuation_date`,
    ).all() as Array<{ total_value: number }>;
    expect(vals).toHaveLength(2);
    expect(Math.abs(vals[1].total_value - vals[0].total_value)).toBeLessThan(vals[0].total_value * 0.01);

    // Undo restores pre-split lots
    undoImport(db, commit1.batchId);
    expect((db.prepare("SELECT COUNT(*) AS c FROM corporate_actions").get() as { c: number }).c).toBe(0);
    const lotAfterUndo = db.prepare("SELECT quantity_remaining, acquisition_price FROM tax_lots WHERE security_id = ?").get(sec) as Record<string, number>;
    expect(lotAfterUndo.quantity_remaining).toBeCloseTo(100);
    expect(lotAfterUndo.acquisition_price).toBeCloseTo(400);

    // Re-import after undo: rows land again; second re-import is a no-op
    const commit2 = commitImport(db, await parseImport(csv, "ibkr-corporate-actions.csv"));
    expect(commit2.newCorporateActions).toBe(4);
    const commit3 = commitImport(db, await parseImport(csv, "ibkr-corporate-actions.csv"));
    expect(commit3.newCorporateActions).toBe(0);
  });
});
