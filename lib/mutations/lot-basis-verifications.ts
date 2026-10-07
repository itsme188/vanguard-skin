import type Database from "better-sqlite3";
import { LOT_CREATING_TYPES } from "@/lib/mutations/donation-links";
import { readDonatedLotBasisFigures } from "@/lib/queries/giving-view";
import { isTaxConventionPending } from "@/lib/compute/tax-convention";

/**
 * "Basis verified" markers for donated lots (owner request 2026-10-07,
 * migration 095).
 *
 * The Giving page flags a donated lot whose basis is implausibly small and
 * leaves its gift out of "Gain avoided". When the owner has checked the basis
 * against a source document and it is in fact right, a marker records that,
 * with the source. The reader is `donatedLotBasisState` in
 * lib/queries/giving-view.ts.
 *
 * These functions write ONLY `lot_basis_verifications`. They never touch a
 * transaction, a tax lot or the tax input generation, and they never trigger
 * a recompute: a marker is a note that a check happened, not a tax input.
 */

/** Longest source note accepted, measured after trimming. */
export const SOURCE_NOTE_MAX_LENGTH = 200;

export type LotBasisVerificationErrorCode =
  | "invalid_id"
  | "invalid_note"
  | "not_found"
  | "not_acquisition"
  | "not_donated"
  | "ledger_pending"
  | "no_lot";

/** Every refusal in this file. `code` lets a route pick its status; the
 *  message is plain English and safe to show. */
export class LotBasisVerificationError extends Error {
  readonly code: LotBasisVerificationErrorCode;
  constructor(code: LotBasisVerificationErrorCode, message: string) {
    super(message);
    this.name = "LotBasisVerificationError";
    this.code = code;
  }
}

export interface LotBasisVerification {
  acquisitionTransactionId: number;
  sourceNote: string;
  verifiedAt: string;
}

function isPositiveInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n > 0;
}

/**
 * Records that the owner verified this lot's basis against `sourceNote`.
 * Snapshots the LOT's cost basis and quantity acquired (`tax_lots`, the
 * figures the Giving view shows and the 1% rule reads), so anything that
 * later moves either makes the marker stale. Marking a lot again replaces
 * its one marker: new note, new snapshot, new date.
 *
 * Refused while the tax-lot ledger is waiting on a recompute: the stored
 * lot may not show the basis the next recompute will produce, and a
 * snapshot of it would verify a figure the owner never saw settle.
 */
export function markLotBasisVerified(
  db: Database.Database,
  args: { acquisitionTransactionId: number; sourceNote: string }
): LotBasisVerification {
  const { acquisitionTransactionId } = args;
  if (!isPositiveInteger(acquisitionTransactionId)) {
    throw new LotBasisVerificationError("invalid_id", "The lot's transaction id must be a positive whole number.");
  }
  if (typeof args.sourceNote !== "string") {
    throw new LotBasisVerificationError("invalid_note", "Say what you checked the basis against.");
  }
  const sourceNote = args.sourceNote.trim();
  if (sourceNote.length === 0) {
    throw new LotBasisVerificationError("invalid_note", "Say what you checked the basis against.");
  }
  if (sourceNote.length > SOURCE_NOTE_MAX_LENGTH) {
    throw new LotBasisVerificationError(
      "invalid_note",
      `The source note is too long: keep it to ${SOURCE_NOTE_MAX_LENGTH} characters or fewer.`
    );
  }

  return db.transaction(() => {
    const txn = db
      .prepare("SELECT id, type FROM transactions WHERE id = ?")
      .get(acquisitionTransactionId) as { id: number; type: string } | undefined;
    if (!txn) {
      throw new LotBasisVerificationError("not_found", `Transaction ${acquisitionTransactionId} was not found.`);
    }
    if (!LOT_CREATING_TYPES.has(txn.type.toLowerCase())) {
      throw new LotBasisVerificationError(
        "not_acquisition",
        `Transaction ${acquisitionTransactionId} is not a purchase or transfer in, so it is not a lot.`
      );
    }
    const drawn = db
      .prepare("SELECT 1 FROM donation_lots WHERE acquisition_transaction_id = ? LIMIT 1")
      .get(acquisitionTransactionId);
    if (!drawn) {
      throw new LotBasisVerificationError(
        "not_donated",
        `No donation draws on this lot, so there is no donated basis to verify.`
      );
    }
    if (isTaxConventionPending(db)) {
      throw new LotBasisVerificationError(
        "ledger_pending",
        "The tax-lot ledger is waiting on a recompute, so the basis shown may be out of date. Recompute first, then verify."
      );
    }
    const lot = readDonatedLotBasisFigures(db, acquisitionTransactionId);
    if (!lot) {
      throw new LotBasisVerificationError(
        "no_lot",
        "This lot is not in the tax-lot ledger, so there is no basis to verify. Recompute first, then verify."
      );
    }

    db.prepare(
      `INSERT INTO lot_basis_verifications
         (acquisition_transaction_id, source_note, verified_amount, verified_quantity)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(acquisition_transaction_id) DO UPDATE SET
         source_note = excluded.source_note,
         verified_amount = excluded.verified_amount,
         verified_quantity = excluded.verified_quantity,
         verified_at = datetime('now')`
    ).run(acquisitionTransactionId, sourceNote, lot.costBasis, lot.quantityAcquired);

    const saved = db
      .prepare("SELECT source_note, verified_at FROM lot_basis_verifications WHERE acquisition_transaction_id = ?")
      .get(acquisitionTransactionId) as { source_note: string; verified_at: string };
    return { acquisitionTransactionId, sourceNote: saved.source_note, verifiedAt: saved.verified_at };
  })();
}

/** Removes the lot's marker. Returns whether there was one. */
export function unmarkLotBasisVerified(db: Database.Database, acquisitionTransactionId: number): boolean {
  if (!isPositiveInteger(acquisitionTransactionId)) {
    throw new LotBasisVerificationError("invalid_id", "The lot's transaction id must be a positive whole number.");
  }
  const result = db
    .prepare("DELETE FROM lot_basis_verifications WHERE acquisition_transaction_id = ?")
    .run(acquisitionTransactionId);
  return result.changes > 0;
}
