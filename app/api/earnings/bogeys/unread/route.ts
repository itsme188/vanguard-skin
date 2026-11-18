import { db } from "@/lib/db";
import { listUnreadPreviews } from "@/lib/earnings/unread-previews";

export const dynamic = "force-dynamic";

function fail(error: string, status: number) {
  return Response.json({ success: false, error }, { status });
}

/**
 * GET /api/earnings/bogeys/unread?eventId= (bogey intake 2026-11-18, Task D).
 *
 * The previews that name this print's ticker, arrived in the days before it,
 * and have not been read for its bogeys (`listUnreadPreviews`). Reads only;
 * no AI call. Answers `{ success: true, data: { articles } }`; 400 for a bad
 * eventId, 404 for an unknown event.
 */
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("eventId")?.trim() ?? "";
  const eventId = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(eventId) || eventId <= 0) {
    return fail("Query parameter 'eventId' must be a positive whole number.", 400);
  }
  const articles = listUnreadPreviews(db, eventId);
  if (articles === null) return fail(`No earnings event has id ${eventId}.`, 404);
  return Response.json({ success: true, data: { articles } });
}
