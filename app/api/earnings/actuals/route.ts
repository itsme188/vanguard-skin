import { db } from "@/lib/db";
import type { CalendarEvent } from "@/lib/types";
import { parseFinnhubFigure } from "@/lib/format/finnhub-figure";
import { saveManualActuals } from "@/lib/earnings/actuals";

export const dynamic = "force-dynamic";

interface PostBody {
  event_id?: number;
  eps_actual?: number | null;
  revenue_actual_usd?: number | null;
  notes?: string | null;
  /** Bypass the pre-print floor (user confirmed the future-dated release). */
  force?: boolean;
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
 * GET /api/earnings/actuals?eventId=NN — returns the parsed current
 * actual_value as { eps_actual, revenue_actual_usd } so the modal can
 * pre-populate.
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
      `SELECT id, actual_value, consensus_value, enriched_at FROM calendar_events WHERE id = ?`,
    )
    .get(eventId) as
    | Pick<CalendarEvent, "id" | "actual_value" | "consensus_value" | "enriched_at">
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
