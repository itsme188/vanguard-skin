import { db } from "@/lib/db";
import { getUpcomingEvents } from "@/lib/queries/calendar";

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
