import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import {
  sendDigestEmail,
  DigestSendError,
  type DigestMode,
} from "@/lib/digest/send-digest";
import {
  checkCloudMarker,
  advanceDigestMarkerAfterCloudSend,
} from "@/lib/cron/marker-check";
import {
  setRunningMarker,
  clearRunningMarker,
  confirmMacSent,
} from "@/lib/cron/running-marker";
import { isMarketHoliday } from "@/lib/calendar/market-holidays";
import { todayET } from "@/lib/calendar/date-utils";

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

  // Market-holiday gate: no daily digest on full NYSE closures (markets shut →
  // no new trading-day context). Weekends are already excluded by the cron's
  // Mon-Fri schedule, so a weekday closure is the only case here. Logged (not
  // silent) per the cloud-silent-failure lessons.
  const etToday = todayET();
  if (isMarketHoliday(etToday)) {
    console.log(`[cron/digest] ${etToday} is a market holiday — skipping daily digest.`);
    return Response.json({ success: true, skipped: true, reason: "market_holiday", date: etToday });
  }

  const marker = await checkCloudMarker("digest");
  if (marker?.sentBy === "cloud") {
    advanceDigestMarkerAfterCloudSend(db, marker.sentAt);
    return Response.json({
      success: true,
      skipped: true,
      reason: "cloud already sent",
      date: marker.date,
    });
  }

  // Signal to Worker that we're starting — fallback path will skip while
  // this marker is set. Fire-and-forget; never block delivery on Worker RTT.
  void setRunningMarker("digest");

  try {
    const result = await sendDigestEmail(db, {
      recipient: body.to as string | undefined,
      mode: body.mode as DigestMode | undefined,
      sinceDate: body.sinceDate as string | undefined,
    });
    // Tell the Worker we shipped today's digest so its catch-up retry sweep
    // won't double-send hours later. Only when the route actually sent — a
    // skipped:true response means no email left the building.
    if (result && (result as { success?: boolean }).success && !(result as { skipped?: boolean }).skipped) {
      void confirmMacSent("digest");
    }
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
  } finally {
    // Always clear, even on error — leaving the marker set would block
    // subsequent retries. Auto-expires after 10min if this clear fails.
    void clearRunningMarker("digest");
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return timingSafeEqual(ab, bb);
}
