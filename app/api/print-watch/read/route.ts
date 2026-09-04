import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getPrintByEventId } from "@/lib/print-watch/store";
import { buildFirstPassPrompt, buildDtoSync, fingerprintOf } from "@/lib/print-watch/first-pass-prompt";
import { claimRead } from "@/lib/print-watch/read-store";
import { runFirstPassRead } from "@/lib/print-watch/read";

export const dynamic = "force-dynamic";

/**
 * POST /api/print-watch/read — regenerate the first-pass read (spec §4.4
 * "regenerate allocates the next nonce"). Human route (session + CSRF +
 * Origin through the proxy; no route-policy entry). The claim happens INSIDE
 * the request so the response can name the row; the model call continues
 * detached (plan M-D13) under that same claim, and the panel polls GET /status.
 */
export async function POST(request: NextRequest) {
  let body: { eventId?: unknown };
  try { body = (await request.json()) as { eventId?: unknown }; } catch { return NextResponse.json({ success: false, error: "Body must be JSON" }, { status: 400 }); }
  if (typeof body.eventId !== "number" || !Number.isInteger(body.eventId)) return NextResponse.json({ success: false, error: "eventId (integer) is required" }, { status: 400 });
  const print = getPrintByEventId(db, body.eventId);
  if (!print) return NextResponse.json({ success: false, error: "No print-watch row for that event" }, { status: 404 });
  try {
    const built = await buildFirstPassPrompt(db, print.id);
    if (!built) return NextResponse.json({ success: true, data: { readId: null, nonce: null, status: "no_facts" } });
    const claim = claimRead(db, print.id, {
      fingerprint: built.fingerprint,
      recompute: () => { const r = buildDtoSync(db, print.id, built.texts, built.dto.model_id); return r ? fingerprintOf(r.dto) : null; },
      nowMs: Date.now(), modelId: built.dto.model_id, regenerate: true,
    });
    if (claim.kind !== "claimed") return NextResponse.json({ success: false, error: `read not claimable: ${claim.kind}` }, { status: 409 });
    void runFirstPassRead(db, print.id, { existingClaim: { readId: claim.row.id, token: claim.token, fingerprint: built.fingerprint } })
      .catch(() => console.warn(`[print-watch] regenerate read ${claim.row.id} for print ${print.id} failed`));
    return NextResponse.json({ success: true, data: { readId: claim.row.id, nonce: claim.row.nonce, status: "generating" } });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
