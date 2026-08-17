/**
 * Task 6 (donation tracking, §11-undo of the design doc): donation-aware
 * import undo + relation-based recovery manifest v2.
 *
 * Three behaviors, each independently destructive if missing:
 *
 *   (a) Undoing a TRANSACTIONS batch whose rows are still claimed by a live
 *       donation link (`donation_leg_links.transaction_id`) or lot
 *       assignment (`donation_lots.acquisition_transaction_id`) must be
 *       REFUSED (409-shaped), not silently cascaded or orphaned.
 *   (b) Undoing a DONATIONS batch (e.g. a daf-contributions import) must
 *       delete its donations AND restore any routing_artifact leg it
 *       demoted (is_external_flow back to 1, note suffix stripped) — those
 *       legs live in a DIFFERENT batch and are never themselves deleted.
 *   (c) The recovery manifest must survive both of the above: a batch's
 *       donations + their links/lots round-trip through undo -> restore
 *       even though the referenced transactions belong to a different,
 *       never-deleted batch (relation-based capture, remapped via stable
 *       source_key at restore time, not by id).
 *   (d) A v1 manifest (predating donations) must still restore.
 *
 * Drives the real pipeline where practical: parseImport + commitImport
 * against the Task 4 fixture, then the Task 2/3 mutations
 * (linkDonationLegs / assignDonationLots) for confirmation state. The
 * OUT/artifact/acquisition transactions are seeded directly into a SEPARATE
 * "legs" batch (raw INSERT, mirroring tests/mutations/donation-links.test.ts)
 * — this is deliberate, not a shortcut: it's the only way to exercise the
 * cross-batch relation-remap recovery.ts is built around, since
 * daf-contributions never parses transactions itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";

// route.ts imports the `@/lib/db` singleton at module load (opens the real
// on-disk DB). handleUndoRequest takes an explicit db param, so the
// singleton is never used here — stub it to keep the test hermetic (same
// pattern as tests/api/import-undo-recovery.test.ts).
vi.mock("@/lib/db", () => ({ db: {} }));

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@/lib/db/migrate";
import { parseImport, commitImport, undoImport } from "@/lib/import/engine";
import { createImportBatch } from "@/lib/mutations/import-batches";
import { upsertSecurity } from "@/lib/mutations/securities";
import { linkDonationLegs, assignDonationLots, ARTIFACT_NOTE_SUFFIX } from "@/lib/mutations/donation-links";
import {
  undoImportWithRecovery,
  restoreImportBatch,
  readRecoveryManifest,
  writeRecoveryManifest,
  computeManifestChecksum,
  MANIFEST_VERSION,
  type RecoveryManifest,
  type RecoveryPayload,
} from "@/lib/import/recovery";
import { handleUndoRequest } from "@/app/api/import/route";
import { checkUndoRateLimit, resetUndoConfirmation } from "@/lib/import/undo-confirmation";

const DAF_FIXTURE = readFileSync(join(__dirname, "../fixtures/daf-contributions-sample.csv"), "utf-8");

function fresh(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

/** Raw-insert a transaction into a given batch (mirrors donation-links.test.ts's
 *  seedTxn, but batch-scoped so it can live in a DIFFERENT batch than the
 *  donation under test — required to exercise the cross-batch remap). */
function seedTxn(
  db: Database.Database,
  batchId: number,
  args: {
    accountId: number;
    securityId: number;
    tradeDate: string;
    type: string;
    quantity: number;
    notes?: string | null;
    sourceKey: string;
  },
): number {
  const r = db
    .prepare(
      `INSERT INTO transactions (account_id, security_id, import_batch_id, trade_date, type, quantity, notes, source_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(args.accountId, args.securityId, batchId, args.tradeDate, args.type, args.quantity, args.notes ?? null, args.sourceKey);
  return r.lastInsertRowid as number;
}

function seedTaxLot(
  db: Database.Database,
  args: { accountId: number; securityId: number; acquisitionTxnId: number; acquisitionDate: string; quantity: number; costBasis: number },
): void {
  db.prepare(
    `INSERT INTO tax_lots (account_id, security_id, acquisition_transaction_id, acquisition_date, acquisition_price, quantity_acquired, quantity_remaining, cost_basis)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(args.accountId, args.securityId, args.acquisitionTxnId, args.acquisitionDate, args.costBasis / args.quantity, args.quantity, args.quantity, args.costBasis);
}

function getTxn(db: Database.Database, id: number) {
  return db.prepare("SELECT * FROM transactions WHERE id = ?").get(id) as {
    id: number;
    is_external_flow: number;
    notes: string | null;
  };
}

describe("Task 6: donation-aware undo + recovery", () => {
  describe("(a) refusal: undoing a batch whose transactions are still donation-referenced", () => {
    let db: Database.Database;
    let dir: string;
    let legsBatchId: number;
    let outTxnId: number;
    let donationId: number;

    beforeEach(async () => {
      db = fresh();
      dir = mkdtempSync(join(tmpdir(), "undo-recovery-"));
      resetUndoConfirmation();

      const fakeSecId = upsertSecurity(db, "FAKE", "Fake Co");
      legsBatchId = createImportBatch(db, "canonical-csv", "legs.csv").id;
      outTxnId = seedTxn(db, legsBatchId, {
        accountId: 1,
        securityId: fakeSecId,
        tradeDate: "2026-03-02",
        type: "TRANSFER_OUT",
        quantity: 10,
        sourceKey: "legs:out:1",
      });

      // A donation from a THIRD batch (any batch, or none) claims the OUT leg.
      const dafBatchId = createImportBatch(db, "daf-contributions", "contrib.csv").id;
      db.prepare(
        `INSERT INTO donations (source_key, import_batch_id, kind, security_id, quantity, fmv_usd, received_date)
         VALUES (?, ?, 'stock', ?, ?, ?, ?)`,
      ).run("daf:test:1", dafBatchId, fakeSecId, 10, 1000, "2026-03-02");
      donationId = (db.prepare("SELECT id FROM donations WHERE source_key = ?").get("daf:test:1") as { id: number }).id;
      linkDonationLegs(db, { donationId, outTransactionId: outTxnId });
    });

    afterEach(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
      resetUndoConfirmation();
    });

    it("undoImport throws a domain-language 409-shaped message and deletes nothing", () => {
      expect(() => undoImport(db, legsBatchId)).toThrow(
        /1 donation links \/ 0 lot assignments reference this batch's transactions/,
      );
      expect(() => undoImport(db, legsBatchId)).toThrow(/Analysis › Giving/);

      // Nothing was touched.
      expect(db.prepare("SELECT COUNT(*) c FROM import_batches WHERE id = ?").get(legsBatchId)).toEqual({ c: 1 });
      expect(db.prepare("SELECT COUNT(*) c FROM transactions WHERE id = ?").get(outTxnId)).toEqual({ c: 1 });
      expect(db.prepare("SELECT COUNT(*) c FROM donation_leg_links WHERE donation_id = ?").get(donationId)).toEqual({ c: 1 });
    });

    it("handleUndoRequest returns 409 before recordUndo burns the rate-limit slot; no manifest is written", () => {
      const challenge = handleUndoRequest(db, { batchId: legsBatchId }, { manifestDir: dir, nowMs: 1000 });
      const token = challenge.body.confirmToken as string;

      const out = handleUndoRequest(db, { batchId: legsBatchId, confirm: token }, { manifestDir: dir, nowMs: 1001 });
      expect(out.status).toBe(409);
      expect(out.body.success).toBe(false);
      expect(String(out.body.error)).toMatch(/1 donation links \/ 0 lot assignments/);

      // The batch survives, and the rate limiter never registered a confirmed undo.
      expect(db.prepare("SELECT COUNT(*) c FROM import_batches WHERE id = ?").get(legsBatchId)).toEqual({ c: 1 });
      expect(checkUndoRateLimit(1002)).toBe(true);
    });

    it("a lot assignment (not just a leg link) also refuses the acquisition transaction's batch", () => {
      // Separate acquisition-only batch, referenced solely via donation_lots.
      const acqBatchId = createImportBatch(db, "canonical-csv", "acq.csv").id;
      const fakeSecId = (db.prepare("SELECT id FROM securities WHERE symbol = 'FAKE'").get() as { id: number }).id;
      const acqTxnId = seedTxn(db, acqBatchId, {
        accountId: 1,
        securityId: fakeSecId,
        tradeDate: "2026-01-15",
        type: "BUY",
        quantity: 10,
        sourceKey: "acq:buy:1",
      });
      seedTaxLot(db, { accountId: 1, securityId: fakeSecId, acquisitionTxnId: acqTxnId, acquisitionDate: "2026-01-15", quantity: 10, costBasis: 500 });
      assignDonationLots(db, donationId, [{ acquisitionTransactionId: acqTxnId, quantity: 10 }]);

      expect(() => undoImport(db, acqBatchId)).toThrow(/0 donation links \/ 1 lot assignments reference this batch's transactions/);
      expect(db.prepare("SELECT COUNT(*) c FROM import_batches WHERE id = ?").get(acqBatchId)).toEqual({ c: 1 });
    });
  });

  describe("(b) donations-batch undo: donations gone, artifact leg's flow flag + note restored", () => {
    let db: Database.Database;
    let legsBatchId: number;
    let outTxnId: number;
    let artifactTxnId: number;
    let dafBatchId: number;
    let fakeDonationId: number;

    beforeEach(async () => {
      db = fresh();
      const fakeSecId = upsertSecurity(db, "FAKE", "Fake Co");

      legsBatchId = createImportBatch(db, "canonical-csv", "legs.csv").id;
      outTxnId = seedTxn(db, legsBatchId, {
        accountId: 1,
        securityId: fakeSecId,
        tradeDate: "2026-03-02",
        type: "TRANSFER_OUT",
        quantity: 10,
        sourceKey: "legs:out:1",
      });
      artifactTxnId = seedTxn(db, legsBatchId, {
        accountId: 1,
        securityId: fakeSecId,
        tradeDate: "2026-03-02",
        type: "TRANSFER_IN",
        quantity: 10,
        notes: "Some existing note",
        sourceKey: "legs:in:1",
      });

      const parsed = await parseImport(DAF_FIXTURE, "contrib.csv");
      const result = commitImport(db, parsed);
      dafBatchId = result.batchId;
      expect(result.newDonations).toBe(3); // FAKE (stock), USD (cash), ZZZZ (unresolved stock)

      fakeDonationId = (db.prepare("SELECT id FROM donations WHERE symbol_raw = 'FAKE'").get() as { id: number }).id;
      linkDonationLegs(db, { donationId: fakeDonationId, outTransactionId: outTxnId, artifactTransactionId: artifactTxnId });

      // Pre-undo sanity: the link demoted the artifact leg.
      const artifactBefore = getTxn(db, artifactTxnId);
      expect(artifactBefore.is_external_flow).toBe(0);
      expect(artifactBefore.notes).toBe(`Some existing note${ARTIFACT_NOTE_SUFFIX}`);
    });

    afterEach(() => db.close());

    it("removes every donation the batch owns and restores the artifact leg's flow flag + notes", () => {
      undoImport(db, dafBatchId);

      // The whole batch is gone, donations included.
      expect(db.prepare("SELECT COUNT(*) c FROM import_batches WHERE id = ?").get(dafBatchId)).toEqual({ c: 0 });
      expect(db.prepare("SELECT COUNT(*) c FROM donations WHERE import_batch_id = ?").get(dafBatchId)).toEqual({ c: 0 });
      expect(db.prepare("SELECT COUNT(*) c FROM donation_leg_links").get()).toEqual({ c: 0 });

      // The artifact leg lives in a DIFFERENT (untouched) batch — it survives,
      // with its pre-link state restored.
      const artifact = getTxn(db, artifactTxnId);
      expect(artifact.is_external_flow).toBe(1);
      expect(artifact.notes).toBe("Some existing note");

      // The OUT leg and its owning batch are untouched too.
      expect(db.prepare("SELECT COUNT(*) c FROM transactions WHERE id = ?").get(outTxnId)).toEqual({ c: 1 });
      expect(db.prepare("SELECT COUNT(*) c FROM import_batches WHERE id = ?").get(legsBatchId)).toEqual({ c: 1 });
    });
  });

  describe("(c) recovery round-trip: relation-based capture survives undo -> restore", () => {
    let db: Database.Database;
    let dir: string;
    let legsBatchId: number;
    let outTxnId: number;
    let artifactTxnId: number;
    let acqTxnId: number;
    let dafBatchId: number;
    let fakeDonationSourceKey: string;
    let donationBefore: Record<string, unknown>;

    beforeEach(async () => {
      db = fresh();
      dir = mkdtempSync(join(tmpdir(), "undo-recovery-"));
      const fakeSecId = upsertSecurity(db, "FAKE", "Fake Co");

      legsBatchId = createImportBatch(db, "canonical-csv", "legs.csv").id;
      acqTxnId = seedTxn(db, legsBatchId, {
        accountId: 1,
        securityId: fakeSecId,
        tradeDate: "2026-01-15",
        type: "BUY",
        quantity: 10,
        sourceKey: "legs:buy:1",
      });
      seedTaxLot(db, { accountId: 1, securityId: fakeSecId, acquisitionTxnId: acqTxnId, acquisitionDate: "2026-01-15", quantity: 10, costBasis: 500 });
      outTxnId = seedTxn(db, legsBatchId, {
        accountId: 1,
        securityId: fakeSecId,
        tradeDate: "2026-03-02",
        type: "TRANSFER_OUT",
        quantity: 10,
        sourceKey: "legs:out:1",
      });
      artifactTxnId = seedTxn(db, legsBatchId, {
        accountId: 1,
        securityId: fakeSecId,
        tradeDate: "2026-03-02",
        type: "TRANSFER_IN",
        quantity: 10,
        sourceKey: "legs:in:1",
      });

      const parsed = await parseImport(DAF_FIXTURE, "contrib.csv");
      dafBatchId = commitImport(db, parsed).batchId;

      const fakeDonation = db.prepare("SELECT id, source_key FROM donations WHERE symbol_raw = 'FAKE'").get() as {
        id: number;
        source_key: string;
      };
      fakeDonationSourceKey = fakeDonation.source_key;

      linkDonationLegs(db, { donationId: fakeDonation.id, outTransactionId: outTxnId, artifactTransactionId: artifactTxnId });
      assignDonationLots(db, fakeDonation.id, [{ acquisitionTransactionId: acqTxnId, quantity: 10 }]);

      donationBefore = db
        .prepare("SELECT kind, security_id, symbol_raw, quantity, fmv_usd, received_date FROM donations WHERE source_key = ?")
        .get(fakeDonationSourceKey) as Record<string, unknown>;
    });

    afterEach(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("captures relations via stable source_key and remaps them correctly on restore", () => {
      const { manifestPath } = undoImportWithRecovery(db, dafBatchId, { manifestDir: dir });

      // Undo actually removed the daf batch and cascaded its links/lots.
      expect(db.prepare("SELECT COUNT(*) c FROM import_batches WHERE id = ?").get(dafBatchId)).toEqual({ c: 0 });
      expect(db.prepare("SELECT COUNT(*) c FROM donations").get()).toEqual({ c: 0 });
      expect(db.prepare("SELECT COUNT(*) c FROM donation_leg_links").get()).toEqual({ c: 0 });
      expect(db.prepare("SELECT COUNT(*) c FROM donation_lots").get()).toEqual({ c: 0 });
      // The legs batch (a DIFFERENT batch) is untouched.
      expect(db.prepare("SELECT COUNT(*) c FROM transactions WHERE import_batch_id = ?").get(legsBatchId)).toEqual({ c: 3 });

      const manifest = readRecoveryManifest(manifestPath);
      expect(manifest.version).toBe(MANIFEST_VERSION);
      expect(manifest.payload.donations.length).toBe(3);
      // Two link relation rows (the out leg + the artifact leg), one lot relation.
      expect(manifest.payload.donationLinkRelations.length).toBe(2);
      expect(manifest.payload.donationLotRelations.length).toBe(1);
      expect(manifest.payload.donationLinkRelations.every((r) => r.donation_source_key === fakeDonationSourceKey)).toBe(true);
      expect(manifest.payload.donationLinkRelations.map((r) => r.transaction_source_key).sort()).toEqual(["legs:in:1", "legs:out:1"]);

      const result = restoreImportBatch(db, manifest);
      expect(result.restored.donations).toBe(3);
      expect(result.restored.donation_leg_links).toBe(2);
      expect(result.restored.donation_lots).toBe(1);

      // Every table lines up: no dangling FK anywhere in the restored db.
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

      const restoredDonation = db
        .prepare("SELECT id, kind, security_id, symbol_raw, quantity, fmv_usd, received_date FROM donations WHERE source_key = ?")
        .get(fakeDonationSourceKey) as Record<string, unknown> & { id: number };
      expect(restoredDonation).toMatchObject(donationBefore);
      // A FRESH id was assigned — the pre-undo id is gone for good (see stripRowId).
      expect(db.prepare("SELECT COUNT(*) c FROM donations WHERE import_batch_id = ?").get(dafBatchId)).toEqual({ c: 3 });

      const restoredLinks = db
        .prepare("SELECT transaction_id, role FROM donation_leg_links WHERE donation_id = ? ORDER BY role")
        .all(restoredDonation.id) as { transaction_id: number; role: string }[];
      expect(restoredLinks).toEqual([
        { transaction_id: outTxnId, role: "out" },
        { transaction_id: artifactTxnId, role: "routing_artifact" },
      ]);

      const restoredLots = db
        .prepare("SELECT acquisition_transaction_id, quantity FROM donation_lots WHERE donation_id = ?")
        .all(restoredDonation.id) as { acquisition_transaction_id: number; quantity: number }[];
      expect(restoredLots).toEqual([{ acquisition_transaction_id: acqTxnId, quantity: 10 }]);

      // Reversible-provenance symmetry (spec §9): undo reverted the artifact
      // leg's flow flag/note because the link was dying. Restoring the link
      // must resurrect the demotion with it — link state and flow flag must
      // never disagree. This is a full round-trip: the values here should
      // match the leg's ORIGINAL pre-undo demoted state exactly.
      const artifactAfterRestore = getTxn(db, artifactTxnId);
      expect(artifactAfterRestore.is_external_flow).toBe(0);
      expect(artifactAfterRestore.notes).toBe(ARTIFACT_NOTE_SUFFIX.trim());
    });

    it("skips a relation with a restore warning (never throws) when its referenced transaction's batch was never restored", () => {
      const { manifestPath } = undoImportWithRecovery(db, dafBatchId, { manifestDir: dir });
      const manifest = readRecoveryManifest(manifestPath);

      // Simulate the cross-batch transaction genuinely being gone: undo the
      // legs batch too (it owns no donation references anymore — the daf
      // batch that referenced it was already undone above).
      undoImport(db, legsBatchId);

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const result = restoreImportBatch(db, manifest);
      warnSpy.mockRestore();

      // Donations restore fine; the relations referencing the now-absent
      // transactions are silently skipped, not thrown.
      expect(result.restored.donations).toBe(3);
      expect(result.restored.donation_leg_links).toBe(0);
      expect(result.restored.donation_lots).toBe(0);
      expect(db.prepare("SELECT COUNT(*) c FROM donation_leg_links").get()).toEqual({ c: 0 });
      expect(db.prepare("SELECT COUNT(*) c FROM donation_lots").get()).toEqual({ c: 0 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });

  describe("(d) a v1 manifest (predating donation fields) still restores", () => {
    let db: Database.Database;
    let dir: string;

    beforeEach(() => {
      db = fresh();
      dir = mkdtempSync(join(tmpdir(), "undo-recovery-v1-"));
    });
    afterEach(() => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("restores a hand-built v1-shaped manifest (no donations / relation keys) without throwing", () => {
      const batch = createImportBatch(db, "canonical-csv", "v1.csv");
      db.prepare(
        `INSERT INTO transactions (account_id, trade_date, type, quantity, import_batch_id, source_key)
         VALUES (1, '2026-01-01', 'BUY', 1, ?, 'v1:txn:1')`,
      ).run(batch.id);

      const importBatchRow = db.prepare("SELECT * FROM import_batches WHERE id = ?").get(batch.id);
      const txnRows = db.prepare("SELECT * FROM transactions WHERE import_batch_id = ?").all(batch.id);

      // Deliberately the OLD shape — donations/donationLinkRelations/
      // donationLotRelations keys are simply absent, exactly like a real file
      // written before this task shipped.
      const v1Payload = {
        importBatch: importBatchRow,
        tables: {
          transactions: txnRows,
          holdings: [],
          prices: [],
          monthly_snapshots: [],
          corporate_actions: [],
          raw_imports: [],
        },
      } as unknown as RecoveryPayload;

      const v1Manifest: RecoveryManifest = {
        version: 1,
        batchId: batch.id,
        createdAt: new Date().toISOString(),
        checksum: computeManifestChecksum(v1Payload),
        payload: v1Payload,
      };
      const manifestPath = writeRecoveryManifest(v1Manifest, dir, 25);

      undoImport(db, batch.id);
      expect(db.prepare("SELECT COUNT(*) c FROM import_batches WHERE id = ?").get(batch.id)).toEqual({ c: 0 });

      const readBack = readRecoveryManifest(manifestPath);
      expect(readBack.payload.donations).toBeUndefined(); // genuinely absent, not defaulted on read

      expect(() => restoreImportBatch(db, readBack)).not.toThrow();
      expect(db.prepare("SELECT COUNT(*) c FROM import_batches WHERE id = ?").get(batch.id)).toEqual({ c: 1 });
      expect(db.prepare("SELECT COUNT(*) c FROM transactions WHERE import_batch_id = ?").get(batch.id)).toEqual({ c: 1 });
      expect(db.prepare("SELECT COUNT(*) c FROM donations WHERE import_batch_id = ?").get(batch.id)).toEqual({ c: 0 });
    });
  });
});
