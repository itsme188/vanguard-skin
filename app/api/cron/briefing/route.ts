import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import {
  sendBriefingEmail,
  BriefingSendError,
} from "@/lib/digest/send-briefing";
import { checkCloudMarker } from "@/lib/cron/marker-check";

/**
 * POST /api/cron/briefing — Cron-authenticated weekly briefing trigger.
 *
 * Auth: X-Cron-Secret header must match CRON_SHARED_SECRET env var.
 * Body: same shape as /api/calendar/email — { weekOf?, to?, force? }.
 *
 * Called by the Cloudflare Worker's primary path. If the Mac is awake and
 * reachable, Worker hits this route; on success the Worker writes a
 * "mac-sent-briefing-YYYY-MM-DD" KV marker to suppress fallback execution.
 *
 * A future revision of this route will pre-check the Worker's "cloud-sent-*"
 * KV marker and return early if the cloud fallback already fired today.
 * (Session B/C — not yet wired.)
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

  // Worker-side dedup: if the cloud fallback already delivered today's email,
  // don't regenerate. Opt-in — returns null when WORKER_MARKER_URL is unset.
  const marker = await checkCloudMarker("briefing");
  if (marker?.sentBy === "cloud") {
    return Response.json({
      success: true,
      skipped: true,
      reason: "cloud already sent",
      date: marker.date,
    });
  }

  try {
    const result = await sendBriefingEmail(db, {
      weekOf: body.weekOf as string | undefined,
      recipient: body.to as string | undefined,
      force: body.force === true,
    });
    return Response.json(result);
  } catch (err) {
    if (err instanceof BriefingSendError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[cron/briefing] Error:", err);
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
