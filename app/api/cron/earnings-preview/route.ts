import { db } from "@/lib/db";
import {
  sendEarningsPreview,
  EarningsEmailError,
} from "@/lib/digest/send-earnings-email";
import { withCronAuth } from "@/lib/cron/wrappers";

export const dynamic = "force-dynamic";

/**
 * POST /api/cron/earnings-preview — Cron-authenticated earnings preview email.
 *
 * Auth: X-Cron-Secret header must match CRON_SHARED_SECRET env var.
 * Body: { eventId: number, to?: string, footerNote?: string }
 *
 * Called by scripts/sweep-earnings-emails.ts when the runner finds an event
 * inside the [release-135min, release-105min] window with no preview audit
 * row. The composer writes the audit row on success — that prevents the
 * next 15-min tick from re-firing.
 *
 * Worker fallback path is deferred to Phase 4; until then the cron is
 * Mac-primary-only.
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
    try {
      const result = await sendEarningsPreview(db, body.eventId, {
        recipient: body.to,
        footerNote: body.footerNote,
      });
      return result;
    } catch (err) {
      if (err instanceof EarningsEmailError) {
        throw { status: err.status, message: err.message };
      }
      throw err;
    }
  });
}
