import { db } from "@/lib/db";
import { correctEarningsEventDate } from "@/lib/mutations/calendar";

export const dynamic = "force-dynamic";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * POST /api/earnings/correct-date — fix a wrong sync-sourced earnings
 * date/slot from the EarningsHub date chip (feedback #7).
 *
 * Body: { symbol, wrongDate: "YYYY-MM-DD", correctDate: "YYYY-MM-DD", slot?: "bmo" | "amc" }
 *
 * Thin honest wrapper over correctEarningsEventDate — suppress+delete of the
 * wrong rows, manual-row mint (or vendor-row adoption on date moves), bogeys
 * migration, refusal on captured actuals, same-date slot-only fixes all live
 * in the lib. In-app only (no cron auth — same family as confirm-date/skip).
 *
 * 404 when no earnings row exists for (symbol, wrongDate): the lib would
 * happily mint a fresh manual row with nothing to correct — the route refuses
 * instead so a typo'd date can't quietly create a phantom event.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    symbol?: string;
    wrongDate?: string;
    correctDate?: string;
    slot?: string;
  };

  if (typeof body.symbol !== "string" || body.symbol.trim() === "") {
    return Response.json({ success: false, error: "symbol is required" }, { status: 400 });
  }
  if (typeof body.wrongDate !== "string" || !DATE_RE.test(body.wrongDate)) {
    return Response.json(
      { success: false, error: "wrongDate must be YYYY-MM-DD" },
      { status: 400 },
    );
  }
  if (typeof body.correctDate !== "string" || !DATE_RE.test(body.correctDate)) {
    return Response.json(
      { success: false, error: "correctDate must be YYYY-MM-DD" },
      { status: 400 },
    );
  }
  let slot: "BMO" | "AMC" | undefined;
  if (body.slot != null) {
    const s = String(body.slot).toUpperCase();
    if (s !== "BMO" && s !== "AMC") {
      return Response.json(
        { success: false, error: 'slot must be "bmo" or "amc"' },
        { status: 400 },
      );
    }
    slot = s;
  }

  const symbol = body.symbol.trim().toUpperCase();
  const existing = db
    .prepare(
      `SELECT COUNT(*) AS n FROM calendar_events
        WHERE UPPER(symbol) = ? AND event_date = ? AND event_type = 'earnings'`,
    )
    .get(symbol, body.wrongDate) as { n: number };
  if (existing.n === 0) {
    return Response.json(
      {
        success: false,
        error: `No earnings row for ${symbol} on ${body.wrongDate} — nothing to correct.`,
      },
      { status: 404 },
    );
  }

  const result = correctEarningsEventDate(db, {
    symbol,
    wrongDate: body.wrongDate,
    correctDate: body.correctDate,
    slot,
  });

  if (!result.ok) {
    return Response.json(
      { success: false, error: result.refusedReason ?? "correction refused" },
      { status: 409 },
    );
  }

  return Response.json({
    success: true,
    data: {
      newEventId: result.newEventId,
      deletedIds: result.deletedIds ?? [],
      bogeysMigrated: result.bogeysMigrated ?? 0,
    },
  });
}
