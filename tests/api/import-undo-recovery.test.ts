/**
 * Task 20 (#35, Phase B, §G): import-undo confirmation gate + batch-bound
 * recovery manifest + restore.
 *
 * The undo DELETE (app/api/import/route.ts -> undoImport) is destructive: it
 * deletes the batch's source rows AND clears the derived tax-lot/valuation
 * layer before recompute, with no recovery. This suite pins the additive
 * defense-in-depth: a deliberate two-step confirmation, a pre-delete manifest
 * written atomically to a gitignored dir, and a restore that reproduces the
 * pre-undo state while preserving statement authority.
 *
 * The pipeline itself (Detect->Parse->Preview->Confirm->Commit) is on the
 * project's do-NOT-change list — these tests only exercise the new wrappers
 * and confirm the protected commit/undo behavior is unchanged.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";

// The route module imports the `@/lib/db` singleton at load time (which would
// open the real on-disk DB). handleUndoRequest takes an explicit db param, so
// the singleton is never used here — stub it to keep the test hermetic.
vi.mock("@/lib/db", () => ({ db: {} }));
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { commitImport } from "@/lib/import/engine";
import type { ParsedImportResult } from "@/lib/import/types";
import {
  buildRecoveryManifest,
  verifyManifest,
  writeRecoveryManifest,
  readRecoveryManifest,
  restoreImportBatch,
  undoImportWithRecovery,
  RECOVERY_SOURCE_TABLES,
} from "@/lib/import/recovery";
import {
  issueUndoToken,
  consumeUndoToken,
  checkUndoRateLimit,
  recordUndo,
  resetUndoConfirmation,
  MAX_UNDOS_PER_WINDOW,
  UNDO_TOKEN_TTL_MS,
} from "@/lib/import/undo-confirmation";
import { handleUndoRequest } from "@/app/api/import/route";

function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

/**
 * A self-contained parsed IBKR-activity result: two securities, one BUY, two
 * statement-sourced holdings, one price, one monthly snapshot. Enough to
 * populate every batch-owned source table the manifest must capture.
 */
function sampleParsed(): ParsedImportResult {
  return {
    sourceType: "ibkr-activity",
    sourceName: "IBKR 2025-01 activity.csv",
    securities: [
      { symbol: "AAA", name: "Alpha Inc", securityType: "Stock", assetClass: "equity" },
      { symbol: "BBB", name: "Beta Inc", securityType: "Stock", assetClass: "equity" },
    ],
    transactions: [
      {
        accountName: "IBKR",
        symbol: "AAA",
        type: "BUY",
        tradeDate: "2025-01-15",
        settlementDate: "2025-01-17",
        quantity: 10,
        amount: -1000,
        pricePerShare: 100,
        fees: 1,
        sourceKey: "ibkr:txn:AAA:2025-01-15:buy",
      },
    ],
    holdings: [
      {
        accountName: "IBKR",
        symbol: "AAA",
        quantity: 10,
        costBasis: 1000,
        asOfDate: "2025-01-31",
        sourceKey: "ibkr:pos:AAA:2025-01-31",
      },
      {
        accountName: "IBKR",
        symbol: "BBB",
        quantity: 5,
        costBasis: 250,
        asOfDate: "2025-01-31",
        sourceKey: "ibkr:pos:BBB:2025-01-31",
      },
    ],
    prices: [{ symbol: "AAA", date: "2025-01-31", closePrice: 105, source: "ibkr-activity" }],
    snapshots: [
      {
        accountName: "IBKR",
        monthEndDate: "2025-01-31",
        totalValue: 1300,
        source: "ibkr-activity",
        startingValue: 1000,
      },
    ],
    corporateActions: [],
    errors: [],
    warnings: [],
  } as unknown as ParsedImportResult;
}

/** Snapshot the batch-owned rows across every manifested table (id excluded — the
 *  upsert-style tables legitimately receive fresh autoincrement ids on restore
 *  where a natural-key conflict is resolved; content is what "pre-undo state" means). */
function snapshotBatchRows(db: Database.Database, batchId: number) {
  return {
    transactions: db.prepare("SELECT account_id, security_id, trade_date, type, quantity, amount, source_key FROM transactions WHERE import_batch_id = ? ORDER BY source_key").all(batchId),
    holdings: db.prepare("SELECT account_id, security_id, quantity, cost_basis, as_of_date, source_key FROM holdings WHERE import_batch_id = ? ORDER BY source_key").all(batchId),
    prices: db.prepare("SELECT security_id, date, close_price, source FROM prices WHERE import_batch_id = ? ORDER BY security_id, date").all(batchId),
    snapshots: db.prepare("SELECT account_id, month_end_date, total_value, source, starting_value FROM monthly_snapshots WHERE import_batch_id = ? ORDER BY account_id, month_end_date").all(batchId),
    corporateActions: db.prepare("SELECT security_id, action_type, effective_date, source_key FROM corporate_actions WHERE import_batch_id = ? ORDER BY source_key").all(batchId),
    rawImports: db.prepare("SELECT raw_data FROM raw_imports WHERE import_batch_id = ?").all(batchId),
    batch: db.prepare("SELECT id, source_type, filename, record_count FROM import_batches WHERE id = ?").get(batchId),
  };
}

describe("import-undo recovery — confirmation module", () => {
  beforeEach(() => resetUndoConfirmation());
  afterEach(() => resetUndoConfirmation());

  it("issues a token bound to a batch and consumes it exactly once", () => {
    const t0 = 1_000_000;
    const { token, expiresAt } = issueUndoToken(42, t0);
    expect(token.length).toBeGreaterThanOrEqual(16);
    expect(expiresAt).toBe(t0 + UNDO_TOKEN_TTL_MS);
    // wrong batch id -> rejected
    expect(consumeUndoToken(99, token, t0 + 1)).toBe(false);
    // correct batch id -> accepted, and single-use
    expect(consumeUndoToken(42, token, t0 + 1)).toBe(true);
    expect(consumeUndoToken(42, token, t0 + 2)).toBe(false);
  });

  it("rejects an expired token", () => {
    const t0 = 5_000_000;
    const { token } = issueUndoToken(7, t0);
    expect(consumeUndoToken(7, token, t0 + UNDO_TOKEN_TTL_MS + 1)).toBe(false);
  });

  it("throttles rapid destructive undos within the window", () => {
    const t0 = 9_000_000;
    for (let i = 0; i < MAX_UNDOS_PER_WINDOW; i++) {
      expect(checkUndoRateLimit(t0 + i)).toBe(true);
      recordUndo(t0 + i);
    }
    // window is now full
    expect(checkUndoRateLimit(t0 + MAX_UNDOS_PER_WINDOW)).toBe(false);
  });
});

describe("import-undo recovery — manifest", () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    db = fresh();
    dir = mkdtempSync(join(tmpdir(), "undo-recovery-"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("captures every batch-owned source table + metadata, with a valid checksum", () => {
    const res = commitImport(db, sampleParsed());
    const manifest = buildRecoveryManifest(db, res.batchId);

    // Metadata row present
    expect(manifest.batchId).toBe(res.batchId);
    expect(manifest.payload.importBatch).toMatchObject({ id: res.batchId, source_type: "ibkr-activity" });

    // Every batch-owned source table is represented as a key.
    for (const table of RECOVERY_SOURCE_TABLES) {
      expect(manifest.payload.tables).toHaveProperty(table);
    }

    // Counts match the DB exactly for each captured table.
    for (const table of RECOVERY_SOURCE_TABLES) {
      const dbCount = (db.prepare(`SELECT COUNT(*) c FROM ${table} WHERE import_batch_id = ?`).get(res.batchId) as { c: number }).c;
      expect(manifest.payload.tables[table].length).toBe(dbCount);
    }

    // Raw imported input captured (raw_imports holds the parsed JSON).
    expect(manifest.payload.tables.raw_imports.length).toBe(1);

    // Checksum validates; tampering breaks it.
    expect(verifyManifest(manifest)).toBe(true);
    const tampered = structuredClone(manifest);
    (tampered.payload.tables.holdings[0] as Record<string, unknown>).quantity = 99999;
    expect(verifyManifest(tampered)).toBe(false);
  });

  it("writes atomically to <batchId>-<ts>.json and prunes to retention N", () => {
    const res = commitImport(db, sampleParsed());
    const manifest = buildRecoveryManifest(db, res.batchId);

    const paths: string[] = [];
    for (let i = 0; i < 5; i++) {
      // vary createdAt so filenames differ
      const m = { ...manifest, createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString() };
      paths.push(writeRecoveryManifest(m, dir, 3));
    }
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    // retention = 3, no leftover temp files
    expect(files.length).toBe(3);
    expect(readdirSync(dir).some((f) => f.endsWith(".tmp"))).toBe(false);

    // The most recent write is readable and round-trips.
    const roundTrip = readRecoveryManifest(paths[paths.length - 1]);
    expect(verifyManifest(roundTrip)).toBe(true);
    expect(roundTrip.batchId).toBe(res.batchId);
  });
});

describe("import-undo recovery — restore", () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    db = fresh();
    dir = mkdtempSync(join(tmpdir(), "undo-recovery-"));
    resetUndoConfirmation();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    resetUndoConfirmation();
  });

  it("undo -> restore reproduces the pre-undo state for the batch's rows", () => {
    const res = commitImport(db, sampleParsed());
    const before = snapshotBatchRows(db, res.batchId);

    const { manifestPath } = undoImportWithRecovery(db, res.batchId, { manifestDir: dir });

    // Undo actually removed the batch.
    expect(db.prepare("SELECT COUNT(*) c FROM import_batches WHERE id = ?").get(res.batchId)).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM holdings WHERE import_batch_id = ?").get(res.batchId)).toEqual({ c: 0 });

    // Restore from the on-disk manifest.
    const manifest = readRecoveryManifest(manifestPath);
    restoreImportBatch(db, manifest);

    const after = snapshotBatchRows(db, res.batchId);
    expect(after).toEqual(before);
  });

  it("preserves statement authority: restore does not let a live row survive over the statement row", () => {
    const res = commitImport(db, sampleParsed());
    const manifest = buildRecoveryManifest(db, res.batchId);
    const aaaId = (db.prepare("SELECT id FROM securities WHERE symbol = 'AAA'").get() as { id: number }).id;
    const ibkrId = (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;

    undoImportWithRecovery(db, res.batchId, { manifestDir: dir });

    // Between undo and restore, a live TWS sync writes an intra-day row for the
    // same (account, security, as_of_date) slot the statement row owned.
    db.prepare(
      "INSERT INTO holdings (account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(ibkrId, aaaId, 999, 12345, "2025-01-31", "tws-live-AAA-2025-01-31");

    restoreImportBatch(db, manifest);

    // The statement row must WIN: exactly one row for the slot, carrying the
    // statement quantity + statement source_key, not the live values.
    const rows = db
      .prepare("SELECT quantity, source_key FROM holdings WHERE account_id = ? AND security_id = ? AND as_of_date = '2025-01-31'")
      .all(ibkrId, aaaId) as { quantity: number; source_key: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0].quantity).toBe(10);
    expect(rows[0].source_key).toBe("ibkr:pos:AAA:2025-01-31");
  });

  it("refuses to restore a manifest whose checksum does not validate", () => {
    const res = commitImport(db, sampleParsed());
    const manifest = buildRecoveryManifest(db, res.batchId);
    undoImportWithRecovery(db, res.batchId, { manifestDir: dir });
    const tampered = structuredClone(manifest);
    (tampered.payload.tables.holdings[0] as Record<string, unknown>).quantity = -1;
    expect(() => restoreImportBatch(db, tampered)).toThrow(/checksum/i);
  });
});

describe("import-undo recovery — re-import idempotence after undo", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = fresh();
  });
  afterEach(() => db.close());

  it("re-importing the same source after undo creates no duplicate rows", () => {
    const first = commitImport(db, sampleParsed());
    undoImportWithRecovery(db, first.batchId, { manifestDir: mkdtempSync(join(tmpdir(), "undo-recovery-")) });

    // Re-import works and re-importing twice is a no-op (deterministic source_key).
    const reimport = commitImport(db, sampleParsed());
    expect(reimport.newTransactions).toBe(1);
    expect(reimport.newHoldings).toBe(2);

    const again = commitImport(db, sampleParsed());
    expect(again.newTransactions).toBe(0);
    expect(again.newHoldings).toBe(0);
    expect(again.skippedDuplicates).toBeGreaterThan(0);

    // Exactly one copy of each source row survives.
    expect((db.prepare("SELECT COUNT(*) c FROM transactions").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM holdings").get() as { c: number }).c).toBe(2);
  });
});

describe("import-undo recovery — handleUndoRequest (route core)", () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    db = fresh();
    dir = mkdtempSync(join(tmpdir(), "undo-recovery-"));
    resetUndoConfirmation();
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    resetUndoConfirmation();
  });

  it("rejects an undo with no confirmation token — no deletion, returns a challenge", () => {
    const res = commitImport(db, sampleParsed());
    const out = handleUndoRequest(db, { batchId: res.batchId }, { manifestDir: dir, nowMs: 1000 });

    expect(out.body.success).toBe(false);
    expect(out.body.requiresConfirmation).toBe(true);
    expect(typeof out.body.confirmToken).toBe("string");
    // The batch is untouched.
    expect((db.prepare("SELECT COUNT(*) c FROM import_batches WHERE id = ?").get(res.batchId) as { c: number }).c).toBe(1);
  });

  it("proceeds with a valid token, writes a manifest BEFORE deleting, and returns success", () => {
    const res = commitImport(db, sampleParsed());
    const challenge = handleUndoRequest(db, { batchId: res.batchId }, { manifestDir: dir, nowMs: 1000 });
    const token = challenge.body.confirmToken as string;

    const out = handleUndoRequest(db, { batchId: res.batchId, confirm: token }, { manifestDir: dir, nowMs: 1001 });
    expect(out.status).toBe(200);
    expect(out.body.success).toBe(true);
    expect(typeof out.body.manifestPath).toBe("string");

    // Manifest exists on disk and the batch is gone.
    expect(readdirSync(dir).some((f) => f.endsWith(".json"))).toBe(true);
    expect((db.prepare("SELECT COUNT(*) c FROM import_batches WHERE id = ?").get(res.batchId) as { c: number }).c).toBe(0);

    // A replayed DELETE with the now-consumed token fails.
    const replay = handleUndoRequest(db, { batchId: res.batchId, confirm: token }, { manifestDir: dir, nowMs: 1002 });
    expect(replay.body.success).toBe(false);
    expect(replay.status).toBe(403);
  });

  it("throttles rapid confirmed undos across batches (429)", () => {
    // Create MAX_UNDOS_PER_WINDOW + 1 batches, each with a distinct source_key set.
    const batchIds: number[] = [];
    for (let i = 0; i <= MAX_UNDOS_PER_WINDOW; i++) {
      const parsed = sampleParsed();
      // make source keys unique per batch so each is a fresh committed batch
      parsed.transactions[0].sourceKey = `ibkr:txn:AAA:2025-01-15:buy:${i}`;
      parsed.holdings[0].sourceKey = `ibkr:pos:AAA:2025-01-31:${i}`;
      parsed.holdings[1].sourceKey = `ibkr:pos:BBB:2025-01-31:${i}`;
      batchIds.push(commitImport(db, parsed).batchId);
    }

    let throttled = 0;
    let ok = 0;
    for (let i = 0; i < batchIds.length; i++) {
      const now = 2000 + i; // all within the rate window
      const challenge = handleUndoRequest(db, { batchId: batchIds[i] }, { manifestDir: dir, nowMs: now });
      const token = challenge.body.confirmToken as string;
      const out = handleUndoRequest(db, { batchId: batchIds[i], confirm: token }, { manifestDir: dir, nowMs: now });
      if (out.status === 429) throttled++;
      else if (out.body.success) ok++;
    }
    expect(ok).toBe(MAX_UNDOS_PER_WINDOW);
    expect(throttled).toBeGreaterThanOrEqual(1);
  });
});
