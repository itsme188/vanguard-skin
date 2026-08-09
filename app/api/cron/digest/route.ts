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
  reconcileRecentCloudSends,
} from "@/lib/cron/marker-check";
import {
  withRunningMarker,
  confirmMacSent,
} from "@/lib/cron/running-marker";
import { isMarketHoliday } from "@/lib/calendar/market-holidays";
import { todayET } from "@/lib/calendar/date-utils";
import { tryAcquireSendLock, releaseSendLock } from "@/lib/cron/send-mutex";

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

  // In-process mutex — a launchd curl retry landing while an earlier
  // request's pipeline is still running must not start a second concurrent
  // send. Acquired BEFORE the marker check so two near-simultaneous entries
  // can't both pass during the marker RTT. (2026-06-30 + 2026-07-01: two
  // et-gate ticks each outlived curl's --max-time and both sent.)
  if (!tryAcquireSendLock("digest")) {
    return Response.json({
      success: true,
      skipped: true,
      reason: "send already in progress",
    });
  }

  try {
    // On-wake reconcile: a Mac that slept through yesterday's window never ran
    // this route's cloud-skip branch, so last_digest_sent_at may still predate
    // cloud sends the reader already received. Advance it BEFORE composing —
    // otherwise today's Mac-won digest re-covers those days (2026-07-15).
    await reconcileRecentCloudSends(db);

    const marker = await checkCloudMarker("digest");
    if (marker?.sentBy === "cloud") {
      // Advance only on a CONFIRMED send — an in-flight attempt (via=
      // "attempting") may still fail, and advancing past its start would drop
      // the articles it never summarized. Skip either way; if the attempt
      // dies, the Worker's own catch-up sweep re-sends within the window.
      if (marker.via !== "attempting") {
        advanceDigestMarkerAfterCloudSend(db, marker.sentAt);
      }
      return Response.json({
        success: true,
        skipped: true,
        reason: "cloud already sent",
        date: marker.date,
      });
    }
    // A mac-sent marker means THIS Mac already shipped today's digest (a
    // retried launchd tick after a slow-but-successful earlier run). Skip
    // unless the caller explicitly forces a resend.
    if (marker?.sentBy === "mac" && body.force !== true) {
      return Response.json({
        success: true,
        skipped: true,
        reason: "mac already sent",
        date: marker.date,
      });
    }

    // Hold `mac-running-digest` for the WHOLE pipeline — awaited initial set
    // plus a 2-min heartbeat — so the Worker's fallback skips while we work.
    // confirmMacSent runs inside the wrapper so mac-sent lands before
    // mac-running is released and the handoff never has a gap.
    const result = await withRunningMarker("digest", async () => {
      const sent = await sendDigestEmail(db, {
        recipient: body.to as string | undefined,
        mode: body.mode as DigestMode | undefined,
        sinceDate: body.sinceDate as string | undefined,
      });
      // Tell the Worker we shipped today's digest so its catch-up retry sweep
      // won't double-send hours later. Only when the route actually sent — a
      // skipped:true response means no email left the building.
      if (sent && (sent as { success?: boolean }).success && !(sent as { skipped?: boolean }).skipped) {
        await confirmMacSent("digest");
      }
      return sent;
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
  } finally {
    // withRunningMarker clears the marker in its own finally (even on error);
    // the send lock is all that is left to release here.
    releaseSendLock("digest");
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return timingSafeEqual(ab, bb);
}
