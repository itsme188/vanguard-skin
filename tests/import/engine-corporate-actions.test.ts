import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { commitImport, undoImport } from "@/lib/import/engine";
import type { ParsedImportResult, ParsedCorporateAction } from "@/lib/import/types";

function base(overrides: Partial<ParsedImportResult> = {}): ParsedImportResult {
  return {
    sourceType: "ibkr-activity", sourceName: "test.csv",
    transactions: [], securities: [{ symbol: "AAAA", securityType: "Stock" }],
    holdings: [], prices: [], snapshots: [], corporateActions: [],
    errors: [], warnings: [], ...overrides,
  };
}
const SPLIT: ParsedCorporateAction = {
  accountName: "IBKR", symbol: "AAAA", actionType: "SPLIT",
  effectiveDate: "2026-07-01", ratioNumerator: 4, ratioDenominator: 1,
  quantityDelta: 300, sourceKey: "ibkr:ca:split:2026-07-01:AAAA:4:1",
};

describe("commitImport: corporate actions", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    runMigrations(db);
    // Migration 002 seeds an 'IBKR' account (INSERT OR IGNORE) — reuse it
    // rather than inserting a duplicate (accounts.name is UNIQUE). Mirrors
    // tests/compute/tax-lots-splits.test.ts's setup.
  });

  it("inserts an import-sourced row tagged with batch + account; recordCount includes it", () => {
    const res = commitImport(db, base({ corporateActions: [SPLIT] }));
    expect(res.newCorporateActions).toBe(1);
    expect(res.recordCount).toBeGreaterThanOrEqual(1);   // CA counts as a record
    const row = db.prepare(
      `SELECT source, applied, source_key, import_batch_id, account_id, quantity_delta FROM corporate_actions`,
    ).get() as Record<string, unknown>;
    expect(row.source).toBe("import");
    expect(row.applied).toBe(0);
    expect(row.source_key).toBe(SPLIT.sourceKey);
    expect(row.import_batch_id).toBe(res.batchId);
    expect(row.quantity_delta).toBe(300);
    expect(row.account_id).not.toBeNull();
  });

  it("re-import is an idempotent no-op", () => {
    commitImport(db, base({ corporateActions: [SPLIT] }));
    const res2 = commitImport(db, base({ corporateActions: [SPLIT] }));
    expect(res2.newCorporateActions).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM corporate_actions").get() as { c: number }).c).toBe(1);
  });

  it("unknown security symbol → resolve-only: skipped with warning, NO securities row created", () => {
    const res = commitImport(db, base({
      securities: [],                                     // nothing pre-registers ZZZZ
      corporateActions: [{ ...SPLIT, symbol: "ZZZZ", sourceKey: "ibkr:ca:split:2026-07-01:ZZZZ:4:1" }],
    }));
    expect(res.newCorporateActions).toBe(0);
    expect(res.warnings.join("\n")).toContain("ZZZZ");
    expect((db.prepare("SELECT COUNT(*) AS c FROM securities WHERE symbol='ZZZZ'").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM corporate_actions").get() as { c: number }).c).toBe(0);
  });

  it("same ratio + type as an existing manual row → silent skip", () => {
    db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
    const secId = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source)
       VALUES (?, 'SPLIT', '2026-07-01', 4, 1, 1, 'manual')`,
    ).run(secId);
    const res = commitImport(db, base({ corporateActions: [SPLIT] }));
    expect(res.newCorporateActions).toBe(0);
    expect(res.warnings).toHaveLength(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM corporate_actions").get() as { c: number }).c).toBe(1);
  });

  it("differing ratio (manual 2:1 vs statement 4:1) → skip + warning naming both", () => {
    db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
    const secId = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source)
       VALUES (?, 'SPLIT', '2026-07-01', 2, 1, 1, 'manual')`,
    ).run(secId);
    const res = commitImport(db, base({ corporateActions: [SPLIT] }));
    expect(res.newCorporateActions).toBe(0);
    expect(res.warnings.join("\n")).toMatch(/2:1/);
    expect(res.warnings.join("\n")).toMatch(/4:1/);
  });

  it("import-vs-import corrected ratio → skip + warning (INSERT OR IGNORE never swallows)", () => {
    commitImport(db, base({ corporateActions: [SPLIT] }));
    const corrected = { ...SPLIT, ratioNumerator: 2, sourceKey: "ibkr:ca:split:2026-07-01:AAAA:2:1" };
    const res = commitImport(db, base({ corporateActions: [corrected] }));
    expect(res.newCorporateActions).toBe(0);
    expect(res.warnings.join("\n")).toMatch(/4:1/);      // existing named
    expect(res.warnings.join("\n")).toMatch(/2:1/);      // incoming named
  });

  it("opposite type on the same security+date also warns (type-agnostic collision)", () => {
    db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
    const secId = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO corporate_actions (security_id, action_type, effective_date, ratio_numerator, ratio_denominator, applied, source)
       VALUES (?, 'REVERSE_SPLIT', '2026-07-01', 1, 10, 1, 'manual')`,
    ).run(secId);
    const res = commitImport(db, base({ corporateActions: [SPLIT] }));
    expect(res.newCorporateActions).toBe(0);
    expect(res.warnings.length).toBeGreaterThan(0);
  });

  it("duplicate-owner semantics: batch B re-imports the same CA, undoing batch A removes it (documented)", () => {
    const resA = commitImport(db, base({ corporateActions: [SPLIT] }));
    const resB = commitImport(db, base({ corporateActions: [SPLIT] }));
    expect(resB.newCorporateActions).toBe(0);            // B skipped it; A owns the row
    undoImport(db, resA.batchId);
    expect((db.prepare("SELECT COUNT(*) AS c FROM corporate_actions").get() as { c: number }).c).toBe(0);
  });

  it("undoImport removes the CA row and the recompute restores pre-split lots (recompute failures are logged, not raised — inherited undoImport semantics)", () => {
    db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
    const secId = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
    const acctId = (db.prepare("SELECT id FROM accounts WHERE name='IBKR'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, price_per_share, amount, fees, source_key)
       VALUES (?, ?, '2026-06-01', 'BUY', 100, 400, 40000, 0, 'seed-buy')`,
    ).run(acctId, secId);
    const res = commitImport(db, base({ corporateActions: [SPLIT] }));
    undoImport(db, res.batchId);
    expect((db.prepare("SELECT COUNT(*) AS c FROM corporate_actions").get() as { c: number }).c).toBe(0);
    const lot = db.prepare("SELECT quantity_remaining FROM tax_lots").get() as { quantity_remaining: number };
    expect(lot.quantity_remaining).toBeCloseTo(100);
  });

  it("CA-only import does NOT trigger the holdings-snapshot sweeps (purges / closed-equity reconcile)", () => {
    // Seed a live holding that the closed-equity reconciler would zero out if
    // it ran against this import's EMPTY holdings snapshot.
    db.prepare("INSERT INTO securities (symbol) VALUES ('AAAA')").run();
    const secId = (db.prepare("SELECT id FROM securities WHERE symbol='AAAA'").get() as { id: number }).id;
    const acctId = (db.prepare("SELECT id FROM accounts WHERE name='IBKR'").get() as { id: number }).id;
    db.prepare(
      `INSERT INTO holdings (account_id, security_id, quantity, as_of_date, source_key)
       VALUES (?, ?, 100, '2026-06-30', 'seed-h1')`,
    ).run(acctId, secId);
    commitImport(db, base({ corporateActions: [SPLIT] }));   // holdings: [] — no snapshot evidence
    const h = db.prepare("SELECT quantity FROM holdings WHERE security_id = ?").get(secId) as { quantity: number };
    expect(h.quantity).toBe(100);                            // untouched — no zero-row, no purge
  });

  it("an invalid CA row is excluded by validation before commit", () => {
    const res = commitImport(db, base({
      corporateActions: [{ ...SPLIT, effectiveDate: "2026-02-30", sourceKey: "ibkr:ca:split:2026-02-30:AAAA:4:1" }],
    }));
    expect(res.newCorporateActions).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM corporate_actions").get() as { c: number }).c).toBe(0);
  });
});
