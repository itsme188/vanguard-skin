import { db } from "@/lib/db";
import {
  countEarningsDateConflicts,
  getEarningsDateConflicts,
} from "@/lib/queries/calendar";
import { todayET } from "@/lib/calendar/date-utils";

export const dynamic = "force-dynamic";

/**
 * GET /api/earnings/conflicts — earnings whose Finnhub × Nasdaq dates
 * disagree and await the user's IBKR confirmation, next 14 days.
 *
 * ?countOnly=true → { success, count } (NotificationBell badge).
 * default         → { success, count, conflicts } (Alerts-inbox Conflicts
 *                   view — the mobile-reachable surface for the badge).
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const countOnly = url.searchParams.get("countOnly") === "true";
    const today = todayET();
    if (countOnly) {
      return Response.json({ success: true, count: countEarningsDateConflicts(db, today) });
    }
    const conflicts = getEarningsDateConflicts(db, today);
    return Response.json({ success: true, count: conflicts.length, conflicts });
  } catch {
    return Response.json({ success: false, count: 0, conflicts: [] });
  }
}
