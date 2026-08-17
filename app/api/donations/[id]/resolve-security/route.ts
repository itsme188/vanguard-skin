import { db } from "@/lib/db";
import {
  resolveDonationSecurity,
  DonationResolveError,
  DonationAlreadyResolvedError,
} from "@/lib/mutations/donations";
import { recomputeAfterDonationMutation } from "@/lib/compute/donation-recompute";

/**
 * POST /api/donations/:id/resolve-security — one-time symbol resolution for
 * a donation whose import-time symbol_raw didn't match a known security.
 * Only fires when donations.security_id is currently NULL (else 409); the
 * target security must exist and be USD-denominated (else 400) — leg
 * linking/lot assignment both require USD. Thin wrapper: all invariants
 * live in lib/mutations/donations.ts.
 *
 * Body: { securityId: number }.
 */

function parseId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? null : id;
}

interface ResolveBody {
  securityId?: number;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const donationId = parseId(id);
  if (donationId == null) {
    return Response.json({ success: false, error: "Invalid ID" }, { status: 400 });
  }

  let body: ResolveBody;
  try {
    body = (await request.json()) as ResolveBody;
  } catch {
    return Response.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.securityId !== "number") {
    return Response.json({ success: false, error: "securityId is required" }, { status: 400 });
  }

  try {
    resolveDonationSecurity(db, donationId, body.securityId);
  } catch (error) {
    if (error instanceof DonationAlreadyResolvedError) {
      return Response.json({ success: false, error: error.message }, { status: 409 });
    }
    if (error instanceof DonationResolveError) {
      return Response.json({ success: false, error: error.message }, { status: 400 });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json({ success: false, error: message }, { status: 500 });
  }

  const recompute = recomputeAfterDonationMutation(db);
  return Response.json({ success: true, data: { saved: true, ...recompute } });
}
