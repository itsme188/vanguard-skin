import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import {
  sendDigestEmail,
  DigestSendError,
  type DigestMode,
} from "@/lib/digest/send-digest";
import { checkCloudMarker } from "@/lib/cron/marker-check";

/**
 * POST /api/cron/digest — Cron-authenticated daily digest trigger.
 *
 * Auth: X-Cron-Secret header must match CRON_SHARED_SECRET env var.
 * Body: same shape as /api/digest/email — { to?, mode?, sinceDate? }.
 *
 * Called by the Cloudflare Worker's primary path for the weekday 9am run.
 */
export async function POST(request: Request) {
  const expected = process.env.CRON_SHARED_SECRET;
  if (!expected) {
    return Response.json(
      { error: "Server not configured: CRON_SHARED_SECRET missing." },
      { status: 500 }
    );
  }

  const provided = request.headers.get("x-cron-secret") ?? "";
  if (!constantTimeEqual(provided, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));

  const marker = await checkCloudMarker("digest");
  if (marker?.sentBy === "cloud") {
    return Response.json({
      success: true,
      skipped: true,
      reason: "cloud already sent",
      date: marker.date,
    });
  }

  try {
    const result = await sendDigestEmail(db, {
      recipient: body.to as string | undefined,
      mode: body.mode as DigestMode | undefined,
      sinceDate: body.sinceDate as string | undefined,
    });
    return Response.json(result);
  } catch (err) {
    if (err instanceof DigestSendError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[cron/digest] Error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return timingSafeEqual(ab, bb);
}
