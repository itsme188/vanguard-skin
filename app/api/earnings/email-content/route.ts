import { db } from "@/lib/db";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import {
  formatDateLong,
  renderHeadlineTable,
} from "@/lib/digest/send-earnings-email";
import { getEmailAudit } from "@/lib/queries/earnings-emails";
import type { CalendarEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/earnings/email-content?eventId=NN&phase=preview|recap
 *
 * Read-only. Returns the full rendered HTML of the sent earnings email so
 * the in-app viewer can iframe it. The scoreboard is rebuilt deterministically
 * from current calendar_events fields (consensus_estimate, actual_value,
 * reaction_snapshot) — that means the viewer reflects post-enrichment data
 * even when the email itself was sent before enrichment landed. The AI
 * prose comes verbatim from earnings_emails.ai_output_md.
 *
 * getEmailAudit already filters out live 'in_progress' claim rows (a claim
 * hasn't delivered anything — see the tri-state note in
 * lib/digest/send-earnings-email.ts), so those 404 the same as a missing row.
 * 'sent-by-cloud' rows DO come back but have ai_output_md = NULL (no local
 * prose copy) — the `sentBy` field tells the viewer to explain that instead
 * of rendering a silently near-empty email.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const eventIdRaw = url.searchParams.get("eventId");
  const phase = url.searchParams.get("phase");

  const eventId = eventIdRaw ? Number(eventIdRaw) : NaN;
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return Response.json(
      { error: "Query param 'eventId' must be a positive integer." },
      { status: 400 },
    );
  }
  if (phase !== "preview" && phase !== "recap") {
    return Response.json(
      { error: "Query param 'phase' must be 'preview' or 'recap'." },
      { status: 400 },
    );
  }

  const audit = getEmailAudit(db, eventId, phase);
  if (!audit) {
    return Response.json(
      { error: `No ${phase} email audit row for event ${eventId}.` },
      { status: 404 },
    );
  }

  const event = db
    .prepare(`SELECT * FROM calendar_events WHERE id = ?`)
    .get(eventId) as CalendarEvent | undefined;
  if (!event || !event.symbol) {
    return Response.json(
      { error: `Event ${eventId} not found or has no symbol.` },
      { status: 404 },
    );
  }

  const symbol = event.symbol.toUpperCase();
  const dateStr = formatDateLong(event.event_date);
  const releaseTimeStr = event.release_time ? ` ${event.release_time} ET` : "";
  const phaseLabel = phase === "preview" ? "Earnings Preview" : "Earnings Recap";
  const title = `${symbol} ${phaseLabel} — ${dateStr}${releaseTimeStr}`;

  const scoreboardMd = renderHeadlineTable(event, symbol, phase);
  const aiMarkdown = audit.ai_output_md ?? "";
  const fullMarkdown = `${scoreboardMd}\n\n${aiMarkdown}`;
  const fullHtml = briefingToHtml(fullMarkdown, title);

  return Response.json({
    title,
    sentAt: audit.sent_at,
    sentTo: audit.recipient,
    eventDate: event.event_date,
    symbol,
    phase,
    sentBy: audit.error === "sent-by-cloud" ? "cloud" : "local",
    fullHtml,
  });
}
