import { db } from "@/lib/db";
import {
  sendEarningsRecap,
  EarningsEmailError,
} from "@/lib/digest/send-earnings-email";
import { withCronAuth } from "@/lib/cron/wrappers";

export const dynamic = "force-dynamic";

/**
 * POST /api/cron/earnings-recap — Cron-authenticated earnings recap email.
 *
 * Auth: X-Cron-Secret header must match CRON_SHARED_SECRET env var.
 * Body: { eventId: number, to?: string, footerNote?: string }
 *
 * Called by scripts/sweep-earnings-emails.ts when the runner finds an event
 * with `enriched_at IS NOT NULL` (actual_value populated by the existing
 * post-release enrichment runner) and no recap audit row. Worker fallback
 * path is deferred to Phase 4.
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
      const result = await sendEarningsRecap(db, body.eventId, {
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
