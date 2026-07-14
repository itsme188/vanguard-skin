import { timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";
import {
  sendBriefingEmail,
  BriefingSendError,
} from "@/lib/digest/send-briefing";
import { checkCloudMarker } from "@/lib/cron/marker-check";
import {
  setRunningMarker,
  clearRunningMarker,
  confirmMacSent,
} from "@/lib/cron/running-marker";
import { tryAcquireSendLock, releaseSendLock } from "@/lib/cron/send-mutex";
import { shouldSendBriefingToday } from "@/lib/calendar/market-holidays";
import { todayET } from "@/lib/calendar/date-utils";

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

  // Holiday-shift gate (automated path only). The launchd wrapper fires this
  // route on BOTH Sunday AND Monday at 15:00 ET; shouldSendBriefingToday picks
  // the right day: normally Sunday, but deferred to Monday when the upcoming
  // Monday is a market holiday (so the week-ahead covers the real trading week).
  // An explicit weekOf/force (manual trigger) bypasses the gate.
  if (!body.force && !body.weekOf) {
    const etToday = todayET();
    if (!shouldSendBriefingToday(etToday)) {
      console.log(`[cron/briefing] ${etToday} is not the briefing send-day (holiday shift) — skipping.`);
      return Response.json({ success: true, skipped: true, reason: "not_briefing_day", date: etToday });
    }
  }

  // In-process mutex — a launchd curl retry (or the Worker's primary call)
  // landing while an earlier request's pipeline is still running must not
  // start a second concurrent send. Acquired BEFORE the marker check so two
  // near-simultaneous entries can't both pass during the marker RTT.
  // (2026-07-12: three curl attempts each outlived --max-time and all three
  // pipelines sent — Sunday briefing ×3.)
  if (!tryAcquireSendLock("briefing")) {
    return Response.json({
      success: true,
      skipped: true,
      reason: "send already in progress",
    });
  }

  try {
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
    // A mac-sent marker means THIS Mac already shipped today's briefing (a
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

    // Signal to Worker that we're starting — fallback path will skip while
    // this marker is set. Fire-and-forget; never block delivery on Worker RTT.
    void setRunningMarker("briefing");

    const result = await sendBriefingEmail(db, {
      weekOf: body.weekOf as string | undefined,
      recipient: body.to as string | undefined,
      force: body.force === true,
    });
    // Tell the Worker we actually shipped a briefing today, so its catch-up
    // retry sweep won't fire a duplicate. Skip the confirmation when the
    // route short-circuited (e.g. cloud already sent, or no content) — both
    // paths set skipped:true.
    if (result && (result as { success?: boolean }).success && !(result as { skipped?: boolean }).skipped) {
      void confirmMacSent("briefing");
    }
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
  } finally {
    releaseSendLock("briefing");
    void clearRunningMarker("briefing");
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return timingSafeEqual(ab, bb);
}
