import { db } from "@/lib/db";
import { correctEarningsEventDate } from "@/lib/mutations/calendar";
import { attemptPostCommitDrain } from "@/lib/earnings/cloud-outbox";
import { todayET } from "@/lib/calendar/date-utils";
import { manualEventDateError, tickerShapeError } from "@/lib/calendar/manual-event-input";
import {
  checkManualAddContradictsConfirmedDate,
  WOULD_CONTRADICT_CONFIRMED_DATE,
} from "@/lib/calendar/manual-add-contradicts-confirmed";

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
 *
 * 400 when the symbol cannot be a ticker, or when correctDate is not a real
 * day from 2000 to two years ahead: this route mints a manual row at that
 * date, and a typo'd year would store one no screen shows.
 *
 * 409 `would_contradict_confirmed_date` (owner ruling 2026-10-20): a move to
 * another day in the same week as a showing, confirmed vendor date for the
 * same company (two sources agree, or web-verified for that day) would leave
 * two prints, each with its own emails. The rows on wrongDate are excluded:
 * the correction deletes them. A same-date slot fix is never checked.
 * `forceContradictConfirmed: true` answers ONLY this question; the route has
 * no other acknowledgement, and the vendor-supersede guard stays off it.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    symbol?: string;
    wrongDate?: string;
    correctDate?: string;
    slot?: string;
    forceContradictConfirmed?: boolean;
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
  const symbolError = tickerShapeError(body.symbol);
  if (symbolError) return Response.json({ success: false, error: symbolError }, { status: 400 });
  const dateError = manualEventDateError(body.correctDate, todayET(), "corrected date");
  if (dateError) return Response.json({ success: false, error: dateError }, { status: 400 });
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
  // The same row set correctEarningsEventDate deletes.
  const wrongIds = (
    db
      .prepare(
        `SELECT id FROM calendar_events
          WHERE UPPER(symbol) = ? AND event_date = ? AND event_type = 'earnings'`,
      )
      .all(symbol, body.wrongDate) as Array<{ id: number }>
  ).map((r) => r.id);
  if (wrongIds.length === 0) {
    return Response.json(
      {
        success: false,
        error: `No earnings row for ${symbol} on ${body.wrongDate} — nothing to correct.`,
      },
      { status: 404 },
    );
  }

  if (body.forceContradictConfirmed !== true && body.correctDate !== body.wrongDate) {
    const found = checkManualAddContradictsConfirmedDate(db, {
      symbol,
      eventDate: body.correctDate,
      excludeEventIds: wrongIds,
    });
    if (found) {
      return Response.json(
        {
          success: false,
          error: found.message
            .replace("Nothing was added.", "Nothing was changed.")
            .replace("Change the date, or add anyway to keep both.", "Pick another date, or fix anyway to keep both."),
          code: WOULD_CONTRADICT_CONFIRMED_DATE,
          vendorEventId: found.vendorEventId,
          vendorDate: found.vendorDate,
          vendorSource: found.vendorSource,
          basis: found.basis,
        },
        { status: 409 },
      );
    }
  }

  const result = correctEarningsEventDate(db, {
    symbol,
    wrongDate: body.wrongDate,
    correctDate: body.correctDate,
    slot,
  });

  if (!result.ok) {
    // A no-change submission is caller error (400), not a domain conflict.
    const status = result.code === "no_change" ? 400 : 409;
    return Response.json(
      { success: false, error: result.refusedReason ?? "correction refused" },
      { status },
    );
  }

  // Post-commit attempt to hand the fresh armed-events generation to the
  // Worker (v2 slice A). The whole wait is capped at 2s — including any drain
  // already in flight — after which the push continues in the background and
  // the 15-minute sweep is the backstop.
  await attemptPostCommitDrain(db);

  return Response.json({
    success: true,
    data: {
      newEventId: result.newEventId,
      deletedIds: result.deletedIds ?? [],
      bogeysMigrated: result.bogeysMigrated ?? 0,
    },
  });
}
