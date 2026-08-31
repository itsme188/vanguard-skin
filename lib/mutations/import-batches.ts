import type Database from "better-sqlite3";
import type { ImportBatch } from "@/lib/types";
import { stripArtifactSuffix } from "@/lib/mutations/donation-links";
import {
  bumpTaxGenerationIfPresent,
  bumpIfPricesAffectSyntheticCloses,
} from "@/lib/compute/tax-convention";

export function createImportBatch(
  db: Database.Database,
  sourceType: string,
  filename?: string
): ImportBatch {
  const result = db
    .prepare("INSERT INTO import_batches (source_type, filename) VALUES (?, ?)")
    .run(sourceType, filename ?? null);

  return db
    .prepare("SELECT * FROM import_batches WHERE id = ?")
    .get(result.lastInsertRowid) as ImportBatch;
}

export function completeImportBatch(
  db: Database.Database,
  batchId: number,
  recordCount: number,
  summary?: string
): void {
  db.prepare(
    "UPDATE import_batches SET status = 'completed', record_count = ?, summary = ? WHERE id = ?"
  ).run(recordCount, summary ?? null, batchId);
}

export function setImportBatchR2Key(
  db: Database.Database,
  batchId: number,
  r2Key: string
): void {
  db.prepare(
    "UPDATE import_batches SET raw_file_r2_key = ? WHERE id = ?"
  ).run(r2Key, batchId);
}

/**
 * Counts of live donation references INTO this batch's transactions —
 * `donation_leg_links.transaction_id` (out/artifact legs) and
 * `donation_lots.acquisition_transaction_id` (lot assignments). Used by the
 * undo refusal gate (§11-undo of the design doc): a transactions batch whose
 * rows are still claimed by a donation link/assignment must never be undone
 * silently (it would either orphan the reference or, worse, cascade-delete
 * the transaction out from under a confirmed donation record). The donation
 * may belong to ANY batch — this counts references regardless of which
 * batch owns the donation, only which batch owns the referenced transaction.
 */
export function batchDonationReferences(
  db: Database.Database,
  batchId: number
): { links: number; lots: number } {
  const links = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM donation_leg_links l
         JOIN transactions t ON t.id = l.transaction_id
         WHERE t.import_batch_id = ?`
      )
      .get(batchId) as { c: number }
  ).c;
  const lots = (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM donation_lots dl
         JOIN transactions t ON t.id = dl.acquisition_transaction_id
         WHERE t.import_batch_id = ?`
      )
      .get(batchId) as { c: number }
  ).c;
  return { links, lots };
}

/** Shared refusal message text — single source so undoImport (throw) and
 *  handleUndoRequest (409 body) never drift apart. */
export function donationReferenceRefusalMessage(refs: { links: number; lots: number }): string {
  return `${refs.links} donation links / ${refs.lots} lot assignments reference this batch's transactions — unlink or unassign them in Analysis › Giving first.`;
}

export function deleteImportBatch(db: Database.Database, batchId: number): void {
  db.transaction(() => {
    // Clear derived data first (tax lots reference transactions via FK)
    // These are fully recomputed by computeTaxLots() and computeDailyValuations()
    db.prepare("DELETE FROM tax_lot_sales").run();
    db.prepare("DELETE FROM tax_lots").run();
    db.prepare("DELETE FROM daily_valuations").run();
    // Delete source data in dependency order (children first)
    db.prepare("DELETE FROM raw_imports WHERE import_batch_id = ?").run(batchId);
    // Capture what is about to vanish: a deleted price can re-strike the
    // synthetic close computeTaxLots derives for a tombstoned security, so the
    // pairs have to be read BEFORE the DELETE (spec 2026-08-30 §4). This lives
    // here rather than in undoImport so DIRECT callers
    // (scripts/rebuild-ibkr-ledger.ts) are covered too — a direct deletion must
    // not be fail-open.
    const deletedPricePairs = db
      .prepare(`SELECT security_id AS securityId, date FROM prices WHERE import_batch_id = ?`)
      .all(batchId) as { securityId: number; date: string }[];
    db.prepare("DELETE FROM prices WHERE import_batch_id = ?").run(batchId);
    const holdingsDeleted = db
      .prepare("DELETE FROM holdings WHERE import_batch_id = ?")
      .run(batchId);
    // Donations owned by THIS batch (e.g. a daf-contributions batch) must be
    // torn down BEFORE the transactions delete below: their links/lots
    // cascade via FK the moment the donation row goes, but a routing_artifact
    // leg's is_external_flow demotion does NOT auto-revert on cascade — it
    // has to be restored explicitly first, exactly like unlinkDonationLegs.
    // The referenced OUT/artifact transactions almost always belong to a
    // DIFFERENT batch (daf-contributions never parses transactions), so this
    // must run whether or not this batch owns any transactions itself.
    const artifactLegs = db
      .prepare(
        `SELECT t.id AS id, t.notes AS notes
         FROM donation_leg_links l
         JOIN donations d ON d.id = l.donation_id
         JOIN transactions t ON t.id = l.transaction_id
         WHERE d.import_batch_id = ? AND l.role = 'routing_artifact'`
      )
      .all(batchId) as { id: number; notes: string | null }[];
    const restoreArtifactFlow = db.prepare(
      "UPDATE transactions SET is_external_flow = 1, notes = ? WHERE id = ?"
    );
    for (const leg of artifactLegs) {
      restoreArtifactFlow.run(stripArtifactSuffix(leg.notes), leg.id);
    }
    // Count donation_leg_links/donation_lots rows owned by THIS batch's own
    // donations — they cascade-delete the moment the DELETE FROM donations
    // below runs (ON DELETE CASCADE on donation_id), so a cascade never
    // shows up in that statement's own `.changes`. Counted up front so the
    // material-mutation check below can see it.
    const donationLinkLotCount = (
      db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM donation_leg_links l JOIN donations d ON d.id = l.donation_id WHERE d.import_batch_id = ?) +
             (SELECT COUNT(*) FROM donation_lots dl JOIN donations d ON d.id = dl.donation_id WHERE d.import_batch_id = ?) AS c`
        )
        .get(batchId, batchId) as { c: number }
    ).c;
    db.prepare("DELETE FROM donations WHERE import_batch_id = ?").run(batchId);
    const transactionsDeleted = db
      .prepare("DELETE FROM transactions WHERE import_batch_id = ?")
      .run(batchId);
    db.prepare("DELETE FROM monthly_snapshots WHERE import_batch_id = ?").run(batchId);
    // Import-sourced corporate actions (source='import') are batch-tagged;
    // undoing the batch removes the CA row too (see undoImport's caller-side
    // computeTaxLots/computeDailyValuations recompute, which restores
    // pre-split lots once the row is gone).
    const corporateActionsDeleted = db
      .prepare("DELETE FROM corporate_actions WHERE import_batch_id = ?")
      .run(batchId);
    db.prepare("DELETE FROM import_batches WHERE id = ?").run(batchId);

    // Undo is material to tax inputs whenever it removed a transaction,
    // corporate action, or donation link/lot row — donation-only batches
    // (e.g. a daf-contributions batch with no transactions of its own) are
    // material too, since they change lot consumption.
    if (
      transactionsDeleted.changes > 0 ||
      corporateActionsDeleted.changes > 0 ||
      donationLinkLotCount > 0 ||
      holdingsDeleted.changes > 0 // holdings feed RECONCILE_CLOSE synthesis (spec §4)
    ) {
      bumpTaxGenerationIfPresent(db);
    }
    // Price rows feed the synthetic close's selected price — evaluated AFTER
    // the holdings delete so the tombstone state it tests reflects the
    // post-delete book. A second bump here is harmless (fail-closed).
    bumpIfPricesAffectSyntheticCloses(db, deletedPricePairs);
  })();
}
