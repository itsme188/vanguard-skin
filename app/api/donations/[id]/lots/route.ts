import { db } from "@/lib/db";
import { assignDonationLots, DonationLinkError } from "@/lib/mutations/donation-links";
import { getOpenLotsForDonation, DonationLotsQueryError } from "@/lib/queries/giving-view";
import { recomputeAfterDonationMutation } from "@/lib/compute/donation-recompute";

/**
 * GET/POST /api/donations/:id/lots — the lot-assignment drawer (Task 13).
 * GET lists open lots AS OF the donation's OUT-leg date (see
 * getOpenLotsForDonation) with a suggested highest-gain-LT preselection.
 * POST replaces the donation's lot assignments (spec §4 invariants (a)-(f),
 * Task 3 assignDonationLots). Thin wrapper: all invariants live in
 * lib/mutations/donation-links.ts / lib/queries/giving-view.ts.
 *
 * POST body: { assignments: [{ acquisitionTransactionId, quantity }] }.
 * An empty array clears the donation's assignments.
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
    body = (await request.json()) as LotsBody;
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.assignments)) {
    return Response.json({ success: false, error: "assignments must be an array" }, { status: 400 });
  }

  try {
    assignDonationLots(db, donationId, body.assignments);
  } catch (error) {
    if (error instanceof DonationLinkError) {
      return Response.json({ success: false, error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  }

  const recompute = recomputeAfterDonationMutation(db);
  return Response.json({ success: true, data: { saved: true, ...recompute } });
}
