import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import {
  sendEveningEmail,
  EveningSendError,
} from "@/lib/digest/send-evening";
import { checkCloudMarker } from "@/lib/cron/marker-check";
import {
  setRunningMarker,
  clearRunningMarker,
  confirmMacSent,
} from "@/lib/cron/running-marker";

export const dynamic = "force-dynamic";

/**
 * POST /api/cron/evening — Cron-authenticated evening recap trigger.
 *
 * Auth: X-Cron-Secret header must match CRON_SHARED_SECRET env var.
 * Body: { recipient?, footerNote? }.
 *
 * Called by the Cloudflare Worker's primary path for the weekday evening run,
 * and by the local launchd wrapper scripts/send-evening-digest.sh.
 * Pre-checks the Worker's "cloud-sent-evening-*" KV marker to avoid
 * re-delivering after a cloud fallback already fired.
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
  // don't regenerate. Gracefully no-ops when WORKER_MARKER_URL is unset.
  const marker = await checkCloudMarker("evening");
  if (marker?.sentBy === "cloud") {
    return Response.json({
      success: true,
      skipped: true,
      reason: "already_sent_by_cloud",
      date: marker.date,
    });
  }

  // Signal to Worker that we're starting — fallback path will skip while
  // this marker is set. Fire-and-forget; never block delivery on Worker RTT.
  void setRunningMarker("evening").catch((err) => {
    console.warn("[cron/evening] setRunningMarker failed:", err);
  });

  try {
    const result = await sendEveningEmail(db, {
      recipient: body.recipient as string | undefined,
      footerNote: body.footerNote as string | undefined,
    });
    // Tell the Worker we shipped tonight's evening recap so its catch-up
    // retry sweep won't double-send. Only when an email actually went out.
    if (result && (result as { success?: boolean }).success && !(result as { skipped?: boolean }).skipped) {
      void confirmMacSent("evening").catch((err) => {
        console.warn("[cron/evening] confirmMacSent failed:", err);
      });
    }
    return Response.json(result);
  } catch (err) {
    if (err instanceof EveningSendError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[cron/evening] Error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  } finally {
    // Always clear, even on error — leaving the marker set would block
    // subsequent retries. Auto-expires after 10min if this clear fails.
    void clearRunningMarker("evening").catch((err) => {
      console.warn("[cron/evening] clearRunningMarker failed:", err);
    });
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return timingSafeEqual(ab, bb);
}
