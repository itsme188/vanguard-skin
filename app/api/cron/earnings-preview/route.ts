import { db } from "@/lib/db";
import {
  sendEarningsPreview,
  EarningsEmailError,
} from "@/lib/digest/send-earnings-email";
import { withCronAuth } from "@/lib/cron/wrappers";
import {
  checkEarningsCloudMarker,
  setEarningsRunningMarker,
  clearEarningsRunningMarker,
  writeMacSentEarningsMarker,
} from "@/lib/cron/earnings-marker-check";

export const dynamic = "force-dynamic";

/**
 * POST /api/cron/earnings-preview — Cron-authenticated earnings preview email.
 *
 * Auth: X-Cron-Secret header must match CRON_SHARED_SECRET env var.
 * Body: { eventId: number, to?: string, footerNote?: string }
 *
 * Phase-4 marker dance:
 *   1. Pre-check cloud-sent marker — if Worker fallback already delivered,
 *      skip our send (return {skipped:"cloud-already-sent"}).
 *   2. POST mac-running marker (fire-and-forget) so Worker won't fire fallback
 *      while we're mid-send.
 *   3. Compose + send. Composer writes audit row on success.
 *   4. POST mac-sent marker so Worker skips on next sweep tick.
 *   5. Always clear mac-running in finally.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    eventId?: number;
    to?: string;
    footerNote?: string;
  };

  return withCronAuth(request, async () => {
    if (typeof body.eventId !== "number" || !Number.isInteger(body.eventId)) {
      throw { status: 400, message: "eventId must be an integer" };
    }
    const eventId = body.eventId;

    const cloudMarker = await checkEarningsCloudMarker("preview", eventId);
    if (cloudMarker?.sentBy === "cloud") {
      return {
        success: true,
        skipped: true,
        reason: "cloud-already-sent",
        eventId,
        phase: "preview" as const,
      };
    }

    void setEarningsRunningMarker("preview", eventId);

    try {
      const result = await sendEarningsPreview(db, eventId, {
        recipient: body.to,
        footerNote: body.footerNote,
      });
      void writeMacSentEarningsMarker("preview", eventId);
      return result;
    } catch (err) {
      if (err instanceof EarningsEmailError) {
        throw { status: err.status, message: err.message };
      }
      throw err;
    } finally {
      void clearEarningsRunningMarker("preview", eventId);
    }
  });
}
