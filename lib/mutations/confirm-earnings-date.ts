import type Database from "better-sqlite3";
import { getSecurityIdForSymbolWithSiblings } from "@/lib/queries/briefing-symbols";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";
import { addDays, mondayOf, MAX_EARNINGS_DAYS_AHEAD } from "@/lib/calendar/date-utils";
import { resolveEarningsReleaseTime } from "@/lib/earnings/wire-times";
import { writeArmedEventsOutboxRow } from "@/lib/earnings/cloud-outbox";

export interface ConfirmEarningsDateInput {
  symbol: string;
  confirmedDate: string; // YYYY-MM-DD — the IBKR-definitive date the user picked
  confirmedTime?: string | null; // "bmo" | "amc" | "HH:MM"
  today: string; // ET today (for reconcile's past/future logic)
}

/**
 * Normalize the user's confirmed-time choice into a cascade-input
 * `event_time`: an explicit "HH:MM" passes through unchanged (layer 0 of the
 * cascade returns it verbatim), otherwise it becomes a "BMO"/"AMC" slot
 * marker so `resolveEarningsReleaseTime` can consult the symbol's release-
 * time cascade (user override → web_verified → observed → legacy default).
 * Unspecified/unrecognized input defaults to AMC, matching this mutation's
 * pre-cascade behavior.
 */
function toCascadeEventTime(time: string | null | undefined): string {
  if (time && /^\d{2}:\d{2}$/.test(time)) return time;
  return time?.trim().toLowerCase() === "bmo" ? "BMO" : "AMC";
}

/** The slot a stored clock time falls in: before noon is BMO, otherwise AMC. */
function slotOfClock(time: string | null | undefined): "BMO" | "AMC" | null {
  const m = time ? /^(\d{2}):\d{2}/.exec(time) : null;
  if (!m) return null;
  return Number(m[1]) < 12 ? "BMO" : "AMC";
}

/**
 * Record a user-confirmed earnings date as the authoritative, locked value.
 *
 * Writes (or updates in place) a `source='manual'` row at the confirmed date
 * with `date_status='user_confirmed'`, then re-runs the reconciler — which
 * treats a manual/user_confirmed row in a cluster as the locked canonical and
 * supersedes the Finnhub/Nasdaq rows. Future syncs never revert it (the
 * reconciler always defers to the manual row). Idempotent on the source_key.
 */
export type ConfirmEarningsDateResult =
  | { ok: true }
  | { ok: false; refusedReason: string };

export function confirmEarningsDate(
  db: Database.Database,
  input: ConfirmEarningsDateInput,
): ConfirmEarningsDateResult {
  // A conflict candidate can be a stale prior-quarter vendor date; locking it
  // would silently move an upcoming print into the past and off every
  // forward-looking surface. Mirror applyVerdict's guard: never accept a
  // past date (today's own date is fine — an AMC print confirmed on the day).
  if (input.confirmedDate < input.today) {
    return {
      ok: false,
      refusedReason: `${input.confirmedDate} is in the past — that looks like the stale prior-quarter source date, not the upcoming print. Pick the future date or enter the real one.`,
    };
  }
  // Symmetric upper bound: a far-future date (a typo'd year) would mint a
  // locked manual row that no sync can ever correct.
  if (input.confirmedDate > addDays(input.today, MAX_EARNINGS_DAYS_AHEAD)) {
    return {
      ok: false,
      refusedReason: `${input.confirmedDate} is more than ${MAX_EARNINGS_DAYS_AHEAD} days out — an upcoming print is never that far; check the year.`,
    };
  }
  const symbol = input.symbol.toUpperCase();
  const securityId = getSecurityIdForSymbolWithSiblings(db, symbol);
  const cascadeEventTime = toCascadeEventTime(input.confirmedTime);
  const releaseTime =
    resolveEarningsReleaseTime(db, {
      event_type: "earnings",
      event_time: cascadeEventTime,
      raw_json: null,
      symbol,
    }) ?? (cascadeEventTime === "BMO" ? "08:00" : "16:15");
  const sourceKey = `manual:${symbol}:${input.confirmedDate}:earnings`;

  db.transaction(() => {
    const before = db
      .prepare(
        `SELECT COALESCE(superseded, 0) AS superseded, event_time, release_time
           FROM calendar_events
          WHERE source_key = ?`,
      )
      .get(sourceKey) as
      | { superseded: number; event_time: string | null; release_time: string | null }
      | undefined;

    // A clock time the user typed on this row survives a confirm that picks the
    // same slot. Picking the other slot is a deliberate change of time.
    const typedClock =
      before && /^\d{2}:\d{2}$/.test(before.event_time ?? "") ? before.event_time : null;
    const pickedSlot = cascadeEventTime === "BMO" || cascadeEventTime === "AMC" ? cascadeEventTime : null;
    const keepTyped = typedClock !== null && pickedSlot !== null && slotOfClock(typedClock) === pickedSlot;
    const eventTimeToStore = keepTyped
      ? typedClock
      : input.confirmedTime == null
        ? null
        : cascadeEventTime;
    const releaseTimeToStore = keepTyped ? (before?.release_time ?? typedClock) : releaseTime;

    db.prepare(
      `INSERT INTO calendar_events
         (source, event_type, event_date, event_time, release_time, title, symbol,
          security_id, source_key, week_of, date_status, superseded)
       VALUES ('manual', 'earnings', ?, ?, ?, ?, ?, ?, ?, ?, 'user_confirmed', 0)
       ON CONFLICT(source_key) DO UPDATE SET
         event_date = excluded.event_date,
         event_time = excluded.event_time,
         release_time = excluded.release_time,
         security_id = excluded.security_id,
         date_status = 'user_confirmed',
         superseded = 0`,
    ).run(
      input.confirmedDate,
      eventTimeToStore,
      releaseTimeToStore,
      `${symbol} earnings`,
      symbol,
      securityId,
      sourceKey,
      mondayOf(input.confirmedDate),
    );

    // Reconcile so the cluster's sync rows are superseded around the locked date.
    // Scoped to the confirmed issuer's family: a whole-book pass here folded
    // OTHER symbols' manual sibling rows whenever they carried a user_confirmed
    // row (QA 2026-09-26 — confirming NKE hid two MU rows with no message).
    reconcileEarningsDates(db, { today: input.today, symbols: [symbol] });
    if (before?.superseded) writeArmedEventsOutboxRow(db, { today: input.today });
  })();

  return { ok: true };
}
