import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { acceptCallout } from "@/lib/print-watch/read-store";
import { VERIFIER_VERSION } from "@/lib/print-watch/callouts";

export const dynamic = "force-dynamic";

const REASON_TEXT: Record<string, string> = {
  revoked: "This callout's document was withdrawn or re-gated — it can no longer be accepted",
  superseded: "A newer read replaced this callout — accept the current one",
  stale_verifier: "This callout was verified by an older verifier — regenerate the read first",
  changed: "The callout changed state while you clicked — refresh and try again",
};

/** POST /api/print-watch/callouts/accept — the per-callout accept control (spec §9 ruling 3; #12: one transaction inside acceptCallout). */
export async function POST(request: NextRequest) {
  let body: { calloutId?: unknown; accept?: unknown };
  try { body = (await request.json()) as typeof body; } catch { return NextResponse.json({ success: false, error: "Body must be JSON" }, { status: 400 }); }
  if (typeof body.calloutId !== "number" || typeof body.accept !== "boolean") return NextResponse.json({ success: false, error: "calloutId (number) and accept (boolean) are required" }, { status: 400 });
  const r = acceptCallout(db, body.calloutId, body.accept, { nowMs: Date.now(), verifierVersion: VERIFIER_VERSION });
  if (r.ok) return NextResponse.json({ success: true, data: { callout: r.callout } });
  if (r.reason === "not_found") return NextResponse.json({ success: false, error: "Unknown callout" }, { status: 404 });
  return NextResponse.json({ success: false, error: REASON_TEXT[r.reason] }, { status: 409 });
}
