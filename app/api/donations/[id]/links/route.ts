import { db } from "@/lib/db";
import { linkDonationLegs, unlinkDonationLegs, DonationLinkError } from "@/lib/mutations/donation-links";
import { DonationIdentityConflictError } from "@/lib/mutations/donations";
import { donationExists } from "@/lib/queries/giving-view";
import {
  applyOrRehearse,
  isLedgerRecomputeAcknowledged,
  ledgerRecomputeRefusal,
  recomputeAfterDonationMutation,
} from "@/lib/compute/donation-recompute";

/**
 * POST/DELETE /api/donations/:id/links — confirm/undo the OUT (+ optional
 * routing-artifact) leg link for a stock donation (spec §7, Task 3
 * linkDonationLegs/unlinkDonationLegs). Thin wrapper: every invariant lives
 * in lib/mutations/donation-links.ts.
 *
 * POST body: { outTransactionId: number, artifactTransactionId?: number,
 * amountForOutLeg?: number, acknowledgeLedgerRecompute: true }.
 * DELETE body: { acknowledgeLedgerRecompute: true }.
 *
 * Both end in a whole-ledger recompute, so both are refused with 409
 * `ledger_recompute_unacknowledged` and a census of the ledger when the
 * acknowledgement is missing (lib/compute/donation-recompute-contract.ts);
 * nothing is written. That 409 is told apart from the "already linked" 409
 * below by its `code`.
 *
 * A donation can only ever hold one confirmed 'out' link
 * (idx_donation_out_link, a partial UNIQUE index on donation_leg_links).
 * linkDonationLegs' own "already linked" guard only checks the incoming
 * TRANSACTION id, not the donation id — so re-linking an already-out-linked
 * donation with a DIFFERENT (itself unlinked) out transaction sails past
 * that guard and hits the index as a raw better-sqlite3 SqliteError. That
 * shape is caught here and translated to a domain 409, never a 500.
 */

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? null : id;
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}

function parseOptionalAmount(raw: unknown): { ok: true; value: number | null } | { ok: false } {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return { ok: false };
  return { ok: true, value: raw };
}

interface LinkBody {
  acknowledgeLedgerRecompute?: boolean;
  outTransactionId?: number;
  artifactTransactionId?: number | null;
  amountForOutLeg?: number | null;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const donationId = parseId(id);
  if (donationId == null) {
    return Response.json({ success: false, error: "Invalid ID" }, { status: 400 });
  }

  let body: LinkBody;
  try {
    const parsed: unknown = await request.json();
    // `null`, a number or a string is valid JSON but not a request body.
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed as LinkBody;
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.outTransactionId !== "number") {
    return Response.json({ success: false, error: "outTransactionId is required" }, { status: 400 });
  }

  const outTransactionId = body.outTransactionId;
  const parsedAmount = parseOptionalAmount(body.amountForOutLeg);
  if (!parsedAmount.ok) {
    return Response.json({ success: false, error: "amountForOutLeg must be a positive number" }, { status: 400 });
  }
  // Owner ruling 2026-10-06: this route ends in a whole-ledger recompute. An
  // unacknowledged request is REHEARSED (run, then rolled back) so every
  // validation error surfaces first; a clean rehearsal is answered with the
  // confirm prompt and nothing is written.
  const acknowledged = isLedgerRecomputeAcknowledged(body);
  try {
    applyOrRehearse(db, acknowledged, () => {
      linkDonationLegs(db, {
        donationId,
        outTransactionId,
        artifactTransactionId: body.artifactTransactionId ?? null,
        amountForOutLeg: parsedAmount.value,
      });
    });
  } catch (error) {
    if (error instanceof DonationLinkError || error instanceof DonationIdentityConflictError) {
      return Response.json({ success: false, error: error.message }, { status: 400 });
    }
    if (isUniqueConstraintError(error)) {
      return Response.json(
        { success: false, error: `donation ${donationId}: already linked — unlink first` },
        { status: 409 }
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  }

  if (!acknowledged) return ledgerRecomputeRefusal(db, { bumpsTaxGeneration: true });

  const recompute = recomputeAfterDonationMutation(db);
  return Response.json({ success: true, data: { saved: true, ...recompute } });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const donationId = parseId(id);
  if (donationId == null) {
    return Response.json({ success: false, error: "Invalid ID" }, { status: 400 });
  }

  // unlinkDonationLegs is a silent no-op for an unknown id; without this the
  // user would be asked to confirm a recompute for a donation that is not there.
  if (!donationExists(db, donationId)) {
    return Response.json({ success: false, error: `donation ${donationId}: not found` }, { status: 400 });
  }

  // A DELETE carries the acknowledgement in a JSON body like the POSTs do. A
  // missing, empty or unparseable body is simply "not acknowledged".
  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
  // Owner ruling 2026-10-06: this route ends in a whole-ledger recompute. An
  // unacknowledged request is REHEARSED (run, then rolled back) so every
  // validation error surfaces first; a clean rehearsal is answered with the
  // confirm prompt and nothing is written.
  const acknowledged = isLedgerRecomputeAcknowledged(body);
  try {
    applyOrRehearse(db, acknowledged, () => {
      unlinkDonationLegs(db, donationId);
    });
  } catch (error) {
    if (error instanceof DonationLinkError || error instanceof DonationIdentityConflictError) {
      return Response.json({ success: false, error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  }

  if (!acknowledged) return ledgerRecomputeRefusal(db, { bumpsTaxGeneration: true });

  const recompute = recomputeAfterDonationMutation(db);
  return Response.json({ success: true, data: { saved: true, ...recompute } });
}
