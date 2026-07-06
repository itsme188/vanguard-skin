import { db } from "@/lib/db";
import type { CalendarEvent } from "@/lib/types";
import { parseFinnhubFigure, mergeFinnhubActual } from "@/lib/format/finnhub-figure";

export const dynamic = "force-dynamic";

interface PostBody {
  event_id?: number;
  eps_actual?: number | null;
  revenue_actual_usd?: number | null;
  notes?: string | null;
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

  const event = db
    .prepare(`SELECT id, event_type, actual_value FROM calendar_events WHERE id = ?`)
    .get(body.event_id) as
    | { id: number; event_type: string; actual_value: string | null }
    | undefined;
  if (!event) {
    return Response.json({ error: `Event ${body.event_id} not found.` }, { status: 404 });
  }

  if (body.eps_actual == null && body.revenue_actual_usd == null) {
    return Response.json(
      { error: "Provide at least one of eps_actual or revenue_actual_usd." },
      { status: 400 },
    );
  }

  // MERGE into the stored Finnhub-shaped value — an EPS-only save must not
  // wipe a previously-captured revenue (audit B18). Output stays
  // "EPS X.XX · Rev NNNNNN" so all downstream readers work unchanged.
  const formatted = mergeFinnhubActual(event.actual_value, {
    eps: body.eps_actual,
    revenue: body.revenue_actual_usd,
  });
  if (!formatted) {
    return Response.json(
      { error: "Provide at least one of eps_actual or revenue_actual_usd." },
      { status: 400 },
    );
  }
  db.prepare(
    `UPDATE calendar_events
        SET actual_value = ?,
            enriched_at = COALESCE(enriched_at, datetime('now'))
      WHERE id = ?`,
  ).run(formatted, body.event_id);

  return Response.json({ success: true, actual_value: formatted });
}
