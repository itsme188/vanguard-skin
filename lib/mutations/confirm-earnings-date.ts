import type Database from "better-sqlite3";
import { getSecurityIdForSymbolWithSiblings } from "@/lib/queries/briefing-symbols";
import { reconcileEarningsDates } from "@/lib/calendar/reconcile-earnings-dates";
import { mondayOf } from "@/lib/calendar/date-utils";
import { resolveEarningsReleaseTime } from "@/lib/earnings/wire-times";

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

/**
 * Record a user-confirmed earnings date as the authoritative, locked value.
 *
 * Writes (or updates in place) a `source='manual'` row at the confirmed date
 * with `date_status='user_confirmed'`, then re-runs the reconciler — which
 * treats a manual/user_confirmed row in a cluster as the locked canonical and
 * supersedes the Finnhub/Nasdaq rows. Future syncs never revert it (the
 * reconciler always defers to the manual row). Idempotent on the source_key.
 */
export function confirmEarningsDate(
  db: Database.Database,
  input: ConfirmEarningsDateInput,
): { ok: true } {
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
    input.confirmedTime ?? null,
    releaseTime,
    `${symbol} earnings`,
    symbol,
    securityId,
    sourceKey,
    mondayOf(input.confirmedDate),
  );

  // Reconcile so the cluster's sync rows are superseded around the locked date.
  reconcileEarningsDates(db, { today: input.today });

  return { ok: true };
}
