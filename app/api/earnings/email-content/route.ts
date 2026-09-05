import { db } from "@/lib/db";
import { briefingToHtml } from "@/lib/calendar/briefing-html";
import {
  formatDateLong,
  renderHeadlineTable,
  loadIntelView,
} from "@/lib/digest/send-earnings-email";
import { getEmailAudit } from "@/lib/queries/earnings-emails";
import { sendStateFor, sentByFor } from "@/lib/earnings/email-states";
import { withClusterManualActuals } from "@/lib/queries/manual-actuals-cluster";
import { parseDbTimestamp } from "@/lib/calendar/date-utils";
import { repairCitationLineBreaks } from "@/lib/earnings/repair-citation-linebreaks";
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
 * getEmailAudit already filters out LIVE CLAIM rows — both of them, the
 * claimed-and-composing one and the provider-call-in-flight one (a claim
 * hasn't delivered anything; see lib/earnings/email-states.ts) — so those 404
 * the same as a missing row.
 *
 * `deliveryState` reports which of three things the caller is looking at:
 * "sent" (delivered locally, or a legacy row the sweep left behind),
 * "sent-by-cloud" (the Worker delivered it — ai_output_md is NULL, no local
 * prose copy, so the viewer explains that instead of rendering a silently
 * near-empty email), or "delivery-unknown" (we put a message on the wire and
 * never learned the outcome — the prose IS here and IS shown, with the
 * caveat). `sentBy` stays for its existing callers.
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

  // Cluster-scoped acceptance stamp: the scoreboard below runs the
  // plausibility gate, and the stamp can sit on a superseded twin of this
  // same print (lib/queries/manual-actuals-cluster.ts).
  const event = withClusterManualActuals(
    db,
    db.prepare(`SELECT * FROM calendar_events WHERE id = ?`).get(eventId) as
      | CalendarEvent
      | undefined,
  );
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

  // Load the same earnings-intel view the sent email used (best-effort —
  // a viewer-route failure here shouldn't 500 the whole modal) so the
  // in-app viewer's scoreboard matches what was actually sent. Threaded
  // for BOTH phases: preview shows implied-move + history rows, recap
  // echoes implied-vs-realized off the same cache.
  let intelView: ReturnType<typeof loadIntelView> | null = null;
  try {
    intelView = loadIntelView(db, event.id, symbol);
  } catch (err) {
    console.warn(`[earnings-intel] loadIntelView failed for event ${eventId} (${symbol}):`, err);
  }

  const scoreboardMd = renderHeadlineTable(event, symbol, phase, intelView);
  // Display-time repair only (never at send/compose time) for pre-fix rows
  // whose stored prose has citation-split bare-newline fragments — see
  // lib/earnings/repair-citation-linebreaks.ts.
  const aiMarkdown = repairCitationLineBreaks(audit.ai_output_md ?? "");
  const fullMarkdown = `${scoreboardMd}\n\n${aiMarkdown}`;
  // Stamp the footer with when the email was actually sent, not when this
  // archive re-render happens (falls back to render time if unparseable).
  const sentDate = audit.sent_at ? parseDbTimestamp(audit.sent_at) : null;
  const fullHtml = briefingToHtml(fullMarkdown, title, undefined, sentDate ?? undefined);

  return Response.json({
    title,
    sentAt: audit.sent_at,
    sentTo: audit.recipient,
    eventDate: event.event_date,
    symbol,
    phase,
    sentBy: sentByFor(audit.error),
    // Slice E (R-E14 / E-S6): `sentBy` alone cannot express "we never learned",
    // and it answers "local" for a delivery_unknown row — true (we made the
    // call) but misleading on its own, so the delivery state ALWAYS travels
    // with it and the viewer can show the caveat banner.
    //
    // E-S9: during a manual refire's `sending` window this route still returns
    // the PREVIOUSLY DELIVERED body — a refire writes its new prose only at
    // markEmailSent (M-E13), precisely so a failed refire cannot destroy the
    // delivered copy. That is correct and intended; `deliveryState` is what
    // tells the reader which body they are looking at.
    deliveryState: sendStateFor(audit.error),
    fullHtml,
  });
}
