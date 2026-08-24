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
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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
  computeManifestChecksum,
  RECOVERY_SOURCE_TABLES,
} from "@/lib/import/recovery";
import { getTaxInputGeneration } from "@/lib/compute/tax-convention";
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

  // Task 4 (number-trust durable fixes, batched controller ruling): restore
  // re-inserts transactions/CAs/donation rows straight into their tables —
  // that reintroduces tax-relevant inputs, so it must bump the tax-input
  // generation the same way every other mutation site does, or a reader
  // (cost-basis-reconciliation, portfolio-summary, giving-view) could keep
  // trusting a stale "recompute current" stamp after the restore.
  it("bumps the tax-input generation when restore reinserts transaction rows", () => {
    const res = commitImport(db, sampleParsed());
    const manifest = buildRecoveryManifest(db, res.batchId);

    undoImportWithRecovery(db, res.batchId, { manifestDir: dir });
    const genBeforeRestore = getTaxInputGeneration(db);

    restoreImportBatch(db, manifest);

    expect(getTaxInputGeneration(db)).toBeGreaterThan(genBeforeRestore);
  });

  it("does NOT bump the tax-input generation for a holdings/prices-only restore (no transactions/CAs/donations)", () => {
    const res = commitImport(db, sampleParsed());
    const manifest = buildRecoveryManifest(db, res.batchId);
    // Strip the transaction + corporate-action rows so this restore carries
    // ONLY holdings/prices/snapshots — never a tax input — and re-seal the
    // checksum over the edited payload (mirrors the tampering pattern above).
    manifest.payload.tables.transactions = [];
    manifest.payload.tables.corporate_actions = [];
    manifest.checksum = computeManifestChecksum(manifest.payload);

    undoImportWithRecovery(db, res.batchId, { manifestDir: dir });
    const genBeforeRestore = getTaxInputGeneration(db);

    const result = restoreImportBatch(db, manifest);
    expect(result.restored.transactions).toBe(0);
    expect(result.restored.holdings).toBe(2);

    expect(getTaxInputGeneration(db)).toBe(genBeforeRestore);
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

describe("import-undo recovery — corporate actions capture/restore", () => {
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

  it("captures a corporate_actions row and restores it after undo", () => {
    const parsed = sampleParsed();
    parsed.corporateActions = [
      {
        symbol: "AAA",
        accountName: "IBKR",
        actionType: "SPLIT",
        effectiveDate: "2025-01-20",
        ratioNumerator: 2,
        ratioDenominator: 1,
        sourceKey: "ibkr:ca:AAA:2025-01-20",
        quantityDelta: 10,
      },
    ] as unknown as ParsedImportResult["corporateActions"];

    const res = commitImport(db, parsed);
    expect((db.prepare("SELECT COUNT(*) c FROM corporate_actions WHERE import_batch_id = ?").get(res.batchId) as { c: number }).c).toBe(1);

    const manifest = buildRecoveryManifest(db, res.batchId);
    expect(manifest.payload.tables.corporate_actions.length).toBe(1);

    undoImportWithRecovery(db, res.batchId, { manifestDir: dir });
    expect((db.prepare("SELECT COUNT(*) c FROM corporate_actions").get() as { c: number }).c).toBe(0);

    restoreImportBatch(db, manifest);
    const rows = db
      .prepare("SELECT action_type, effective_date, source_key, source FROM corporate_actions WHERE import_batch_id = ?")
      .all(res.batchId);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      action_type: "SPLIT",
      effective_date: "2025-01-20",
      source_key: "ibkr:ca:AAA:2025-01-20",
      source: "import",
    });
  });
});

describe("import-undo recovery — restore hardening (fix round)", () => {
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

  it("assigns fresh child ids so an intervening write on a freed id can't break restore", () => {
    const res = commitImport(db, sampleParsed());
    const manifest = buildRecoveryManifest(db, res.batchId);
    const holdingsCount = manifest.payload.tables.holdings.length;
    const txnCount = manifest.payload.tables.transactions.length;
    const freedHoldingId = manifest.payload.tables.holdings[0].id as number;
    const freedTxnId = manifest.payload.tables.transactions[0].id as number;
    const ibkrId = (db.prepare("SELECT id FROM accounts WHERE name = 'IBKR'").get() as { id: number }).id;

    undoImportWithRecovery(db, res.batchId, { manifestDir: dir });

    // A separate security + intervening rows that GRAB the batch's freed child
    // ids (simulating an id reuse between undo and restore). Distinct natural
    // keys, so ONLY the primary key would collide.
    const cccId = Number(db.prepare("INSERT INTO securities (symbol, name) VALUES ('CCC', 'Gamma')").run().lastInsertRowid);
    db.prepare(
      "INSERT INTO holdings (id, account_id, security_id, quantity, cost_basis, as_of_date, source_key) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(freedHoldingId, ibkrId, cccId, 3, 30, "2025-02-28", "tws-CCC-2025-02-28");
    db.prepare(
      "INSERT INTO transactions (id, account_id, security_id, trade_date, type, quantity, source_key) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(freedTxnId, ibkrId, cccId, "2025-02-10", "BUY", 3, "tws:txn:CCC:2025-02-10");

    // Verbatim-id restore would ABORT (holdings PK conflict) or silently drop
    // (transactions OR IGNORE on PK). Fresh-id restore fully restores A.
    restoreImportBatch(db, manifest);

    expect(db.prepare("SELECT COUNT(*) c FROM holdings WHERE import_batch_id = ?").get(res.batchId)).toEqual({ c: holdingsCount });
    expect(db.prepare("SELECT COUNT(*) c FROM transactions WHERE import_batch_id = ?").get(res.batchId)).toEqual({ c: txnCount });
    // The intervening rows are untouched.
    expect((db.prepare("SELECT COUNT(*) c FROM holdings WHERE source_key = 'tws-CCC-2025-02-28'").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM transactions WHERE source_key = 'tws:txn:CCC:2025-02-10'").get() as { c: number }).c).toBe(1);
  });

  it("hard-refuses restore when the import_batches id is occupied by a DIFFERENT batch", () => {
    const res = commitImport(db, sampleParsed());
    const manifest = buildRecoveryManifest(db, res.batchId);
    undoImportWithRecovery(db, res.batchId, { manifestDir: dir });

    // A different batch now occupies the freed id.
    db.prepare("INSERT INTO import_batches (id, source_type, filename) VALUES (?, 'manual', 'other.csv')").run(res.batchId);

    expect(() => restoreImportBatch(db, manifest)).toThrow(/different batch/i);
    // The occupying batch is untouched.
    expect((db.prepare("SELECT source_type FROM import_batches WHERE id = ?").get(res.batchId) as { source_type: string }).source_type).toBe("manual");
  });

  it("chronological prune keeps the freshly-written low-batchId manifest when N older high-batchId ones exist", () => {
    const res = commitImport(db, sampleParsed());
    const base = buildRecoveryManifest(db, res.batchId);

    // 25 OLDER manifests filed under a HIGH batch id (filenames "9-...").
    for (let i = 0; i < 25; i++) {
      writeRecoveryManifest(
        { ...base, batchId: 9, createdAt: new Date(Date.UTC(2025, 0, 1, 0, 0, i)).toISOString() },
        dir,
        25,
      );
    }
    // A fresh manifest under a LOW batch id (filename "10-...") but the NEWEST
    // timestamp. A filename sort would prune it ("10-" < "9-"); a chronological
    // sort must keep it.
    const freshPath = writeRecoveryManifest(
      { ...base, batchId: 10, createdAt: new Date(Date.UTC(2025, 0, 1, 1, 0, 0)).toISOString() },
      dir,
      25,
    );

    expect(existsSync(freshPath)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBe(25);
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

  // QA import-undo--500-eperm-recovery-manifest-in-app-bundle: in the
  // packaged app the manifest dir resolved inside the read-only signed
  // bundle, so writeRecoveryManifest threw EPERM and the route echoed the raw
  // Node error (path and all) as a 500. The write happens BEFORE any row is
  // deleted, so the honest report is "nothing was deleted".
  it("reports an unwritable manifest dir in domain language and deletes nothing", () => {
    const res = commitImport(db, sampleParsed());
    const challenge = handleUndoRequest(db, { batchId: res.batchId }, { manifestDir: dir, nowMs: 1000 });
    const token = challenge.body.confirmToken as string;

    // A path under a regular FILE can never be created — the same class of
    // failure as EPERM inside the code-signed bundle, without needing root.
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "x");
    const unwritable = join(blocker, "undo-recovery");

    const out = handleUndoRequest(
      db,
      { batchId: res.batchId, confirm: token },
      { manifestDir: unwritable, nowMs: 1001 },
    );

    expect(out.status).toBe(500);
    expect(out.body.success).toBe(false);
    const error = out.body.error as string;
    expect(error).toMatch(/nothing was deleted/i);
    // No internal path / raw Node error code leaks to the user.
    expect(error).not.toContain(unwritable);
    expect(error).not.toMatch(/ENOTDIR|EPERM|EACCES/);

    // The batch and its rows survived.
    expect(
      (db.prepare("SELECT COUNT(*) c FROM import_batches WHERE id = ?").get(res.batchId) as { c: number }).c,
    ).toBe(1);
    expect(
      (db.prepare("SELECT COUNT(*) c FROM transactions WHERE import_batch_id = ?").get(res.batchId) as { c: number }).c,
    ).toBeGreaterThan(0);
  });
});
