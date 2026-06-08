import { db } from "@/lib/db";
import { confirmEarningsDate } from "@/lib/mutations/confirm-earnings-date";
import { todayET } from "@/lib/calendar/date-utils";

export const dynamic = "force-dynamic";

/**
 * POST /api/earnings/confirm-date — Record an IBKR-definitive earnings date.
 *
 * Body: { symbol: string, confirmedDate: "YYYY-MM-DD", confirmedTime?: "bmo" | "amc" | "HH:MM" }
 *
 * Writes a locked `user_confirmed` manual row and supersedes the conflicting
 * Finnhub/Nasdaq rows for that name. Future syncs never revert it. In-app only
 * (no cron auth). Idempotent.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    symbol?: string;
    confirmedDate?: string;
    confirmedTime?: string;
  };

  if (typeof body.symbol !== "string" || body.symbol.trim() === "") {
    return Response.json({ error: "symbol is required" }, { status: 400 });
  }
  if (typeof body.confirmedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.confirmedDate)) {
    return Response.json({ error: "confirmedDate must be YYYY-MM-DD" }, { status: 400 });
  }

  confirmEarningsDate(db, {
    symbol: body.symbol.trim(),
    confirmedDate: body.confirmedDate,
    confirmedTime: body.confirmedTime ?? null,
    today: todayET(),
  });

  return Response.json({ ok: true });
}
