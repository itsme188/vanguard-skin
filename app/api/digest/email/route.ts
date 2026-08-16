import { db } from "@/lib/db";
import {
  sendDigestEmail,
  DigestSendError,
  type DigestMode,
} from "@/lib/digest/send-digest";
import {
  checkRecipientAllowed,
  checkEmailSendRateLimit,
} from "@/lib/email/recipient-guard";

/**
 * POST /api/digest/email — Sync research feeds, generate daily digest, and email it.
 *
 * Body: { to?: string, mode?: "today" | "since_last" | "since_date", sinceDate?: string, skipMarkerUpdate?: boolean, override?: boolean }
 *   - to: recipient email(s), comma-separated. Defaults to BRIEFING_EMAIL_TO env var.
 *     Must be in the configured allowlist (BRIEFING_EMAIL_TO / settings
 *     digest_email_recipients) unless `override: true` is also passed (#35 §G).
 *   - mode: date range mode. Default (omitted) = last 24 hours (backward-compatible with cron).
 *   - sinceDate: YYYY-MM-DD for "since_date" mode.
 *   - skipMarkerUpdate: when true, don't write `last_digest_sent_at` after sending.
 *     Used by the DigestCatchup banner so an in-flight cron isn't poisoned by
 *     the catch-up's "now" timestamp.
 *
 * Flow: sync Gmail → AI-process articles → compile digest → send email.
 * Skips gracefully if no articles in the selected range.
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));

  const recipientCheck = checkRecipientAllowed(
    db,
    "digest",
    body.to as string | undefined,
    body.override === true,
  );
  if (!recipientCheck.ok) {
    return Response.json({ error: recipientCheck.error }, { status: recipientCheck.status });
  }
  const rateCheck = checkEmailSendRateLimit("digest");
  if (!rateCheck.ok) {
    return Response.json({ error: rateCheck.error }, { status: rateCheck.status });
  }

  try {
    const result = await sendDigestEmail(db, {
      recipient: body.to as string | undefined,
      mode: body.mode as DigestMode | undefined,
      sinceDate: body.sinceDate as string | undefined,
      skipMarkerUpdate: body.skipMarkerUpdate === true,
    });
    return Response.json(result);
  } catch (err) {
    if (err instanceof DigestSendError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[digest/email] Error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}
