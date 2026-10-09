import { db } from "@/lib/db";
import { confirmEarningsDate } from "@/lib/mutations/confirm-earnings-date";
import { todayET } from "@/lib/calendar/date-utils";
import { normalizeTicker, tickerShapeError } from "@/lib/calendar/manual-event-input";

export const dynamic = "force-dynamic";

/**
 * POST /api/earnings/confirm-date — Record an IBKR-definitive earnings date.
 *
 * Body: { symbol: string, confirmedDate: "YYYY-MM-DD", confirmedTime?: "bmo" | "amc" | "HH:MM" }
 *
 * Writes a locked `user_confirmed` manual row and supersedes the conflicting
 * Finnhub/Nasdaq rows for that name. Future syncs never revert it. In-app only
 * (no cron auth). Idempotent.
 *
 * Answers `{ success: true, data: { eventId, eventDate } }` — `eventId` is the
 * one row that now carries the confirmed date, so a caller holding two rows
 * for one name can tell which was locked. When the name already had ONE other
 * showing hand-entered row for the same upcoming print, that row is moved onto
 * the confirmed date (`data.movedEventId`, same id as `eventId`) or, when a
 * hand-entered row already sat on the confirmed date, folded into it and
 * deleted (`data.deletedEventId`; or left hidden as `data.foldedEventId` with
 * a `data.note` when records were still attached to it). With several such
 * rows nothing is moved and
 * `data.notice` carries a sentence for the user. Failures are
 * `{ success: false, error }`: 400 for a bad body, 409 when the mutation
 * refuses the date (past, or too far ahead).
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    symbol?: string;
    confirmedDate?: string;
    confirmedTime?: string;
  };

  if (typeof body.symbol !== "string" || body.symbol.trim() === "") {
    return Response.json({ success: false, error: "symbol is required" }, { status: 400 });
  }
  const symbolError = tickerShapeError(body.symbol);
  if (symbolError) {
    return Response.json({ success: false, error: symbolError }, { status: 400 });
  }
  if (typeof body.confirmedDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.confirmedDate)) {
    return Response.json(
      { success: false, error: "confirmedDate must be YYYY-MM-DD" },
      { status: 400 },
    );
  }

  const symbol = normalizeTicker(body.symbol);
  const result = confirmEarningsDate(db, {
    symbol,
    confirmedDate: body.confirmedDate,
    confirmedTime: body.confirmedTime ?? null,
    today: todayET(),
  });
  if (!result.ok) {
    return Response.json({ success: false, error: result.refusedReason }, { status: 409 });
  }

  // The row the mutation wrote, read back by its own date: with two rows on
  // file for one name, the answer names the confirmed one and no other.
  const confirmed = db
    .prepare(
      `SELECT id FROM calendar_events
        WHERE source = 'manual' AND event_type = 'earnings'
          AND UPPER(symbol) = ? AND event_date = ?
          AND date_status = 'user_confirmed'
        ORDER BY id LIMIT 1`,
    )
    .get(symbol, body.confirmedDate) as { id: number } | undefined;

  return Response.json({
    success: true,
    data: {
      eventId: confirmed?.id ?? null,
      eventDate: body.confirmedDate,
      ...(result.movedEventId !== undefined ? { movedEventId: result.movedEventId } : {}),
      ...(result.deletedEventId !== undefined ? { deletedEventId: result.deletedEventId } : {}),
      ...(result.foldedEventId !== undefined ? { foldedEventId: result.foldedEventId } : {}),
      ...(result.note ? { note: result.note } : {}),
      ...(result.notice ? { notice: result.notice } : {}),
    },
  });
}
