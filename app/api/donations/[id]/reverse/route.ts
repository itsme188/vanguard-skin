import { db } from "@/lib/db";
import { markDonationReversed } from "@/lib/mutations/donations";
import { recomputeAfterDonationMutation } from "@/lib/compute/donation-recompute";

/**
 * POST /api/donations/:id/reverse — marks a donation reversed (spec §6,
 * Task 3 markDonationReversed): drops its leg links + lot assignments,
 * restores a demoted artifact leg's is_external_flow, stamps reversed_date.
 * Thin wrapper: the mutation is the single source of truth.
 *
 * Body: { reversedDate: "YYYY-MM-DD" } — strict format, 400 otherwise.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? null : id;
}

interface ReverseBody {
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
    body = (await request.json()) as ReverseBody;
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.reversedDate !== "string" || !DATE_RE.test(body.reversedDate)) {
    return Response.json({ success: false, error: "reversedDate must be YYYY-MM-DD" }, { status: 400 });
  }

  try {
    markDonationReversed(db, donationId, body.reversedDate);
  } catch (error) {
    // markDonationReversed's only throw path is "donation not found" — a
    // domain-shaped 400, not an opaque 500.
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 400 });
  }

  const recompute = recomputeAfterDonationMutation(db);
  return Response.json({ success: true, data: { saved: true, ...recompute } });
}
