import { db } from "@/lib/db";
import { countEarningsDateConflicts } from "@/lib/queries/calendar";
import { todayET } from "@/lib/calendar/date-utils";

export const dynamic = "force-dynamic";

/**
 * GET /api/earnings/conflicts?countOnly=true — number of earnings whose
 * Finnhub × Nasdaq dates disagree and await the user's IBKR confirmation,
 * in the next 14 days. Feeds the NotificationBell nudge.
 */
export async function GET() {
  try {
    const count = countEarningsDateConflicts(db, todayET());
    return Response.json({ success: true, count });
  } catch {
    return Response.json({ success: false, count: 0 });
  }
}
