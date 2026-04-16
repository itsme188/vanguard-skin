import { db } from "@/lib/db";
import { getLastDigestSentAt, getLastBriefingSentAt } from "@/lib/digest/daily-digest";

/**
 * GET /api/digest/status — Get last-sent timestamps and default recipient.
 */
export async function GET() {
  return Response.json({
    lastDigestSentAt: getLastDigestSentAt(db),
    lastBriefingSentAt: getLastBriefingSentAt(db),
    defaultRecipient: process.env.BRIEFING_EMAIL_TO || null,
  });
}
