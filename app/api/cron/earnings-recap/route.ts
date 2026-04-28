import { db } from "@/lib/db";
import {
  sendEarningsRecap,
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
 * POST /api/cron/earnings-recap — Cron-authenticated earnings recap email.
 *
 * Auth + Phase-4 marker dance identical to /api/cron/earnings-preview:
 *   1. Pre-check cloud-sent marker; skip if Worker fallback already fired.
 *   2. Set mac-running marker.
 *   3. Compose + send via composer (writes audit row).
 *   4. Set mac-sent marker.
 *   5. Clear mac-running in finally.
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

    const cloudMarker = await checkEarningsCloudMarker("recap", eventId);
    if (cloudMarker?.sentBy === "cloud") {
      return {
        success: true,
        skipped: true,
        reason: "cloud-already-sent",
        eventId,
        phase: "recap" as const,
      };
    }

    void setEarningsRunningMarker("recap", eventId);

    try {
      const result = await sendEarningsRecap(db, eventId, {
        recipient: body.to,
        footerNote: body.footerNote,
      });
      void writeMacSentEarningsMarker("recap", eventId);
      return result;
    } catch (err) {
      if (err instanceof EarningsEmailError) {
        throw { status: err.status, message: err.message };
      }
      throw err;
    } finally {
      void clearEarningsRunningMarker("recap", eventId);
    }
  });
}
