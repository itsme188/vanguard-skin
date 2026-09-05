import { db } from "@/lib/db";
import { EarningsEmailError } from "@/lib/digest/send-earnings-email";
// Slice E: the two manual entry points moved to the canonical send service
// (lib/earnings/send-service.ts) — the error class stays where it is defined.
import { sendEarningsPreview, sendEarningsRecap } from "@/lib/earnings/send-service";
import { markEmailDeliveredByHand } from "@/lib/mutations/earnings-emails";
import {
  checkRecipientAllowed,
  checkEmailSendRateLimit,
} from "@/lib/email/recipient-guard";

export const dynamic = "force-dynamic";

/**
 * POST /api/earnings/email — Manual trigger for earnings preview / recap email.
 *
 * Body: { eventId: number, phase: "preview" | "recap", to?: string, footerNote?: string,
 *          override?: boolean, markDelivered?: boolean }
 *   - eventId: calendar_events.id of the earnings event.
 *   - phase: "preview" (~2h before) or "recap" (~2h after).
 *   - markDelivered: close a delivery-unknown row the desk confirmed by hand.
 *     Sends nothing; see the block below.
 *   - to: recipient email. Defaults to BRIEFING_EMAIL_TO env var. Must be in
 *     the configured allowlist (BRIEFING_EMAIL_TO) unless `override: true`
 *     is also passed (#35 §G).
 *   - footerNote: optional footer attribution.
 *
 * Localhost-only for Tier 1. Cron-authenticated routes will live at
 * /api/cron/earnings-{preview,recap} once Tier 3 wiring lands.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    eventId?: number;
    phase?: string;
    to?: string;
    footerNote?: string;
    override?: boolean;
    markDelivered?: boolean;
  };

  if (typeof body.eventId !== "number" || !Number.isInteger(body.eventId)) {
    return Response.json(
      { error: "Body field 'eventId' must be an integer." },
      { status: 400 },
    );
  }
  if (body.phase !== "preview" && body.phase !== "recap") {
    return Response.json(
      { error: "Body field 'phase' must be 'preview' or 'recap'." },
      { status: 400 },
    );
  }

  // Slice E (R-E14): close a delivery-unknown row the desk confirmed by hand.
  // No email is composed and none is sent, so this runs BEFORE the recipient
  // allowlist and the rate limit — there is no recipient to check and nothing
  // leaves the machine. A RESEND is the existing path: the same route without
  // this flag, which refires explicitly.
  if (body.markDelivered === true) {
    return markEmailDeliveredByHand(db, body.eventId, body.phase)
      ? Response.json({ ok: true, phase: body.phase, eventId: body.eventId, resolved: "delivered" })
      : Response.json(
          {
            error:
              `Event ${body.eventId} ${body.phase} is not in the delivery_unknown state — there is nothing to confirm.`,
          },
          { status: 409 },
        );
  }

  const recipientCheck = checkRecipientAllowed(db, "earnings", body.to, body.override === true);
  if (!recipientCheck.ok) {
    return Response.json({ error: recipientCheck.error }, { status: recipientCheck.status });
  }
  const rateCheck = checkEmailSendRateLimit("earnings");
  if (!rateCheck.ok) {
    return Response.json({ error: rateCheck.error }, { status: rateCheck.status });
  }

  try {
    const opts = {
      recipient: body.to,
      footerNote: body.footerNote,
    };
    const result = body.phase === "preview"
      ? await sendEarningsPreview(db, body.eventId, opts)
      : await sendEarningsRecap(db, body.eventId, opts);
    return Response.json(result);
  } catch (err) {
    if (err instanceof EarningsEmailError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[earnings/email] Error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
