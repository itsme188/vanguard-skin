import { db } from "@/lib/db";
import { markDonationReversed } from "@/lib/mutations/donations";
import {
  applyOrRehearse,
  isLedgerRecomputeAcknowledged,
  ledgerRecomputeRefusal,
  recomputeAfterDonationMutation,
} from "@/lib/compute/donation-recompute";

/**
 * POST /api/donations/:id/reverse — marks a donation reversed (spec §6,
 * Task 3 markDonationReversed): drops its leg links + lot assignments,
 * restores a demoted artifact leg's is_external_flow, stamps reversed_date.
 * Thin wrapper: the mutation is the single source of truth.
 *
 * Body: { reversedDate: "YYYY-MM-DD", acknowledgeLedgerRecompute: true } —
 * strict date format, 400 otherwise. Without the acknowledgement the POST is
 * refused with 409 `ledger_recompute_unacknowledged` and a census of the
 * ledger (lib/compute/donation-recompute-contract.ts); nothing is written.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? null : id;
}

interface ReverseBody {
  acknowledgeLedgerRecompute?: boolean;
  reversedDate?: string;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const donationId = parseId(id);
  if (donationId == null) {
    return Response.json({ success: false, error: "Invalid ID" }, { status: 400 });
  }

  let body: ReverseBody;
  try {
    const parsed: unknown = await request.json();
    // `null`, a number or a string is valid JSON but not a request body.
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }
    body = parsed as ReverseBody;
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.reversedDate !== "string" || !DATE_RE.test(body.reversedDate)) {
    return Response.json({ success: false, error: "reversedDate must be YYYY-MM-DD" }, { status: 400 });
  }

  const reversedDate = body.reversedDate;
  // Owner ruling 2026-10-06: this route ends in a whole-ledger recompute. An
  // unacknowledged request is REHEARSED (run, then rolled back) so every
  // validation error surfaces first; a clean rehearsal is answered with the
  // confirm prompt and nothing is written.
  const acknowledged = isLedgerRecomputeAcknowledged(body);
  try {
    applyOrRehearse(db, acknowledged, () => {
      markDonationReversed(db, donationId, reversedDate);
    });
  } catch (error) {
    // markDonationReversed's only throw path is "donation not found" — a
    // domain-shaped 400, not an opaque 500.
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 400 });
  }

  if (!acknowledged) return ledgerRecomputeRefusal(db, { bumpsTaxGeneration: true });

  const recompute = recomputeAfterDonationMutation(db);
  return Response.json({ success: true, data: { saved: true, ...recompute } });
}
