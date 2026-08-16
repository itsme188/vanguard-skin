import { db } from "@/lib/db";
import {
  sendBriefingEmail,
  BriefingSendError,
} from "@/lib/digest/send-briefing";
import {
  checkRecipientAllowed,
  checkEmailSendRateLimit,
} from "@/lib/email/recipient-guard";

/**
 * POST /api/calendar/email — Generate (if needed) and email the weekly briefing.
 *
 * Body: { weekOf?: string, to?: string, force?: boolean, override?: boolean }
 *   - weekOf: YYYY-MM-DD (Monday of week). Defaults to current week's Monday.
 *   - to: recipient email. Defaults to BRIEFING_EMAIL_TO env var. Must be in
 *     the configured allowlist (BRIEFING_EMAIL_TO / settings
 *     briefing_email_recipients) unless `override: true` is also passed
 *     (#35 §G).
 *   - force: regenerate briefing even if cached.
 *
 * Requires env vars: GMAIL_ADDRESS, GMAIL_APP_PASSWORD, BRIEFING_EMAIL_TO (default recipient).
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));

  const recipientCheck = checkRecipientAllowed(
    db,
    "briefing",
    body.to as string | undefined,
    body.override === true,
  );
  if (!recipientCheck.ok) {
    return Response.json({ error: recipientCheck.error }, { status: recipientCheck.status });
  }
  const rateCheck = checkEmailSendRateLimit("calendar");
  if (!rateCheck.ok) {
    return Response.json({ error: rateCheck.error }, { status: rateCheck.status });
  }

  try {
    const result = await sendBriefingEmail(db, {
      weekOf: body.weekOf as string | undefined,
      recipient: body.to as string | undefined,
      force: body.force === true,
    });
    return Response.json(result);
  } catch (err) {
    if (err instanceof BriefingSendError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[calendar/email] Error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
