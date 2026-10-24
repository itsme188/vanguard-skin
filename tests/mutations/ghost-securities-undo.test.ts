/**
 * Undoing an import removes the securities it left behind with nothing
 * pointing at them (2026-10-24 QA: a ghost security survived every undo and
 * stayed searchable forever). A security any other record still anchors
 * stays; derived rows (factors, betas, quotes) never anchor one.
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "@/lib/db/migrate";
import { deleteImportBatch } from "@/lib/mutations/import-batches";
import { findGhostSecurities } from "@/lib/mutations/ghost-securities";
import { undoImportWithRecovery, restoreImportBatch, readRecoveryManifest } from "@/lib/import/recovery";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
});

const batch = (name: string) =>
  Number(
    db
      .prepare(`INSERT INTO import_batches (filename, source_type, status) VALUES (?, 'canonical-transactions', 'completed')`)
      .run(name).lastInsertRowid,
  );
const security = (symbol: string) =>
  Number(db.prepare(`INSERT INTO securities (symbol, security_type) VALUES (?, 'Stock')`).run(symbol).lastInsertRowid);
const txn = (batchId: number, securityId: number, key: string) =>
  db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, trade_date, type, quantity, amount, source_key, import_batch_id)
       VALUES (1, ?, '2026-01-05', 'BUY', 10, -1000, ?, ?)`,
    )
    .run(securityId, key, batchId);
const has = (id: number) => db.prepare(`SELECT 1 FROM securities WHERE id = ?`).get(id) !== undefined;

describe("deleteImportBatch removes the securities the batch leaves unreferenced", () => {
  it("a security only this batch's rows pointed at is gone after the undo", () => {
    const b = batch("a.csv");
    const ghost = security("ZZZ");
    txn(b, ghost, "a:1");
    deleteImportBatch(db, b);
    expect(has(ghost)).toBe(false);
  });

  it("a security another batch still points at stays", () => {
    const b1 = batch("a.csv");
    const b2 = batch("b.csv");
    const shared = security("AAA");
    txn(b1, shared, "a:1");
    txn(b2, shared, "b:1");
    deleteImportBatch(db, b1);
    expect(has(shared)).toBe(true);
  });

  it("a watchlist or price row from another source anchors the security", () => {
    const b = batch("a.csv");
    const watched = security("BBB");
    const priced = security("CCC");
    txn(b, watched, "a:1");
    txn(b, priced, "a:2");
    db.prepare(`INSERT INTO watchlist (security_id) VALUES (?)`).run(watched);
    db.prepare(`INSERT INTO prices (security_id, date, close_price, source) VALUES (?, '2026-01-05', 10, 'tws')`).run(priced);
    deleteImportBatch(db, b);
    expect(has(watched)).toBe(true);
    expect(has(priced)).toBe(true);
  });

  it("derived classification rows do not anchor a ghost; they go with it", () => {
    const b = batch("a.csv");
    const ghost = security("DDD");
    txn(b, ghost, "a:1");
    db.prepare(`INSERT INTO security_factors (security_id, growth_vs_value) VALUES (?, 'Growth')`).run(ghost);
    db.prepare(`INSERT INTO security_betas (security_id, lookback_days, beta, computed_at) VALUES (?, 60, 1.1, '2026-01-05')`).run(ghost);
    deleteImportBatch(db, b);
    expect(has(ghost)).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM security_factors WHERE security_id = ?`).get(ghost)).toEqual({ n: 0 });
  });

  it("a security the batch never touched is left alone even when nothing references it", () => {
    const b = batch("a.csv");
    const untouched = security("EEE");
    const ghost = security("FFF");
    txn(b, ghost, "a:1");
    deleteImportBatch(db, b);
    expect(has(untouched)).toBe(true);
    expect(has(ghost)).toBe(false);
  });
});

describe("undo with recovery, then restore, brings a removed ghost back under its id", () => {
  it("the restored transaction points at the same security id", () => {
    const dir = mkdtempSync(join(tmpdir(), "ghost-restore-"));
    try {
      const b = batch("a.csv");
      const ghost = security("III");
      txn(b, ghost, "a:1");
      const { manifestPath } = undoImportWithRecovery(db, b, { manifestDir: dir });
      expect(has(ghost)).toBe(false);
      const result = restoreImportBatch(db, readRecoveryManifest(manifestPath));
      expect(result.restored.securities).toBe(1);
      expect(db.prepare(`SELECT symbol FROM securities WHERE id = ?`).get(ghost)).toEqual({ symbol: "III" });
      expect(db.prepare(`SELECT security_id FROM transactions WHERE source_key = 'a:1'`).get()).toEqual({
        security_id: ghost,
      });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findGhostSecurities (the repair script's reader)", () => {
  it("lists every unreferenced security when no candidate list is given, and never a referenced one", () => {
    const ghost = security("GGG");
    const anchored = security("HHH");
    db.prepare(`INSERT INTO holdings (account_id, security_id, as_of_date, quantity, source_key) VALUES (1, ?, '2026-01-05', 1, 'h')`).run(anchored);
    expect(findGhostSecurities(db).map((g) => g.id)).toEqual([ghost]);
  });
});
