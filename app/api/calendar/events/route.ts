import { db } from "@/lib/db";
import { getUpcomingEvents } from "@/lib/queries/calendar";
import {
  insertCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
} from "@/lib/mutations/calendar";
import { mondayOf } from "@/lib/calendar/date-utils";
import { getSecurityIdForSymbol } from "@/lib/queries/briefing-symbols";

export const dynamic = "force-dynamic";

/**
 * GET /api/calendar/events?start=YYYY-MM-DD&end=YYYY-MM-DD&weekOf=YYYY-MM-DD
 *
 * Read calendar events from database with optional date filtering.
 * At least one filter (start/end range or weekOf) should be provided.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const startDate = searchParams.get("start") ?? undefined;
  const endDate = searchParams.get("end") ?? undefined;
  const weekOf = searchParams.get("weekOf") ?? undefined;
  const source = searchParams.get("source") ?? undefined;
  const limitStr = searchParams.get("limit");
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;

  // If weekOf is provided, use it to derive start/end
  let effectiveStart = startDate;
  let effectiveEnd = endDate;
  if (weekOf && !startDate && !endDate) {
    effectiveStart = weekOf;
    const end = new Date(weekOf + "T00:00:00");
    end.setDate(end.getDate() + 6);
    effectiveEnd = end.toISOString().slice(0, 10);
  }

  const events = getUpcomingEvents(db, {
    startDate: effectiveStart,
    endDate: effectiveEnd,
    source,
    limit,
  });

  return Response.json({ events, startDate: effectiveStart, endDate: effectiveEnd });
}

/**
 * POST /api/calendar/events — Insert a manually-curated calendar event.
 *
 * Body: { symbol, event_date, event_time?='AMC', event_type?='earnings',
 *         release_time?, expected_impact?='high', consensus_estimate?,
 *         description? }
 *
 * Inserts with source='manual'. source_key derived as
 * `manual:{SYMBOL}:{event_date}:{event_type}`. week_of computed from
 * event_date. Returns 409 if a manual row already exists for that
 * symbol+date+type (UNIQUE collision).
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    symbol?: string;
    event_date?: string;
    event_time?: string | null;
    event_type?: string;
    release_time?: string | null;
    expected_impact?: string | null;
    consensus_estimate?: string | null;
    description?: string | null;
  };

  if (typeof body.symbol !== "string" || body.symbol.trim() === "") {
    return Response.json({ error: "Body field 'symbol' is required." }, { status: 400 });
  }
  if (typeof body.event_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.event_date)) {
    return Response.json({ error: "Body field 'event_date' must be YYYY-MM-DD." }, { status: 400 });
  }
  if (body.event_time !== undefined && body.event_time !== null && typeof body.event_time !== "string") {
    return Response.json({ error: "Body field 'event_time' must be a string when provided." }, { status: 400 });
  }

  try {
    const symbol = body.symbol.trim().toUpperCase();
    const id = insertCalendarEvent(db, {
      symbol,
      event_date: body.event_date,
      event_type: body.event_type ?? "earnings",
      event_time: body.event_time ?? "AMC",
      release_time: body.release_time ?? undefined,
      expected_impact: body.expected_impact ?? "high",
      consensus_estimate: body.consensus_estimate ?? null,
      description: body.description ?? null,
      security_id: getSecurityIdForSymbol(db, symbol),
      week_of: mondayOf(body.event_date),
    });
    return Response.json({ success: true, id: id.id });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    // SQLITE_CONSTRAINT_UNIQUE → 409
    if (/UNIQUE constraint failed/i.test(msg)) {
      return Response.json(
        { error: `A manual calendar event already exists for ${body.symbol?.toUpperCase()} on ${body.event_date} (${body.event_type ?? "earnings"}). Edit it instead.` },
        { status: 409 },
      );
    }
    console.error("[calendar/events POST] Error:", err);
    return Response.json({ error: msg }, { status: 500 });
  }
}

/**
 * PATCH /api/calendar/events — Update a manual calendar event.
 *
 * Body: { id, ...partial fields from CalendarEventInput }
 *
 * Only allowed on rows where source='manual'. Returns 403 for sync-owned
 * rows (Finnhub/WSH/FRED) — those should be updated through their own
 * sync paths.
 */
export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    id?: number;
    symbol?: string;
    event_date?: string;
    event_time?: string | null;
    event_type?: string;
    release_time?: string | null;
    expected_impact?: string | null;
    consensus_estimate?: string | null;
    description?: string | null;
  };

  if (typeof body.id !== "number" || !Number.isInteger(body.id)) {
    return Response.json({ error: "Body field 'id' is required." }, { status: 400 });
  }

  // Read-first guard so we can return 404 vs 403 distinctly.
  const existing = db
    .prepare("SELECT source FROM calendar_events WHERE id = ?")
    .get(body.id) as { source: string } | undefined;
  if (!existing) return Response.json({ error: "Event not found." }, { status: 404 });
  if (existing.source !== "manual") {
    return Response.json(
      { error: `Cannot edit a ${existing.source}-sourced event via this endpoint. Only manual rows are user-editable.` },
      { status: 403 },
    );
  }

  const week_of = body.event_date ? mondayOf(body.event_date) : undefined;
  const ok = updateCalendarEvent(db, {
    id: body.id,
    event_date: body.event_date,
    event_time: body.event_time,
    event_type: body.event_type,
    release_time: body.release_time,
    expected_impact: body.expected_impact,
    consensus_estimate: body.consensus_estimate,
    description: body.description,
    symbol: body.symbol,
    week_of,
  });

  return Response.json({ success: ok });
}

/**
 * DELETE /api/calendar/events — Delete a manual calendar event.
 *
 * Body: { id }
 *
 * Same source='manual' guard as PATCH.
 */
export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: number };
  if (typeof body.id !== "number" || !Number.isInteger(body.id)) {
    return Response.json({ error: "Body field 'id' is required." }, { status: 400 });
  }

  const existing = db
    .prepare("SELECT source FROM calendar_events WHERE id = ?")
    .get(body.id) as { source: string } | undefined;
  if (!existing) return Response.json({ error: "Event not found." }, { status: 404 });
  if (existing.source !== "manual") {
    return Response.json(
      { error: `Cannot delete a ${existing.source}-sourced event via this endpoint.` },
      { status: 403 },
    );
  }

  const ok = deleteCalendarEvent(db, body.id);
  return Response.json({ success: ok });
}
