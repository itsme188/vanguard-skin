// Slice D's event-merge handler (spec §4.4; plan M-D12; Codex round 1 #11/#13/#14).
// Runs SYNCHRONOUSLY inside mergeEarningsEventState's transaction, BEFORE
// slice B's handler: these tables reference print_watch_prints, which B
// deletes last. A worker still generating for the donor is cut off here —
// its row becomes `superseded`, so its finalise CAS fails and it writes no
// callouts. The target's fresh read comes from the reconcile (Task 7): its
// fingerprint changes with the merged inputs, and no hook fires from inside
// this transaction.
import type { EventMergeContext, EventMergeTableResult } from "@/lib/earnings/event-merge";
import { getPrintByEventId } from "./store";

export const FIRST_PASS_MERGE_HANDLER_NAME = "print-watch-first-pass";

function result(table: string, partial: Partial<EventMergeTableResult> = {}): EventMergeTableResult {
  return { table, moved: 0, merged: 0, deleted: 0, notes: [], ...partial };
}

export function mergeFirstPassState(ctx: EventMergeContext): EventMergeTableResult[] {
  const { db, donorEventId, targetEventId } = ctx;
  const donor = getPrintByEventId(db, donorEventId);
  const target = getPrintByEventId(db, targetEventId);
  const reads = result("print_watch_reads");
  const callouts = result("print_watch_callouts");
  // Only ONE side has a print (or they are the same row): B moves the print
  // itself and every read/callout rides along on print_id — nothing to do.
  if (!donor || !target || donor.id === target.id) return [reads, callouts];

  // #11: cut off any live donor worker.
  reads.merged = db
    .prepare(`UPDATE print_watch_reads SET status = 'superseded' WHERE print_id = ? AND status = 'generating'`)
    .run(donor.id).changes;
  if (reads.merged > 0) reads.notes.push(`${reads.merged} in-flight donor read(s) superseded`);
  // identical (fingerprint, nonce) = identical prompt — the target's copy stands.
  reads.deleted = db
    .prepare(
      `DELETE FROM print_watch_reads WHERE print_id = ? AND EXISTS (
         SELECT 1 FROM print_watch_reads t WHERE t.print_id = ? AND t.fingerprint = print_watch_reads.fingerprint AND t.nonce = print_watch_reads.nonce)`,
    )
    .run(donor.id, target.id).changes;
  reads.moved = db.prepare(`UPDATE print_watch_reads SET print_id = ? WHERE print_id = ?`).run(target.id, donor.id).changes;

  // #14: semantic key (doc_sha256, label_norm, unit) — the SAME identity the
  // UNIQUE index and finalizeReadDone's upsert use, so a merge can never mint
  // a pair the store itself would have folded into one row. Keep the target
  // row; an acceptance on the donor's copy survives on it.
  const dupes = db
    .prepare(
      `SELECT d.id AS donor_id, d.state AS donor_state, d.accepted_at AS donor_accepted_at, t.id AS target_id, t.state AS target_state
         FROM print_watch_callouts d JOIN print_watch_callouts t
           ON t.print_id = ? AND t.doc_sha256 = d.doc_sha256 AND t.label_norm = d.label_norm AND t.unit = d.unit
        WHERE d.print_id = ?`,
    )
    .all(target.id, donor.id) as Array<{
    donor_id: number;
    donor_state: string;
    donor_accepted_at: string | null;
    target_id: number;
    target_state: string;
  }>;
  const carry = db.prepare(`UPDATE print_watch_callouts SET state = 'accepted', accepted_at = ? WHERE id = ? AND state = 'proposed'`);
  const drop = db.prepare(`DELETE FROM print_watch_callouts WHERE id = ?`);
  for (const d of dupes) {
    if (d.donor_state === "accepted" && d.target_state === "proposed") {
      carry.run(d.donor_accepted_at, d.target_id);
      callouts.merged++;
      callouts.notes.push(`callout ${d.target_id} inherits the donor's acceptance`);
    }
    drop.run(d.donor_id);
    callouts.deleted++;
  }
  callouts.moved = db.prepare(`UPDATE print_watch_callouts SET print_id = ? WHERE print_id = ?`).run(target.id, donor.id).changes;
  return [reads, callouts];
}
