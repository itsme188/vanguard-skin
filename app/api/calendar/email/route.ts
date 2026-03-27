import { db } from "@/lib/db";
import { getBriefingByWeek } from "@/lib/queries/calendar";
import { generateWeeklyBriefing } from "@/lib/calendar/briefing";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import { sendEmail } from "@/lib/email";

/**
 * POST /api/calendar/email — Generate (if needed) and email the weekly briefing.
 *
 * Body: { weekOf?: string, to?: string }
 *   - weekOf: YYYY-MM-DD (Monday of week). Defaults to current week's Monday.
 *   - to: recipient email. Defaults to BRIEFING_EMAIL_TO env var.
 *
 * Requires env vars: GMAIL_ADDRESS, GMAIL_APP_PASSWORD, BRIEFING_EMAIL_TO (default recipient).
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));

  // Determine week
  const weekOf = (body.weekOf as string) || getCurrentMonday();
  const recipient = (body.to as string) || process.env.BRIEFING_EMAIL_TO;

  if (!recipient) {
    return Response.json(
      { error: "No recipient. Set BRIEFING_EMAIL_TO env var or pass 'to' in body." },
      { status: 400 }
    );
  }

  const gmailAddress = process.env.GMAIL_ADDRESS;
  const gmailAppPassword = process.env.GMAIL_APP_PASSWORD;

  if (!gmailAddress || !gmailAppPassword) {
    return Response.json(
      { error: "Missing GMAIL_ADDRESS or GMAIL_APP_PASSWORD env vars." },
      { status: 500 }
    );
  }

  try {
    // Get or generate briefing
    let briefing = getBriefingByWeek(db, weekOf);
    let generated = false;

    if (!briefing || !briefing.content) {
      const result = await generateWeeklyBriefing(db, weekOf);
      briefing = getBriefingByWeek(db, weekOf);
      generated = true;

      if (!briefing || result.eventCount === 0) {
        return Response.json(
          { error: "No events found for this week. Run a calendar sync first.", weekOf },
          { status: 404 }
        );
      }
    }

    // Convert markdown to styled HTML email
    const title = briefing.title || `Week of ${weekOf}`;
    const html = briefingToHtml(briefing.content, title);

    // Send email
    await sendEmail(
      { gmailAddress, gmailAppPassword },
      recipient,
      `📊 ${title} — Weekly Portfolio Briefing`,
      html
    );

    return Response.json({
      success: true,
      weekOf,
      sentTo: recipient,
      generated,
      eventCount: briefing.event_count,
    });
  } catch (err) {
    console.error("[calendar/email] Error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// ── Helpers ──────────────────────────────────────────────────────

function getCurrentMonday(): string {
  const now = new Date();
  const day = now.getDay();
  // Sunday = 0, Monday = 1, ..., Saturday = 6
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diff);
  return monday.toISOString().slice(0, 10);
}
