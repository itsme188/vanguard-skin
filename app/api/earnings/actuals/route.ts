import { db } from "@/lib/db";
import type { CalendarEvent } from "@/lib/types";
import { parseFinnhubFigure } from "@/lib/format/finnhub-figure";
import { saveManualActuals, clearManualActuals } from "@/lib/earnings/actuals";
import { clusterManualActualsAt } from "@/lib/queries/manual-actuals-cluster";

export const dynamic = "force-dynamic";

interface PostBody {
  event_id?: number;
  eps_actual?: number | null;
  revenue_actual_usd?: number | null;
  notes?: string | null;
  /** Bypass the pre-print floor (user confirmed the future-dated release). */
  force?: boolean;
  /**
   * Clear mode — null out a MANUAL actuals override (see
   * lib/earnings/actuals.ts::clearManualActuals). Mutually exclusive with
   * eps_actual / revenue_actual_usd; 400s if both are present.
   */
  clear?: boolean;
}

/**
 * POST /api/earnings/actuals — manually fill in the reported actuals.
 *
 * Use cases: enrichment runner failed (TWS down, Finnhub gap), reaction
 * window expired before bars came in, or the user wants to lock in a
 * specific number from the press release. Writes to
 * calendar_events.actual_value in the Finnhub-style "EPS X.XX · Rev N"
 * format so all existing readers (renderHeadlineTable, EarningsHub UI,
 * recap composer) work unchanged. Bumps enriched_at to now.
 *
 * Pre-print floor: refuses (409, code 'pre_print') when the event's release
 * instant is still in the future, unless the body carries force:true — see
 * lib/earnings/actuals.ts / lib/earnings/pre-print-floor.ts.
 *
 * Clear mode ({ event_id, clear: true }): nulls a MANUAL actuals override —
 * see lib/earnings/actuals.ts::clearManualActuals. Refuses (409, code
 * 'not_manual') when the event's actuals weren't entered manually
 * (calendar_events.manual_actuals_at IS NULL) — sync-owned enrichment
 * actuals can't be wiped through this control. Mutually exclusive with
 * eps_actual / revenue_actual_usd (400 if combined).
 *
 * GET /api/earnings/actuals?eventId=NN — returns the parsed current
 * actual_value as { eps_actual, revenue_actual_usd }, plus manual_actuals_at
 * (non-null only for a manual override) so the modal can pre-populate and
 * decide whether to show the "Clear actuals" control. manual_actuals_at is
 * HEALED through the twin cluster (lib/queries/manual-actuals-cluster.ts)
 * before it is returned: a canonical-twin flip can strand the acceptance
 * stamp on a now-superseded row, and without healing here the editor showed
 * "un-accepted" while every other surface (Today, EarningsHub, cockpit)
 * showed accepted — and "Clear actuals" 409'd as a result (task-4 brief,
 * Finding A). actual_value_raw stays the addressed row's own value; healing
 * only ever moves the STAMP, never lends a different row's figure.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const eventId = Number(url.searchParams.get("eventId"));
  if (!Number.isInteger(eventId) || eventId <= 0) {
    return Response.json(
      { error: "Query param 'eventId' must be a positive integer." },
      { status: 400 },
    );
  }
  const event = db
    .prepare(
      `SELECT id, actual_value, consensus_value, enriched_at, manual_actuals_at, symbol, event_date, event_type
         FROM calendar_events WHERE id = ?`,
    )
    .get(eventId) as
    | (Pick<
        CalendarEvent,
        | "id"
        | "actual_value"
        | "consensus_value"
        | "enriched_at"
        | "symbol"
        | "event_date"
        | "event_type"
      > & {
        manual_actuals_at: string | null;
      })
    | undefined;
  if (!event) {
    return Response.json({ error: `Event ${eventId} not found.` }, { status: 404 });
  }

  const parsed = parseFinnhubFigure(event.actual_value);
  return Response.json({
    eps_actual: parsed.eps,
    revenue_actual_usd: parsed.revenue,
    actual_value_raw: event.actual_value,
    enriched_at: event.enriched_at,
    // Threaded so the BogeysEditModal can show "Clear actuals" only for a
    // manually-saved override — sync-owned actuals stay protected (see
    // clearManualActuals). Healed across the twin cluster so a stranded
    // stamp still shows accepted here.
    manual_actuals_at: clusterManualActualsAt(db, event),
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as PostBody;
  if (typeof body.event_id !== "number" || !Number.isInteger(body.event_id)) {
    return Response.json(
      { error: "Body field 'event_id' must be an integer." },
      { status: 400 },
    );
  }

  if (body.clear === true) {
    if (body.eps_actual != null || body.revenue_actual_usd != null) {
      return Response.json(
        {
          error:
            "Provide either actual values to save or 'clear: true' to clear them — not both.",
        },
        { status: 400 },
      );
    }
    const result = clearManualActuals(db, { eventId: body.event_id });
    if (!result.ok) {
      const payload: { error: string; code?: string } = { error: result.error };
      if ("code" in result) payload.code = result.code;
      return Response.json(payload, { status: result.status });
    }
    return Response.json({ success: true, cleared: true });
  }

  const result = saveManualActuals(db, {
    eventId: body.event_id,
    epsActual: body.eps_actual,
    revenueActualUsd: body.revenue_actual_usd,
    force: body.force === true,
  });

  if (!result.ok) {
    const payload: { error: string; code?: string } = { error: result.error };
    if ("code" in result) payload.code = result.code;
    return Response.json(payload, { status: result.status });
  }

  return Response.json({ success: true, actual_value: result.actualValue });
}
