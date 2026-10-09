import type Database from "better-sqlite3";
import { getSecurityIdForSymbolWithSiblings } from "@/lib/queries/briefing-symbols";
import {
  createTwinFolder,
  reconcileEarningsDates,
  type TwinDonor,
} from "@/lib/calendar/reconcile-earnings-dates";
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

const CLOCK_RE = /^(\d{1,2}):\d{2}$/;
/** The stored time a slot gets when nothing better is known; never "typed". */
const SLOT_DEFAULT_TIME = { BMO: "08:00", AMC: "16:15" } as const;

/** The slot a stored clock time falls in: before noon is BMO, otherwise AMC. */
function slotOfClock(time: string | null | undefined): "BMO" | "AMC" | null {
  const m = time ? CLOCK_RE.exec(time) : null;
  if (!m) return null;
  return Number(m[1]) < 12 ? "BMO" : "AMC";
}

/**
 * The clock time a user typed on an existing row, or null. Two stored shapes:
 * a clock in `event_time` (sent through the API), or a slot word in
 * `event_time` with a clock in `release_time` that is not that slot's default
 * (the Hub's add form sends the slot; the time editor writes the clock).
 */
function typedTimeOf(
  row: { event_time: string | null; release_time: string | null } | undefined,
): { eventTime: string | null; releaseTime: string } | null {
  if (!row) return null;
  if (row.event_time && CLOCK_RE.test(row.event_time)) {
    return { eventTime: row.event_time, releaseTime: row.release_time ?? row.event_time };
  }
  const slot = slotOfClock(row.release_time);
  if (!slot || !row.release_time || row.release_time === SLOT_DEFAULT_TIME[slot]) return null;
  return { eventTime: row.event_time ? row.event_time.trim().toUpperCase() : null, releaseTime: row.release_time };
}

/**
 * How far either side of the confirmed date another hand-entered row still
 * counts as "the same upcoming print". Prints are a quarter apart, so 45 days
 * is half the gap: a row inside it cannot be the next quarter's.
 */
export const SAME_PRINT_WINDOW_DAYS = 45;

/** Said when a symbol has several hand-entered dates and none can be picked. */
export const SEVERAL_MANUAL_DATES_NOTICE =
  "The date is confirmed, but this symbol has several hand-entered dates; remove the ones you do not want.";

/**
 * Said when the other hand-entered row could not be removed after a confirm
 * (the "kept hidden" fallback). The row is hidden now, but the next reconcile
 * pass shows every hand-entered row dated today or later again, and as the
 * EARLIER hand-entered date it then carries the email (owner ruling
 * 2026-10-07) — so the user has to hear about it. `reason` is plain words; no
 * table name ever reaches the user (that detail is in `note`).
 */
export function keptEntryNotice(
  symbol: string,
  oldDate: string,
  reason: "preview_sent" | "records_attached" | "delete_refused",
): string {
  const why =
    reason === "preview_sent"
      ? "a preview email was already sent for it"
      : reason === "records_attached"
        ? "other records are still attached to it"
        : "it could not be removed automatically";
  return `${symbol} still has an entry on ${oldDate} because ${why}. Remove that entry if you no longer want it.`;
}

interface SamePrintManualRow extends TwinDonor {
  event_date: string;
  event_time: string | null;
  release_time: string | null;
}

/**
 * The symbol's OTHER showing hand-entered earnings rows for the same upcoming
 * print as `confirmedDate` (owner ruling 2026-10-08): `source = 'manual'`,
 * this exact symbol (not the issuer family), not hidden, on another date,
 * dated today or later and within SAME_PRINT_WINDOW_DAYS of the confirmed
 * date. A row that already reported (`actual_value`) or is dated before today
 * is a past print and is never returned.
 */
function samePrintManualRows(
  db: Database.Database,
  opts: { symbol: string; confirmedDate: string; today: string },
): SamePrintManualRow[] {
  return db
    .prepare(
      `SELECT id, event_date, event_time, release_time, consensus_estimate, consensus_value,
              actual_value, manual_actuals_at, reaction_snapshot, enriched_at
         FROM calendar_events
        WHERE source = 'manual' AND event_type = 'earnings'
          AND UPPER(symbol) = ?
          AND COALESCE(superseded, 0) = 0
          AND actual_value IS NULL
          AND event_date <> ?
          AND event_date >= ?
          AND event_date BETWEEN ? AND ?
        ORDER BY event_date, id`,
    )
    .all(
      opts.symbol,
      opts.confirmedDate,
      opts.today,
      addDays(opts.confirmedDate, -SAME_PRINT_WINDOW_DAYS),
      addDays(opts.confirmedDate, SAME_PRINT_WINDOW_DAYS),
    ) as SamePrintManualRow[];
}

/**
 * Every table that still holds a row pointing at this calendar event, as
 * `table (count)`. Read before deleting a folded row: each foreign key onto
 * `calendar_events(id)` is ON DELETE CASCADE, so a delete never fails; it
 * would silently take whatever the fold left behind (a preview sent for the
 * old date, call notes) with it. The list is read from the schema, so a table
 * added later is covered without touching this file: every declared foreign
 * key onto `calendar_events`, plus any column named `event_id` (two tables
 * point at an event with no declared key).
 */
function remainingEventDependents(db: Database.Database, eventId: number): string[] {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  const found: string[] = [];
  for (const { name } of tables) {
    if (name === "calendar_events") continue;
    const quoted = `"${name.replace(/"/g, '""')}"`;
    const columns = new Set<string>();
    for (const fk of db.prepare(`PRAGMA foreign_key_list(${quoted})`).all() as Array<{
      table: string;
      from: string;
    }>) {
      if (fk.table === "calendar_events") columns.add(fk.from);
    }
    for (const col of db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{ name: string }>) {
      if (col.name === "event_id") columns.add(col.name);
    }
    let n = 0;
    for (const column of columns) {
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM ${quoted} WHERE "${column.replace(/"/g, '""')}" = ?`)
        .get(eventId) as { n: number };
      n += row.n;
    }
    if (n > 0) found.push(`${name} (${n})`);
  }
  return found;
}

/**
 * Record a user-confirmed earnings date as the authoritative, locked value.
 *
 * Writes (or updates in place) a `source='manual'` row at the confirmed date
 * with `date_status='user_confirmed'`, then re-runs the reconciler — which
 * treats a manual/user_confirmed row in a cluster as the locked canonical and
 * supersedes the Finnhub/Nasdaq rows. Future syncs never revert it (the
 * reconciler always defers to the manual row). Idempotent on the source_key.
 *
 * ONE hand-entered row per upcoming print (owner ruling 2026-10-08). When the
 * symbol already has a showing hand-entered row for the same print on ANOTHER
 * date (`samePrintManualRows`):
 *  - exactly one, and no hand-entered row on the confirmed date yet: that row
 *    MOVES to the confirmed date and keeps its id, so its bogeys, emails,
 *    skips, arm and notes stay attached (`movedEventId`). A clock time typed
 *    on it follows the same rule as a same-date confirm;
 *  - exactly one, and a hand-entered row already sits on the confirmed date:
 *    the confirmed row is updated in place, the other row's bogeys, emails,
 *    skips and arm are carried onto it through the reconciler's own fold
 *    (`createTwinFolder`), and the emptied row is DELETED (`deletedEventId`,
 *    owner decision 2026-10-08). Hiding it would not last: the next reconcile
 *    pass shows every hand-entered row dated today or later
 *    (`keptManualTwins`). If anything is still attached to the old row after
 *    the fold it is NOT deleted: it stays hidden (`foldedEventId`) and `note`
 *    names what remained, and `notice` tells the user the entry is still there
 *    and why (plain words, shown by the conflict marker);
 *  - two or more: nothing is moved or hidden, and `notice` says so.
 * Sync-owned rows are never moved; the reconcile below hides them as before.
 */
export type ConfirmEarningsDateResult =
  | {
      ok: true;
      /** The existing hand-entered row that was moved onto the confirmed date. */
      movedEventId?: number;
      /** The other hand-entered row, folded into the confirmed one and deleted. */
      deletedEventId?: number;
      /**
       * The other hand-entered row, folded and left HIDDEN because something
       * was still attached to it (see `note`). A later reconcile pass shows a
       * hidden hand-entered row again when it is dated today or later.
       */
      foldedEventId?: number;
      /** Why a folded row was kept and not deleted. For logs and reviewers. */
      note?: string;
      /** Plain words for the user when the confirm could not tidy up fully. */
      notice?: string;
    }
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

  const outcome: {
    movedEventId?: number;
    deletedEventId?: number;
    foldedEventId?: number;
    note?: string;
    notice?: string;
  } = {};

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

    const others = samePrintManualRows(db, {
      symbol,
      confirmedDate: input.confirmedDate,
      today: input.today,
    });
    if (others.length > 1) outcome.notice = SEVERAL_MANUAL_DATES_NOTICE;
    // The one other row moves only onto a free date: with a hand-entered row
    // already on the confirmed date (showing or hidden) the UNIQUE source_key
    // is taken, so that row is confirmed in place and the other one is folded
    // behind it after the reconcile.
    const mover = others.length === 1 && !before ? others[0] : null;
    const toFold = others.length === 1 && before ? others[0] : null;

    // A clock time the user typed on the row being confirmed survives a
    // confirm that picks the same slot, or that names no time at all. Picking
    // the other slot is a deliberate change of time. A moved row brings its
    // typed time with it under the same rule.
    const typed = typedTimeOf(mover ?? before);
    const pickedSlot = cascadeEventTime === "BMO" || cascadeEventTime === "AMC" ? cascadeEventTime : null;
    const keepTyped =
      typed !== null &&
      (input.confirmedTime == null || (pickedSlot !== null && slotOfClock(typed.releaseTime) === pickedSlot));
    const eventTimeToStore = keepTyped
      ? typed.eventTime
      : input.confirmedTime == null
        ? null
        : cascadeEventTime;
    const releaseTimeToStore = keepTyped ? typed.releaseTime : releaseTime;

    if (mover) {
      // Same id, new date: every row that hangs off this event stays attached.
      // That includes a preview email or skip recorded for the OLD date. On a
      // move to a later date such a row means no second preview goes out for
      // the new date (the candidate finder reads any preview row as handled).
      // Left attached on purpose: detaching it would change what is sent, and
      // that needs an owner ruling.
      db.prepare(
        `UPDATE calendar_events
            SET event_date = ?,
                week_of = ?,
                source_key = ?,
                event_time = ?,
                release_time = ?,
                security_id = COALESCE(?, security_id),
                date_status = 'user_confirmed',
                superseded = 0
          WHERE id = ? AND source = 'manual'`,
      ).run(
        input.confirmedDate,
        mondayOf(input.confirmedDate),
        sourceKey,
        eventTimeToStore,
        releaseTimeToStore,
        securityId,
        mover.id,
      );
      outcome.movedEventId = mover.id;
    } else {
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
    }

    // Reconcile so the cluster's sync rows are superseded around the locked date.
    // Scoped to the confirmed issuer's family: a whole-book pass here folded
    // OTHER symbols' manual sibling rows whenever they carried a user_confirmed
    // row (QA 2026-09-26 — confirming NKE hid two MU rows with no message).
    reconcileEarningsDates(db, { today: input.today, symbols: [symbol] });

    let removedEvents: Array<{ id: number; eventDate: string }> | undefined;
    if (toFold) {
      // AFTER the reconcile, never before it: the pass keeps two hand-entered
      // rows side by side and brings a hidden one dated today or later back
      // (`keptManualTwins`), so a fold done first would be undone at once.
      const kept = db
        .prepare(`SELECT id FROM calendar_events WHERE source_key = ?`)
        .get(sourceKey) as { id: number } | undefined;
      if (kept && kept.id !== toFold.id) {
        createTwinFolder(db)(toFold, kept.id, input.confirmedDate);
        const remaining = remainingEventDependents(db, toFold.id);
        if (remaining.length > 0) {
          outcome.foldedEventId = toFold.id;
          outcome.note = `The row on ${toFold.event_date} was hidden, not deleted: records are still attached to it in ${remaining.join(", ")}.`;
          // `remaining` entries read "table (count)". In practice the one
          // thing the fold leaves behind is a preview email (or skip) for the
          // old date; say "email sent" only when an email row is really there.
          outcome.notice = keptEntryNotice(
            symbol,
            toFold.event_date,
            remaining.some((entry) => entry.startsWith("earnings_emails ("))
              ? "preview_sent"
              : "records_attached",
          );
        } else {
          try {
            // Its own savepoint, so a refused delete leaves the fold standing.
            db.transaction(() => {
              db.prepare(`DELETE FROM calendar_events WHERE id = ? AND source = 'manual'`).run(toFold.id);
            })();
            outcome.deletedEventId = toFold.id;
            removedEvents = [{ id: toFold.id, eventDate: toFold.event_date }];
          } catch (err) {
            outcome.foldedEventId = toFold.id;
            outcome.note = `The row on ${toFold.event_date} was hidden, not deleted: the delete was refused (${err instanceof Error ? err.message : String(err)}).`;
            outcome.notice = keptEntryNotice(symbol, toFold.event_date, "delete_refused");
          }
        }
      }
    }

    // A moved or folded row changes the armed projection when it was armed
    // (event date, source key, or which row carries the arm); an un-hidden
    // row leaves the replaced list; a deleted id is published as removed so
    // the Worker stops acting on it. The writer is a no-op when nothing changed.
    if (before?.superseded || mover || toFold) {
      writeArmedEventsOutboxRow(db, { today: input.today, removedEvents });
    }
  })();

  return { ok: true, ...outcome };
}
