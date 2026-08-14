import { db } from "@/lib/db";
import { sendBriefingEmail } from "@/lib/digest/send-briefing";
import { checkCloudMarker } from "@/lib/cron/marker-check";
import { withRunningMarker } from "@/lib/cron/running-marker";
import { tryAcquireSendLock, releaseSendLock } from "@/lib/cron/send-mutex";
import { shouldSendBriefingToday } from "@/lib/calendar/market-holidays";
import { todayET } from "@/lib/calendar/date-utils";
import { withCronAuth } from "@/lib/cron/wrappers";

/**
 * POST /api/cron/briefing — Cron-authenticated weekly briefing trigger.
 *
 * Auth: X-Cron-Secret header must match CRON_SHARED_SECRET env var
 * (withCronAuth).
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
  return withCronAuth(request, async () => {
    const body = await request.json().catch(() => ({}));

    // Holiday-shift gate (automated path only). The launchd wrapper fires this
    // route on BOTH Sunday AND Monday at 15:00 ET; shouldSendBriefingToday picks
    // the right day: normally Sunday, but deferred to Monday when the upcoming
    // Monday is a market holiday (so the week-ahead covers the real trading week).
    // An explicit weekOf/force (manual trigger) bypasses the gate.
    if (!body.force && !body.weekOf) {
      const etToday = todayET();
      if (!shouldSendBriefingToday(etToday)) {
        console.log(`[cron/briefing] ${etToday} is not the briefing send-day (holiday shift) — skipping.`);
        return { success: true, skipped: true, reason: "not_briefing_day", date: etToday };
      }
    }

    // In-process mutex — a launchd curl retry (or the Worker's primary call)
    // landing while an earlier request's pipeline is still running must not
    // start a second concurrent send. Acquired BEFORE the marker check so two
    // near-simultaneous entries can't both pass during the marker RTT.
    // (2026-07-12: three curl attempts each outlived --max-time and all three
    // pipelines sent — Sunday briefing ×3.)
    if (!tryAcquireSendLock("briefing")) {
      return {
        success: true,
        skipped: true,
        reason: "send already in progress",
      };
    }

    try {
      // Worker-side dedup: if the cloud fallback already delivered today's email,
      // don't regenerate. Opt-in — returns null when WORKER_MARKER_URL is unset.
      const marker = await checkCloudMarker("briefing");
      if (marker?.sentBy === "cloud") {
        return {
          success: true,
          skipped: true,
          reason: "cloud already sent",
          date: marker.date,
        };
      }
      // A mac-sent marker means THIS Mac already shipped today's briefing (a
      // retried launchd tick after a slow-but-successful earlier run). Skip
      // unless the caller explicitly forces a resend.
      if (marker?.sentBy === "mac" && body.force !== true) {
        return {
          success: true,
          skipped: true,
          reason: "mac already sent",
          date: marker.date,
        };
      }

      // Hold `mac-running-briefing` for the WHOLE pipeline — awaited initial set
      // plus a 2-min heartbeat — so the Worker's fallback skips while we work.
      // The briefing is the longest pipeline (13-17 min), which is exactly why
      // the old set-once-at-entry marker had always expired by 16:45.
      // confirmSent() runs inside the wrapper so mac-sent lands before
      // mac-running is released; if it never gets acked, the wrapper leaves
      // mac-running in place (TTL-expire) instead of clearing on a gap.
      return await withRunningMarker("briefing", async ({ confirmSent }) => {
        const sent = await sendBriefingEmail(db, {
          weekOf: body.weekOf as string | undefined,
          recipient: body.to as string | undefined,
          force: body.force === true,
        });
        // Tell the Worker we actually shipped a briefing today, so its catch-up
        // retry sweep won't fire a duplicate. Skip the confirmation when the
        // route short-circuited (e.g. cloud already sent, or no content) — both
        // paths set skipped:true.
        if (sent && (sent as { success?: boolean }).success && !(sent as { skipped?: boolean }).skipped) {
          await confirmSent();
        }
        return sent;
      });
      // A thrown BriefingSendError propagates through the finally below to
      // withCronAuth's own catch, which duck-types {status, message} and
      // maps it to err.status directly — no re-catch needed here. A
      // generic error propagates the same way and lands on withCronAuth's
      // 500 path.
    } finally {
      // withRunningMarker clears the marker in its own finally (even on error,
      // and skipping the clear entirely if confirmSent() was called but never
      // acked); the send lock is all that is left to release here.
      releaseSendLock("briefing");
    }
  });
}
