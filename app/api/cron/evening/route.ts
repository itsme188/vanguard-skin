import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import {
  sendEveningEmail,
  EveningSendError,
} from "@/lib/digest/send-evening";
import {
  checkCloudMarker,
  advanceDigestMarkerAfterCloudSend,
  reconcileRecentCloudSends,
} from "@/lib/cron/marker-check";
import { withRunningMarker } from "@/lib/cron/running-marker";
import { isMarketHoliday } from "@/lib/calendar/market-holidays";
import { todayET } from "@/lib/calendar/date-utils";
import { tryAcquireSendLock, releaseSendLock } from "@/lib/cron/send-mutex";

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

  // Market-holiday gate: no evening recap on full NYSE closures. Logged, not silent.
  const etToday = todayET();
  if (isMarketHoliday(etToday)) {
    console.log(`[cron/evening] ${etToday} is a market holiday — skipping evening recap.`);
    return Response.json({ success: true, skipped: true, reason: "market_holiday", date: etToday });
  }

  // In-process mutex — a launchd curl retry landing while an earlier
  // request's pipeline is still running must not start a second concurrent
  // send. Acquired BEFORE the marker check so two near-simultaneous entries
  // can't both pass during the marker RTT. (Same failure family as the
  // 2026-07-12 briefing ×3 / 2026-06-30 digest ×2.)
  if (!tryAcquireSendLock("evening")) {
    return Response.json({
      success: true,
      skipped: true,
      reason: "send already in progress",
    });
  }

  try {
    // On-wake reconcile: advance last_digest_sent_at past any cloud sends the
    // Mac slept through (e.g. this morning's cloud digest) BEFORE composing,
    // so tonight's recap window starts where the reader's last email ended.
    await reconcileRecentCloudSends(db);

    // Worker-side dedup: if the cloud fallback already delivered today's email,
    // don't regenerate. Gracefully no-ops when WORKER_MARKER_URL is unset.
    const marker = await checkCloudMarker("evening");
    if (marker?.sentBy === "cloud") {
      // Confirmed sends only — an in-flight attempt (via="attempting") may
      // still fail; advancing from it would drop its window's articles.
      if (marker.via !== "attempting") {
        advanceDigestMarkerAfterCloudSend(db, marker.sentAt);
      }
      return Response.json({
        success: true,
        skipped: true,
        reason: "already_sent_by_cloud",
        date: marker.date,
      });
    }
    // A mac-sent marker means THIS Mac already shipped tonight's recap (a
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

    // Hold `mac-running-evening` for the WHOLE pipeline — awaited initial set
    // plus a 2-min heartbeat — so the Worker's fallback skips while we work.
    // confirmSent() runs inside the wrapper so mac-sent lands before
    // mac-running is released; if it never gets acked, the wrapper leaves
    // mac-running in place (TTL-expire) instead of clearing on a gap.
    const result = await withRunningMarker("evening", async ({ confirmSent }) => {
      const sent = await sendEveningEmail(db, {
        recipient: body.recipient as string | undefined,
        footerNote: body.footerNote as string | undefined,
      });
      // Tell the Worker we shipped tonight's evening recap so its catch-up
      // retry sweep won't double-send. Only when an email actually went out.
      if (sent && (sent as { success?: boolean }).success && !(sent as { skipped?: boolean }).skipped) {
        await confirmSent();
      }
      return sent;
    });
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
    // withRunningMarker clears the marker in its own finally (even on error,
    // and skipping the clear entirely if confirmSent() was called but never
    // acked); the send lock is all that is left to release here.
    releaseSendLock("evening");
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return timingSafeEqual(ab, bb);
}
