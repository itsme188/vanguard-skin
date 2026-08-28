import { db } from "@/lib/db";
import { runEnrichment } from "@/lib/calendar/enrichment-runner";
import { describePrePrintFloor } from "@/lib/earnings/pre-print-floor";
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
 *   - 409 { success: false, code: "pre_print", error } when the enrichment
 *     runner refuses the row on the pre-print floor — clicking "Generate"
 *     before the print window opens must not fetch, write, or push. No
 *     force override is offered here: the row's actuals road (the bogeys
 *     modal "Save actuals", which owns the force confirm) is where a human
 *     asserts an early print, and nothing on this surface can.
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
      // Pre-print floor (2026-08-28): the runner fetched/wrote/pushed
      // nothing. Refuse the compose too rather than narrating a print that
      // has not happened — a recap composed off a stale or absent actual is
      // exactly the wrong-numbers failure the floor exists to prevent.
      if (r?.reason === "pre_print" && r.prePrint) {
        return Response.json(
          {
            success: false,
            code: "pre_print",
            error:
              describePrePrintFloor(r.prePrint.eventDate, r.prePrint) +
              " Enrichment and the recap stay locked until then.",
          },
          { status: 409 },
        );
      }
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
      // The no-actuals-yet guard (409) is the EXPECTED outcome of clicking
      // "gen" before a company reports — return 200 with a structured flag
      // so a routine click doesn't log a browser console error, and keep
      // the internals (event id, API paths) out of the user-facing copy.
      // The cron-auth /api/earnings/email path keeps its literal 409.
      if (err.status === 409) {
        return Response.json({
          success: false,
          notReady: true,
          error:
            "Not reported yet — the recap unlocks once actuals land, or after you save reported actuals in the bogeys editor.",
        });
      }
      return Response.json({ error: err.message }, { status: err.status });
    }
    console.error("[recap-modal] Compose error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "Compose failed" },
      { status: 500 },
    );
  }
}
