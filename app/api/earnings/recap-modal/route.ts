import { db } from "@/lib/db";
import { runEnrichment } from "@/lib/calendar/enrichment-runner";
import {
  composeEarningsEmail,
  EarningsEmailError,
} from "@/lib/digest/send-earnings-email";
import type { CalendarEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * POST /api/earnings/recap-modal — compose an earnings recap on demand and
 * return the rendered HTML for the in-app modal viewer.
 *
 * Body: { eventId: number, runEnrichmentFirst?: boolean }
 *   - eventId: calendar_events.id of the earnings event
 *   - runEnrichmentFirst: when true (default), run a single-event pass of
 *     the enrichment runner before composing — fetches actual_value from
 *     Finnhub + reaction_snapshot from Yahoo (TWS unavailable in this
 *     web-triggered path). Use false to skip if you already know the row
 *     is enriched.
 *
 * Returns:
 *   - 200 { success, html, title, eventDate, symbol, phase: "recap",
 *           markdown, enriched: { actual, reaction } | null }
 *   - 409 if actual_value still missing after enrichment attempt
 *   - 4xx for validation / not-found
 *
 * No email, no audit row — this is purely a preview surface for the
 * EarningsHub "Generate" button. Use POST /api/earnings/email when the
 * user wants to actually send the recap.
 *
 * In-app pattern: no X-Cron-Secret header required, mirroring
 * /api/earnings/skip and /api/earnings/actuals.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    eventId?: number;
    runEnrichmentFirst?: boolean;
  };

  if (typeof body.eventId !== "number" || !Number.isInteger(body.eventId)) {
    return Response.json(
      { error: "Body field 'eventId' must be an integer." },
      { status: 400 },
    );
  }
  const eventId = body.eventId;
  const runEnrich = body.runEnrichmentFirst !== false;

  let enrichmentResult: { actual: string | null; reaction: unknown } | null = null;

  if (runEnrich) {
    try {
      const results = await runEnrichment(db, { eventId });
      const r = results[0];
      if (r) {
        enrichmentResult = {
          actual: r.actual,
          reaction: r.reaction,
        };
      }
    } catch (err) {
      // Enrichment failures shouldn't block compose — the AI prompt has
      // a fallback web_search ask for missing actuals.
      console.warn(
        `[recap-modal] Enrichment for event ${eventId} failed:`,
        err,
      );
    }
  }

  try {
    const composed = await composeEarningsEmail(db, eventId, "recap");
    const event = db
      .prepare(`SELECT event_date FROM calendar_events WHERE id = ?`)
      .get(eventId) as Pick<CalendarEvent, "event_date"> | undefined;

    return Response.json({
      success: true,
      html: composed.html,
      title: composed.title,
      eventDate: event?.event_date ?? null,
      symbol: composed.symbol,
      phase: "recap" as const,
      markdown: composed.markdown,
      enriched: enrichmentResult,
    });
  } catch (err) {
    if (err instanceof EarningsEmailError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[recap-modal] Compose error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Compose failed" },
      { status: 500 },
    );
  }
}
