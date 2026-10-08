/**
 * Manual calendar-event CRUD. Note: POST /api/earnings/correct-date is NOT
 * gated by the would_supersede_vendor guard used by POST/PATCH below — it
 * names the wrong date explicitly, so user intent there is already explicit.
 */
import { db } from "@/lib/db";
import { getUpcomingEvents } from "@/lib/queries/calendar";
import {
  insertCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  deleteAndSuppressCalendarEvent,
} from "@/lib/mutations/calendar";
import { mondayOf, addDays, todayET } from "@/lib/calendar/date-utils";
import { getSecurityIdForSymbol } from "@/lib/queries/briefing-symbols";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import {
  manualEventDateError,
  normalizeTicker,
  tickerShapeError,
} from "@/lib/calendar/manual-event-input";
import { attemptPostCommitDrain } from "@/lib/earnings/cloud-outbox";
import { checkManualAddWouldSupersedeVendor } from "@/lib/calendar/reconcile-earnings-dates";
import { checkManualSlotAgainstKnownTime } from "@/lib/earnings/wire-times";
import { fixDateOrigin, liftEarningsSuppression } from "@/lib/calendar/fix-date-suppression";

export const dynamic = "force-dynamic";

/**
 * The security a typed symbol belongs to: the symbol itself first
 * (case-insensitive, stock or ETF), then a share-class sibling, so GOOGL
 * typed with only GOOG on file still links to that company's page. Null when
 * the app has never seen the name; the event is saved all the same.
 */
function resolveEventSecurityId(symbol: string): number | null {
  const own = getSecurityIdForSymbol(db, symbol);
  if (own !== null) return own;
  for (const sibling of issuerSiblings(symbol)) {
    const id = getSecurityIdForSymbol(db, sibling);
    if (id !== null) return id;
  }
  return null;
}

/** 400 for typed input that cannot be saved. Nothing was written. */
function invalidInput(code: "invalid_symbol" | "invalid_date", error: string): Response {
  return Response.json({ success: false, error, code }, { status: 400 });
}

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
    // addDays does noon-anchored arithmetic so the week end never drops a day
    // when the server's local TZ is behind UTC (e.g. a Mac traveling east).
    effectiveEnd = addDays(weekOf, 6);
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
 *
 * Second 409, `would_supersede_vendor` (user ruling 2026-09-02): a manual
 * earnings row wins its cluster outright at the next reconcile pass, so an
 * add in a DIFFERENT week from a live vendor date silently takes that vendor
 * date off every calendar surface. checkManualAddWouldSupersedeVendor dry-runs
 * the reconciler and this route refuses the write, naming the date and source
 * it would replace; `force: true` skips the check and inserts. Same refuse +
 * override shape as approveLevelGuarded on /api/levels/review. Supersession
 * itself is unchanged — the user simply gets told before it happens.
 *
 * Third 409, `slot_contradicts_known_time` (user ruling 2026-10-05): a manual
 * earnings row may not store a BMO/AMC slot and a release time on opposite
 * sides of the session. When the chosen slot contradicts the symbol's known
 * release time (checkManualSlotAgainstKnownTime — the release cascade's own
 * evidence and side-of-noon rule) the write is refused; `forceSlot: true`
 * inserts and stores the SLOT default time, never the contradicting
 * remembered one.
 * With no known time there is no refusal and the slot default is stored; a
 * same-side known time is kept. An explicit `release_time` in the body is the
 * caller's own statement and is not second-guessed.
 *
 * The two acknowledgements are SEPARATE and specific: `forceSlot` skips only
 * the slot guard, `force` skips only the vendor-supersede guard (its meaning
 * before the slot guard existed). A guard that was not acknowledged still
 * returns its own 409, so one add can be refused twice in sequence — slot
 * first, then supersede — each with its own reason. Answering one warning
 * never silently answers the other.
 *
 * Typed-input checks run before every guard and neither flag skips them: the
 * symbol must have the shape of a ticker (400 `invalid_symbol`; a well-formed
 * name the app has never seen is still saved, with `securityMatched: false`),
 * and the date must be a real day from 2000 to two years ahead (400
 * `invalid_date`).
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
    force?: boolean;
    forceSlot?: boolean;
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
  const symbolError = tickerShapeError(body.symbol);
  if (symbolError) return invalidInput("invalid_symbol", symbolError);
  const dateError = manualEventDateError(body.event_date, todayET());
  if (dateError) return invalidInput("invalid_date", dateError);

  try {
    const symbol = normalizeTicker(body.symbol);
    const eventType = body.event_type ?? "earnings";

    // Slot vs known time — only for an earnings add that names a BMO/AMC slot
    // and leaves the clock time to the server.
    const slotMarker = (body.event_time ?? "AMC").trim().toUpperCase();
    const slotCheck =
      eventType === "earnings" &&
      (slotMarker === "BMO" || slotMarker === "AMC") &&
      (body.release_time === undefined || body.release_time === null)
        ? checkManualSlotAgainstKnownTime(db, symbol, slotMarker === "BMO" ? "bmo" : "amc")
        : null;
    if (slotCheck && !slotCheck.ok && body.forceSlot !== true) {
      return Response.json(
        {
          success: false,
          error: slotCheck.message,
          code: "slot_contradicts_known_time",
          slot: slotMarker,
          knownTime: slotCheck.knownTime,
          slotDefaultTime: slotCheck.slotDefaultTime,
        },
        { status: 409 },
      );
    }
    // Reaching here with a contradiction means `forceSlot`: store the slot default.
    const guardedReleaseTime = slotCheck
      ? slotCheck.ok
        ? slotCheck.releaseTime
        : slotCheck.slotDefaultTime
      : undefined;

    if (body.force !== true) {
      const guard = checkManualAddWouldSupersedeVendor(db, {
        symbol,
        event_date: body.event_date,
        event_type: eventType,
      });
      if (!guard.ok) {
        const vendor = guard.wouldSupersede[0];
        return Response.json(
          {
            success: false,
            error: guard.message,
            code: "would_supersede_vendor",
            vendorEventId: vendor.eventId,
            vendorDate: vendor.eventDate,
            vendorSource: vendor.source,
          },
          { status: 409 },
        );
      }
    }

    const securityId = resolveEventSecurityId(symbol);
    const id = insertCalendarEvent(db, {
      symbol,
      event_date: body.event_date,
      event_type: eventType,
      event_time: body.event_time ?? "AMC",
      release_time: body.release_time ?? guardedReleaseTime,
      expected_impact: body.expected_impact ?? "high",
      consensus_estimate: body.consensus_estimate ?? null,
      description: body.description ?? null,
      security_id: securityId,
      week_of: mondayOf(body.event_date),
    });
    // v2 slice A: a fresh manual row is never armed, so this normally sends
    // nothing — it is the catch-up for any generation still unsent. The whole
    // wait is capped (2s); the 15-minute sweep is the backstop.
    await attemptPostCommitDrain(db);
    return Response.json({ success: true, id: id.id, securityMatched: securityId !== null });
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
 * Body: { id, ...partial fields from CalendarEventInput, force? }
 *
 * Only allowed on rows where source='manual'. Returns 403 for sync-owned
 * rows (Finnhub/WSH/FRED) — those should be updated through their own
 * sync paths. That 403 check always runs first; `force` never bypasses it.
 *
 * Same `would_supersede_vendor` 409 as POST (landing-review sibling defect,
 * PR #65): moving a manual row's event_date to a different week has
 * byte-identical reconcile consequences to adding one there — rung 1 of
 * resolveCluster still wins and silently supersedes a vendor row in the
 * destination cluster. Only runs when `event_date` is present and differs
 * from the stored value (a title/notes-only PATCH never invokes it); the
 * dry run excludes the row's own CURRENT occurrence (excludeEventId) so its
 * pre-move position can't manufacture a false before/after diff. `force:
 * true` skips the check, same envelope and error code as POST.
 *
 * A new `symbol` or `event_date` passes the same typed-input checks as POST
 * (400 `invalid_symbol` / `invalid_date`), after the 404/403 checks.
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
    force?: boolean;
  };

  if (typeof body.id !== "number" || !Number.isInteger(body.id)) {
    return Response.json({ error: "Body field 'id' is required." }, { status: 400 });
  }

  // Read-first guard so we can return 404 vs 403 distinctly.
  const existing = db
    .prepare("SELECT source, symbol, event_date, event_type FROM calendar_events WHERE id = ?")
    .get(body.id) as
    | { source: string; symbol: string | null; event_date: string; event_type: string }
    | undefined;
  if (!existing) return Response.json({ error: "Event not found." }, { status: 404 });
  if (existing.source !== "manual") {
    return Response.json(
      { error: `Cannot edit a ${existing.source}-sourced event via this endpoint. Only manual rows are user-editable.` },
      { status: 403 },
    );
  }

  if (body.symbol !== undefined) {
    const symbolError =
      typeof body.symbol === "string"
        ? tickerShapeError(body.symbol)
        : "Body field 'symbol' must be a string when provided.";
    if (symbolError) return invalidInput("invalid_symbol", symbolError);
  }
  if (body.event_date !== undefined && body.event_date !== existing.event_date) {
    const dateError =
      typeof body.event_date === "string"
        ? manualEventDateError(body.event_date, todayET())
        : "Body field 'event_date' must be YYYY-MM-DD.";
    if (dateError) return invalidInput("invalid_date", dateError);
  }

  if (
    typeof body.event_date === "string" &&
    body.event_date !== existing.event_date &&
    body.force !== true
  ) {
    const symbol = (body.symbol ?? existing.symbol ?? "").trim().toUpperCase();
    const eventType = body.event_type ?? existing.event_type;
    const guard = checkManualAddWouldSupersedeVendor(db, {
      symbol,
      event_date: body.event_date,
      event_type: eventType,
      excludeEventId: body.id,
    });
    if (!guard.ok) {
      const vendor = guard.wouldSupersede[0];
      return Response.json(
        {
          success: false,
          error: guard.message,
          code: "would_supersede_vendor",
          vendorEventId: vendor.eventId,
          vendorDate: vendor.eventDate,
          vendorSource: vendor.source,
        },
        { status: 409 },
      );
    }
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

  // v2 slice A: an armed event's edit just minted a generation (unarmed edits
  // mint none) — hand it to the Worker under the same 2s cap.
  await attemptPostCommitDrain(db);
  return Response.json({ success: ok });
}

/**
 * DELETE /api/calendar/events — Delete a calendar event.
 *
 * Body: { id }
 *
 * Manual rows delete directly — and, for earnings, hand the print back: the
 * mutation re-runs the reconciler for that issuer family so any vendor row the
 * manual date was superseding becomes visible again (a removed "+ Add ticker"
 * row must not take the company's real date down with it).
 * Sync-owned EARNINGS rows (finnhub/nasdaq/wsh)
 * delete via suppression (migration 070): the (symbol, date, type) tuple is
 * recorded so the next sync sweep can't re-insert the same wrong date — the
 * user correction path for a mis-dated source row (NET Jul 30 vs Aug 6).
 * Sync-owned macro rows stay 403 (symbol-less; owned by their source
 * pipeline).
 *
 * `restoreVendorDate: true` (owner ruling 2026-09-02, option 2) is for a
 * manual row that "Fix date" minted: that correction suppressed the vendor's
 * original date, so removing the corrected row alone leaves the company with
 * no earnings date and no sync to restore one. With the flag the same
 * transaction also lifts that one suppression; the vendor's row returns on
 * the next calendar sync. Without it the delete is unchanged. The flag is
 * refused (400, nothing deleted) on any row that is not such a correction.
 */
export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    id?: number;
    restoreVendorDate?: boolean;
  };
  if (typeof body.id !== "number" || !Number.isInteger(body.id)) {
    return Response.json({ error: "Body field 'id' is required." }, { status: 400 });
  }
  const id = body.id;

  const existing = db
    .prepare("SELECT source, event_type, symbol, description FROM calendar_events WHERE id = ?")
    .get(id) as
    | { source: string; event_type: string; symbol: string | null; description: string | null }
    | undefined;
  if (!existing) return Response.json({ error: "Event not found." }, { status: 404 });

  const vendorDate =
    existing.event_type === "earnings" && existing.symbol ? fixDateOrigin(existing) : null;
  const restoreTarget =
    body.restoreVendorDate === true && vendorDate !== null && existing.symbol
      ? { symbol: existing.symbol, eventDate: vendorDate }
      : null;
  if (body.restoreVendorDate === true && restoreTarget === null) {
    return Response.json(
      {
        success: false,
        error:
          "This row is not a corrected earnings date, so there is no vendor date to restore. Nothing was removed.",
      },
      { status: 400 },
    );
  }

  if (existing.source === "manual") {
    // One transaction: the suppression is lifted only if the row really went.
    const result = db.transaction(() => {
      const deleted = deleteCalendarEvent(db, id);
      const lifted = deleted && restoreTarget ? liftEarningsSuppression(db, restoreTarget) : 0;
      return { deleted, lifted };
    })();
    // Deleting an ARMED row writes a tombstone generation (D7) — same
    // time-sensitivity as a disarm, so it gets the same post-commit push.
    await attemptPostCommitDrain(db);
    return Response.json({
      success: result.deleted,
      ...(restoreTarget
        ? { vendorDate: restoreTarget.eventDate, suppressionsLifted: result.lifted }
        : {}),
    });
  }

  if (existing.event_type !== "earnings" || !existing.symbol) {
    return Response.json(
      { error: `Cannot delete a ${existing.source}-sourced ${existing.event_type} event — macro rows are owned by their sync pipeline.` },
      { status: 403 },
    );
  }

  const result = deleteAndSuppressCalendarEvent(db, id);
  // Armed worksheets mostly sit on SYNC-sourced rows, so this branch is the
  // common tombstone path (D7) — same post-commit push as the manual branch.
  await attemptPostCommitDrain(db);
  return Response.json({
    success: result.deleted,
    suppressed: result.suppressed,
  });
}
