import { db } from "@/lib/db";
import { assignDonationLots, DonationLinkError } from "@/lib/mutations/donation-links";
import { getOpenLotsForDonation, DonationLotsQueryError } from "@/lib/queries/giving-view";
import {
  applyOrRehearse,
  isLedgerRecomputeAcknowledged,
  ledgerRecomputeRefusal,
  recomputeAfterDonationMutation,
} from "@/lib/compute/donation-recompute";

/**
 * GET/POST /api/donations/:id/lots — the lot-assignment drawer (Task 13).
 * GET lists open lots AS OF the donation's OUT-leg date (see
 * getOpenLotsForDonation) with a suggested highest-gain-LT preselection AND
 * this donation's own current per-lot assignment (currentlyAssignedQuantity,
 * controller ruling 2026-08-17) so the drawer can pre-fill "Edit lots"
 * instead of always starting blank. POST replaces the donation's lot
 * assignments (spec §4 invariants (a)-(f), Task 3 assignDonationLots). Thin
 * wrapper: all invariants live in lib/mutations/donation-links.ts /
 * lib/queries/giving-view.ts.
 *
 * POST body: { assignments: [{ acquisitionTransactionId, quantity }],
 * acknowledgeLedgerRecompute: true }. An empty array clears the donation's
 * assignments. Without the acknowledgement the POST is refused with 409
 * `ledger_recompute_unacknowledged` and a census of the ledger (see
 * lib/compute/donation-recompute-contract.ts); nothing is written.
 */

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? null : id;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const donationId = parseId(id);
  if (donationId == null) {
    return Response.json({ success: false, error: "Invalid ID" }, { status: 400 });
  }

  try {
    const lots = getOpenLotsForDonation(db, donationId);
    return Response.json({ success: true, data: { lots } });
  } catch (error) {
    if (error instanceof DonationLotsQueryError) {
      return Response.json({ success: false, error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
}

interface LotsBody {
  acknowledgeLedgerRecompute?: boolean;
  assignments?: { acquisitionTransactionId: number; quantity: number }[];
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const donationId = parseId(id);
  if (donationId == null) {
    return Response.json({ success: false, error: "Invalid ID" }, { status: 400 });
  }

  let body: LotsBody;
  try {
    const parsed: unknown = await request.json();
    // `null`, a number or a string is valid JSON but not a request body.
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed as LotsBody;
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.assignments)) {
    return Response.json({ success: false, error: "assignments must be an array" }, { status: 400 });
  }

  const assignments = body.assignments;
  // Owner ruling 2026-10-06: this route ends in a whole-ledger recompute. An
  // unacknowledged request is REHEARSED (run, then rolled back) so every
  // validation error surfaces first; a clean rehearsal is answered with the
  // confirm prompt and nothing is written.
  const acknowledged = isLedgerRecomputeAcknowledged(body);
  try {
    applyOrRehearse(db, acknowledged, () => {
      assignDonationLots(db, donationId, assignments);
    });
  } catch (error) {
    if (error instanceof DonationLinkError) {
      return Response.json({ success: false, error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  }

  if (!acknowledged) return ledgerRecomputeRefusal(db, { bumpsTaxGeneration: true });

  const recompute = recomputeAfterDonationMutation(db);
  return Response.json({ success: true, data: { saved: true, ...recompute } });
}
