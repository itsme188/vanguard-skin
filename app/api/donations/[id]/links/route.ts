import { db } from "@/lib/db";
import { linkDonationLegs, unlinkDonationLegs, DonationLinkError } from "@/lib/mutations/donation-links";
import { DonationIdentityConflictError } from "@/lib/mutations/donations";
import { recomputeAfterDonationMutation } from "@/lib/compute/donation-recompute";

/**
 * POST/DELETE /api/donations/:id/links — confirm/undo the OUT (+ optional
 * routing-artifact) leg link for a stock donation (spec §7, Task 3
 * linkDonationLegs/unlinkDonationLegs). Thin wrapper: every invariant lives
 * in lib/mutations/donation-links.ts.
 *
 * POST body: { outTransactionId: number, artifactTransactionId?: number,
 * amountForOutLeg?: number }.
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

interface LinkBody {
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
    body = (await request.json()) as LinkBody;
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.outTransactionId !== "number") {
    return Response.json({ success: false, error: "outTransactionId is required" }, { status: 400 });
  }

  try {
    linkDonationLegs(db, {
      donationId,
      outTransactionId: body.outTransactionId,
      artifactTransactionId: body.artifactTransactionId ?? null,
      amountForOutLeg: body.amountForOutLeg ?? null,
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

  const recompute = recomputeAfterDonationMutation(db);
  return Response.json({ success: true, data: { saved: true, ...recompute } });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const donationId = parseId(id);
  if (donationId == null) {
    return Response.json({ success: false, error: "Invalid ID" }, { status: 400 });
  }

  try {
    unlinkDonationLegs(db, donationId);
  } catch (error) {
    if (error instanceof DonationLinkError || error instanceof DonationIdentityConflictError) {
      return Response.json({ success: false, error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  }

  const recompute = recomputeAfterDonationMutation(db);
  return Response.json({ success: true, data: { saved: true, ...recompute } });
}
