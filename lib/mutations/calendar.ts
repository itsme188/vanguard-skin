import type Database from "better-sqlite3";
import type {
  CalendarEvent,
  CalendarBriefing,
  CalendarEventSource,
} from "@/lib/types";
import { resolveReleaseTime, SYMBOL_RELEASE_TIMES_ET } from "@/lib/calendar/release-times";
import { resolveEarningsReleaseTime, resolveSymbolReleaseTime } from "@/lib/earnings/wire-times";
import { getSecurityIdForSymbolWithSiblings } from "@/lib/queries/briefing-symbols";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import { mondayOf, todayET } from "@/lib/calendar/date-utils";
import { isEventArmed } from "@/lib/queries/earnings-worksheet-flags";
import { writeArmedEventsOutboxRow } from "@/lib/earnings/cloud-outbox";
import {
  reconcileEarningsDates,
  repointDependentsBeforeDelete,
} from "@/lib/calendar/reconcile-earnings-dates";

// ─── Result types ─────────────────────────────────────────────────

export interface UpsertResult {
  total: number;
  inserted: number;
  updated: number;
}

// ─── Event input type ─────────────────────────────────────────────

export interface CalendarEventInput {
  source: CalendarEventSource;
  event_type: string;
  event_date: string;
  event_time?: string | null;
  title: string;
  description?: string | null;
  security_id?: number | null;
  symbol?: string | null;
  ib_con_id?: number | null;
  expected_impact?: string | null;
  consensus_estimate?: string | null;
  previous_value?: string | null;
  raw_json?: string | null;
  source_key: string;
  week_of?: string | null;
}

// ─── Mutation functions ───────────────────────────────────────────

/**
 * Batch upsert calendar events. Uses ON CONFLICT(source_key) to update
 * existing events rather than creating duplicates.
 * Returns counts distinguishing new inserts from updates of existing rows.
 *
 * Enrichment invariant ("sync may only add data, never clear it"):
 * the conflict clause deliberately does NOT touch actual_value /
 * consensus_value / reaction_snapshot / enriched_at — those are owned by
 * the post-release enrichment runner — and release_time uses COALESCE so a
 * fresh input that resolves no release time (e.g. other_macro with a lost
 * event_time) can't clear a value that was backfilled and feeds the
 * enrichment window filter.
 *
 * Earnings earlier-wins (2026-08-05): the T-90m wire probe
 * (lib/calendar/wire-probe.ts) writes an earlier observed release_time
 * DIRECTLY to a row, outside this function. A later re-sync (e.g. "Refresh
 * from Finnhub") recomputes release_time from the wire-time cascade fresh —
 * without the actuals-transition observation that would feed the cascade's
 * own pull-down rule, that recompute lands back on the plain BMO/AMC
 * default, which is strictly LATER than the probe's direct evidence. For
 * earnings rows only (event_type='earnings', the same gate
 * resolveEarningsReleaseTime uses), the conflict clause keeps the existing
 * release_time when it is earlier than the incoming value — the probe only
 * ever pulls times earlier, so an existing-earlier-than-incoming reading is
 * always better information. A NULL existing value still gets filled, and a
 * genuinely earlier incoming value (e.g. a BMO/AMC slot correction) still
 * applies. Macro rows are untouched — plain COALESCE(incoming, existing),
 * byte-identical to before.
 *
 * Date-verification stamp (migration 072): date_verified_at /
 * date_verification_note certify a SPECIFIC event_date + slot. When a source
 * moves an event's date on re-sync, the old stamp is no longer true of the
 * new date, so both columns are NULLed in that case (and preserved
 * otherwise) — the opposite of the "never clear" rule above, because here
 * the value being cleared is itself invalidated by the date change.
 */
export function upsertCalendarEvents(
  db: Database.Database,
  rawEvents: CalendarEventInput[]
): UpsertResult {
  if (rawEvents.length === 0) return { total: 0, inserted: 0, updated: 0 };

  // User suppressions (migration 070): drop sync events whose (symbol, date,
  // type) tuple the user explicitly removed — a wrong Finnhub/Nasdaq earnings
  // date would otherwise re-insert on every sweep. Manual rows never flow
  // through this function, but the source guard keeps it honest anyway.
  const suppressed = getSuppressedEventTuples(db);
  const events =
    suppressed.size === 0
      ? rawEvents
      : rawEvents.filter(
          (e) =>
            e.source === "manual" ||
            !e.symbol ||
            !suppressed.has(suppressionKey(e.symbol, e.event_date, e.event_type)),
        );
  if (events.length < rawEvents.length) {
    console.log(
      `[calendar] Skipped ${rawEvents.length - events.length} sync event(s) matching user suppressions`,
    );
  }
  if (events.length === 0) return { total: 0, inserted: 0, updated: 0 };

  // Check which source_keys already exist so we can distinguish insert vs update
  const sourceKeys = events.map((e) => e.source_key);
  const placeholders = sourceKeys.map(() => "?").join(",");
  const existingRows = db
    .prepare(
      `SELECT source_key FROM calendar_events WHERE source_key IN (${placeholders})`
    )
    .all(...sourceKeys) as { source_key: string }[];
  const existingKeys = new Set(existingRows.map((r) => r.source_key));

  const stmt = db.prepare(
    `INSERT INTO calendar_events
       (source, event_type, event_date, event_time, release_time, title, description,
        security_id, symbol, ib_con_id, expected_impact, consensus_estimate,
        previous_value, raw_json, source_key, week_of)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_key) DO UPDATE SET
       event_type = excluded.event_type,
       event_date = excluded.event_date,
       date_verified_at = CASE WHEN excluded.event_date != calendar_events.event_date
                               THEN NULL ELSE calendar_events.date_verified_at END,
       date_verification_note = CASE WHEN excluded.event_date != calendar_events.event_date
                               THEN NULL ELSE calendar_events.date_verification_note END,
       event_time = excluded.event_time,
       release_time = CASE
                         WHEN excluded.event_type = 'earnings'
                              AND calendar_events.release_time IS NOT NULL
                              AND excluded.release_time IS NOT NULL
                              AND calendar_events.release_time < excluded.release_time
                         THEN calendar_events.release_time
                         ELSE COALESCE(excluded.release_time, calendar_events.release_time)
                       END,
       title = excluded.title,
       description = excluded.description,
       expected_impact = excluded.expected_impact,
       consensus_estimate = excluded.consensus_estimate,
       previous_value = excluded.previous_value,
       raw_json = excluded.raw_json,
       fetched_at = datetime('now')`
  );

  const insertAll = db.transaction(() => {
    let inserted = 0;
    let updated = 0;
    for (const e of events) {
      const releaseTime = resolveEarningsReleaseTime(db, {
        event_type: e.event_type,
        event_time: e.event_time ?? null,
        raw_json: e.raw_json ?? null,
        symbol: e.symbol ?? null,
      });
      stmt.run(
        e.source,
        e.event_type,
        e.event_date,
        e.event_time ?? null,
        releaseTime,
        e.title,
        e.description ?? null,
        e.security_id ?? null,
        e.symbol ?? null,
        e.ib_con_id ?? null,
        e.expected_impact ?? null,
        e.consensus_estimate ?? null,
        e.previous_value ?? null,
        e.raw_json ?? null,
        e.source_key,
        e.week_of ?? null
      );
      if (existingKeys.has(e.source_key)) {
        updated++;
      } else {
        inserted++;
      }
    }
    return { total: inserted + updated, inserted, updated };
  });

  return insertAll();
}

/**
 * Save or update a weekly briefing.
 */
export function saveBriefing(
  db: Database.Database,
  params: {
    weekOf: string;
    title: string;
    content: string;
    eventCount: number;
    model: string;
  }
): CalendarBriefing {
  db.prepare(
    `INSERT INTO calendar_briefings (week_of, title, content, event_count, model)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(week_of) DO UPDATE SET
       title = excluded.title,
       content = excluded.content,
       event_count = excluded.event_count,
       model = excluded.model,
       generated_at = datetime('now')`
  ).run(
    params.weekOf,
    params.title,
    params.content,
    params.eventCount,
    params.model
  );

  return db
    .prepare("SELECT * FROM calendar_briefings WHERE week_of = ?")
    .get(params.weekOf) as CalendarBriefing;
}

// ─── Single-row CRUD for the Earnings Hub manual-add flow ─────────
//
// ─── Sync-event suppressions (migration 070) ──────────────────────

function suppressionKey(symbol: string, eventDate: string, eventType: string): string {
  return `${symbol.trim().toUpperCase()}|${eventDate}|${eventType}`;
}

/**
 * Record a (symbol, event_date, event_type) tuple the sync upsert must skip.
 * Idempotent (UNIQUE + DO NOTHING). Symbol stored uppercase.
 */
export function suppressCalendarEvent(
  db: Database.Database,
  params: { symbol: string; event_date: string; event_type?: string; reason?: string | null },
): void {
  db.prepare(
    `INSERT INTO calendar_event_suppressions (symbol, event_date, event_type, reason)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(symbol, event_date, event_type) DO NOTHING`,
  ).run(
    params.symbol.trim().toUpperCase(),
    params.event_date,
    params.event_type ?? "earnings",
    params.reason ?? null,
  );
}

/**
 * All suppressed tuples as `SYMBOL|date|type` keys. Returns an empty set when
 * the table doesn't exist (minimal hand-built test DBs) — same tolerance
 * pattern as the flow-adjusted risk lookup on a missing transactions table.
 */
function getSuppressedEventTuples(db: Database.Database): Set<string> {
  try {
    const rows = db
      .prepare("SELECT symbol, event_date, event_type FROM calendar_event_suppressions")
      .all() as { symbol: string; event_date: string; event_type: string }[];
    return new Set(rows.map((r) => suppressionKey(r.symbol, r.event_date, r.event_type)));
  } catch (err) {
    if (err instanceof Error && /no such table/i.test(err.message)) return new Set();
    throw err;
  }
}

/**
 * Re-hide any SYNC-OWNED earnings row in this issuer family that the scoped
 * reconcile just promoted onto a SUPPRESSED (symbol, event_date, event_type)
 * tuple.
 *
 * Without this, deleting one of two vendors that AGREE on a wrong date — the
 * likeliest reason a user reaches for the ✕ — writes the suppression for that
 * exact tuple and then, in the same transaction, lets the reconcile promote
 * the other vendor's row sitting on the identical date. The delete looks like
 * it did nothing, and the suppression ("this tuple is wrong") is contradicted
 * by the row it left on screen.
 *
 * `source='manual'` rows are exempt: correctEarningsEventDate's same-date slot
 * fix deliberately mints a manual row on the very tuple it suppresses, and
 * that row IS the user's answer — the suppression only ever spoke about the
 * sync sources.
 */
function resuppressSuppressedTuples(db: Database.Database, symbol: string): number {
  const suppressed = getSuppressedEventTuples(db);
  if (suppressed.size === 0) return 0;

  const family = issuerSiblings(symbol).map((s) => s.trim().toUpperCase());
  if (family.length === 0) return 0;
  const rows = db
    .prepare(
      `SELECT id, symbol, event_date, event_type
         FROM calendar_events
        WHERE event_type = 'earnings'
          AND source != 'manual'
          AND symbol IS NOT NULL
          AND COALESCE(superseded, 0) = 0
          AND UPPER(symbol) IN (${family.map(() => "?").join(", ")})`,
    )
    .all(...family) as {
    id: number;
    symbol: string;
    event_date: string;
    event_type: string;
  }[];

  const hide = db.prepare(
    "UPDATE calendar_events SET superseded = 1, date_status = NULL, date_conflict_with = NULL WHERE id = ?",
  );
  let hidden = 0;
  for (const r of rows) {
    if (!suppressed.has(suppressionKey(r.symbol, r.event_date, r.event_type))) continue;
    hide.run(r.id);
    hidden++;
  }
  return hidden;
}

/**
 * Delete a SYNC-OWNED event and suppress its tuple so the next sweep can't
 * re-insert it — the user correction path for a wrong sync-sourced earnings
 * date (delete the wrong row here, add the right one via insertCalendarEvent).
 *
 * Hands the print back, exactly like deleteCalendarEvent (2026-08-31 review,
 * finding B): the deleted row is usually the CANONICAL of its conflict cluster
 * — that is why it was on screen to be deleted — so removing it silently left
 * the other vendor's twin at `superseded = 1`, and every calendar surface
 * filters `COALESCE(superseded,0) = 0`. The name vanished from the calendar
 * until the next syncCalendarForWeek. Its dependent audit rows (bogeys, sent
 * emails, skips) CASCADEd away with it too. So: repoint the children onto the
 * row that becomes canonical BEFORE the delete, then re-run the reconciler
 * scoped to that issuer family — all inside the delete+suppress transaction,
 * followed by resuppressSuppressedTuples so the reconcile can never answer the
 * delete by promoting a sibling row onto the tuple just suppressed.
 *
 * `opts.handBack: false` opts out, for a caller that owns the cluster
 * resolution itself: correctEarningsEventDate deletes a BATCH of wrong rows
 * after migrating their children onto the corrected row, and a per-row
 * reconcile mid-batch could repoint those children onto a sibling row that the
 * loop is about to delete — reintroducing the very cascade this fixes.
 *
 * Throws on a symbol-less event: suppressions are symbol-keyed, and macro
 * rows are corrected through their own source pipelines, never this path.
 */
export function deleteAndSuppressCalendarEvent(
  db: Database.Database,
  id: number,
  opts: { today?: string; handBack?: boolean } = {},
): { deleted: boolean; suppressed: { symbol: string; event_date: string; event_type: string } | null } {
  const row = db
    .prepare("SELECT symbol, event_date, event_type, source FROM calendar_events WHERE id = ?")
    .get(id) as
    | { symbol: string | null; event_date: string; event_type: string; source: string }
    | undefined;
  if (!row) return { deleted: false, suppressed: null };
  if (!row.symbol) {
    throw new Error(
      "Cannot suppress an event without a symbol — macro events are owned by their source pipeline.",
    );
  }

  const symbol = row.symbol.trim().toUpperCase();
  const handBack = opts.handBack !== false && row.event_type === "earnings";
  const today = opts.today ?? todayET();
  const txn = db.transaction(() => {
    suppressCalendarEvent(db, {
      symbol,
      event_date: row.event_date,
      event_type: row.event_type,
      reason: `user-deleted ${row.source} row #${id}`,
    });
    // [C-7] Armed worksheets mostly sit on SYNC-sourced rows, so THIS is the
    // common way an armed event goes away. Read the arm state before the
    // DELETE cascades the flag row off, and emit the tombstone after — without
    // it the Worker would keep an event armed that no longer exists.
    const wasArmed = isEventArmed(db, id);
    if (handBack) repointDependentsBeforeDelete(db, { eventId: id, today });
    db.prepare("DELETE FROM calendar_events WHERE id = ?").run(id);
    if (handBack) {
      reconcileEarningsDates(db, { today, symbols: [symbol] });
      // …but never onto a tuple the user has declared wrong, including the one
      // suppressed two statements ago.
      resuppressSuppressedTuples(db, symbol);
    }
    // After the hand-back, so the projection reflects whatever row the
    // reconciler just made canonical.
    if (wasArmed) writeArmedEventsOutboxRow(db, { today });
  });
  txn();

  return {
    deleted: true,
    suppressed: { symbol, event_date: row.event_date, event_type: row.event_type },
  };
}

export interface CorrectEarningsDateResult {
  ok: boolean;
  newEventId?: number; // the corrected manual row (created or pre-existing)
  deletedIds?: number[]; // wrong rows removed + suppressed
  bogeysMigrated?: number;
  auditRowsMigrated?: number; // earnings_emails + earnings_email_skips repointed
  refusedReason?: string; // set when ok=false (e.g. captured actuals)
  code?: "no_change"; // discriminates a benign no-op refusal from a hard one
}

/**
 * The BMO/AMC slot a calendar row effectively sits in: the vendor's own
 * event_time marker when it's one, else the release_time clock hour (before
 * noon ET → bmo). Null when neither resolves.
 *
 * Deliberately a local copy of lib/calendar/verify-earnings-dates.ts's
 * exported `effectiveSlot` rather than an import: that module imports
 * correctEarningsEventDate from THIS file, so importing back would create a
 * cycle. Keep the two in sync if the slot rules ever change.
 */
function rowSlot(row: { event_time: string | null; release_time: string | null }): "BMO" | "AMC" | null {
  const et = row.event_time?.trim().toUpperCase();
  if (et === "BMO") return "BMO";
  if (et === "AMC") return "AMC";

  const rt = row.release_time;
  if (rt && /^\d{2}:\d{2}/.test(rt)) {
    const hour = parseInt(rt.slice(0, 2), 10);
    if (!Number.isNaN(hour)) return hour < 12 ? "BMO" : "AMC";
  }
  return null;
}

/**
 * Correct a WRONG sync-sourced earnings date (the NET case: Finnhub + the
 * calendar carried 2026-07-30; the real print was Aug 6).
 *
 * For every earnings row of SYMBOL on WRONG_DATE: delete it and record a
 * (symbol, date, type) suppression (migration 070) so the next sync sweep
 * can't re-insert it — then point the correction at a row on CORRECT_DATE.
 * Extracted from scripts/correct-earnings-date.ts (originally a CLI-only
 * flow) so the automated date verifier can call the same logic.
 *
 * Resolve-before-delete: the corrected row is resolved FIRST so user-curated
 * earnings_bogeys on the wrong rows can be re-pointed at it instead of dying
 * in the delete CASCADE. Resolution order:
 *   1. ADOPT an existing non-manual earnings row already sitting on
 *      correctDate whose slot agrees with the requested one (clearing its
 *      `superseded` flag). Adoption preserves the vendor's consensus, its
 *      finnhub-source_key enrichment road, and sync freshness — and a later
 *      vendor date-move re-opens verification via the migration-072 clause,
 *      which is exactly the designed reopen. Only attempted when correctDate
 *      differs from wrongDate: on a same-date slot fix the correction
 *      suppresses that very (symbol, date) tuple, which would strand the
 *      adopted vendor row (the next sync's delete-then-reinsert would remove
 *      it and the suppression would block the re-insert).
 *   2. Otherwise MINT a manual row (sync-immune), carrying the wrong row's
 *      consensus_estimate + expected_impact so a correction never silently
 *      downgrades the event to "no consensus". A slot DISAGREEMENT on
 *      correctDate falls here on purpose — editing a vendor row's slot in
 *      place gets re-clobbered by the next sync upsert.
 *
 * Refuses (ok:false) when ANY wrong row already has captured actuals — that
 * print really happened on wrongDate, so nothing is deleted. This check runs
 * BEFORE any write.
 *
 * Idempotent: re-running with no wrong-date rows left just ensures the
 * corrected row exists (returns the same newEventId, empty deletedIds).
 *
 * All writes run inside ONE transaction (every step is synchronous), so a
 * throw mid-way can't leave the wrong rows deleted with no corrected row.
 */
export function correctEarningsEventDate(
  db: Database.Database,
  opts: { symbol: string; wrongDate: string; correctDate: string; slot?: "BMO" | "AMC" },
): CorrectEarningsDateResult {
  const symbol = opts.symbol.trim().toUpperCase();
  // Defense-in-depth case normalization: the route already uppercases
  // before calling in, but this lib fn is a public seam (scripts,
  // lib/calendar/verify-earnings-dates.ts, tests) — a lowercase 'amc' must
  // never dodge the no_change guard just because it doesn't string-match
  // the stored uppercase 'AMC'.
  const normalizedSlot: "BMO" | "AMC" | undefined = opts.slot
    ? ((opts.slot as string).toUpperCase() as "BMO" | "AMC")
    : undefined;

  const wrongRows = db
    .prepare(
      `SELECT id, source, source_key, event_time, release_time, actual_value,
              consensus_estimate, expected_impact
         FROM calendar_events
        WHERE UPPER(symbol) = ? AND event_date = ? AND event_type = 'earnings'`,
    )
    .all(symbol, opts.wrongDate) as Array<{
    id: number;
    source: string;
    source_key: string;
    event_time: string | null;
    release_time: string | null;
    actual_value: string | null;
    consensus_estimate: string | null;
    expected_impact: string | null;
  }>;

  for (const row of wrongRows) {
    if (row.actual_value) {
      return {
        ok: false,
        refusedReason:
          `Refusing: row #${row.id} (${row.source_key}) already has captured actuals — ` +
          `that print really happened on ${opts.wrongDate}. Nothing deleted.`,
      };
    }
  }

  // No-op guard: an unchanged date+slot submission (the popover's pre-filled
  // form submitted as-is) must never run the correction — the same-date path
  // would doom the vendor row, write a permanent sync suppression, and clear
  // the verification stamp for zero semantic change. Unchanged = no slot
  // requested, or every row with a KNOWN slot already agrees with it.
  // Slot-less rows deliberately accept a slot-set (that adds information);
  // the popover's client-side disable covers the defaulted-form case there.
  if (opts.correctDate === opts.wrongDate && wrongRows.length > 0) {
    const knownSlots = wrongRows
      .map((r) => rowSlot(r))
      .filter((s): s is "BMO" | "AMC" => s !== null);
    const unchanged =
      normalizedSlot === undefined ||
      (knownSlots.length > 0 && knownSlots.every((s) => s === normalizedSlot));
    if (unchanged) {
      return {
        ok: false,
        code: "no_change",
        refusedReason:
          `Nothing to change — ${symbol} already sits on ${opts.wrongDate}` +
          (normalizedSlot ? ` ${normalizedSlot}` : "") +
          `. Edit the date or slot before fixing.`,
      };
    }
  }

  const runCorrection = db.transaction((): CorrectEarningsDateResult => {
    // ── 1. Resolve the corrected row FIRST (adopt, else mint) ───────────────
    const eventTime = normalizedSlot ?? wrongRows[0]?.event_time ?? "AMC";
    let newEventId: number | null = null;

    if (opts.correctDate !== opts.wrongDate) {
      const requestedSlot = rowSlot({ event_time: eventTime, release_time: null });
      const onCorrectDate = db
        .prepare(
          `SELECT id, event_time, release_time
             FROM calendar_events
            WHERE UPPER(symbol) = ? AND event_date = ? AND event_type = 'earnings'
              AND source != 'manual'
            ORDER BY id ASC`,
        )
        .all(symbol, opts.correctDate) as Array<{
        id: number;
        event_time: string | null;
        release_time: string | null;
      }>;

      const adoptable = onCorrectDate.find((r) => {
        const existing = rowSlot(r);
        // A null on either side is "no claim" — it agrees with anything.
        return requestedSlot === null || existing === null || existing === requestedSlot;
      });

      if (adoptable) {
        db.prepare("UPDATE calendar_events SET superseded = 0 WHERE id = ?").run(adoptable.id);
        newEventId = adoptable.id;
      }
    }

    if (newEventId === null) {
      try {
        const { id } = insertCalendarEvent(db, {
          symbol,
          event_date: opts.correctDate,
          event_type: "earnings",
          event_time: eventTime,
          security_id: getSecurityIdForSymbolWithSiblings(db, symbol),
          week_of: mondayOf(opts.correctDate),
          description: `Date corrected from ${opts.wrongDate} (wrong sync-sourced date)`,
          // Carry the vendor's figures — a correction moves the date, it does
          // not discard what the sync row already knew about the print.
          consensus_estimate: wrongRows[0]?.consensus_estimate ?? null,
          expected_impact: wrongRows[0]?.expected_impact ?? null,
        });
        newEventId = id;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/UNIQUE constraint failed/i.test(msg)) throw err;
        const existing = db
          .prepare(
            `SELECT id FROM calendar_events
              WHERE source = 'manual' AND UPPER(symbol) = ? AND event_date = ? AND event_type = 'earnings'`,
          )
          .get(symbol, opts.correctDate) as { id: number };
        newEventId = existing.id;

        // The WHERE clause above guarantees the adopted row is always
        // source='manual' — i.e. correction-owned, never sync-owned — so
        // editing its slot in place does NOT run afoul of the "never edit
        // a sync-owned row's date/slot in place" rule (that rule guards the
        // resolve-first adopt branch above, which only ever touches
        // `source != 'manual'` rows and deliberately never rewrites their
        // event_time). Without this, a correction that collides with an
        // already-corrected manual row on the same target — e.g. a
        // slot-only fix re-submitted after an earlier correction already
        // minted this row — returned ok:true while the requested slot was
        // silently discarded
        // (qa:today-earningshub-fix-date--slot-only-change-200-writes-nothing).
        // Only fires when a slot was actually requested — a pure date-move
        // with no slot opinion must not clobber whatever slot the adopted
        // row already carries.
        if (normalizedSlot) {
          db.prepare(
            "UPDATE calendar_events SET event_time = ?, release_time = ? WHERE id = ?",
          ).run(normalizedSlot, deriveReleaseTime(db, normalizedSlot, symbol), existing.id);
        }
      }
    }

    // The corrected row can itself be one of the "wrong rows" (a slot fix has
    // wrongDate === correctDate, so every row on that date is selected) —
    // deleting it would suppress the tuple and destroy the very event this
    // call exists to preserve. Everything below operates on the rest.
    const doomedRows = wrongRows.filter((r) => r.id !== newEventId);

    // ── 2. Migrate user-curated bogeys + email audit off the doomed rows ────
    // earnings_emails / earnings_email_skips repoint alongside bogeys (the
    // reconcile-earnings-dates.ts sibling already carries this exact list):
    // a correction moves the event, it does not unsend the preview — losing
    // the audit row destroys the archived email AND re-opens the event as a
    // findEmailCandidates send candidate (duplicate-preview risk). UPDATE OR
    // IGNORE keeps the corrected row's own (event_id, phase) row on a UNIQUE
    // collision; the doomed duplicate then dies in the delete CASCADE.
    let bogeysMigrated = 0;
    let auditRowsMigrated = 0;
    for (const row of doomedRows) {
      bogeysMigrated += db
        .prepare("UPDATE OR IGNORE earnings_bogeys SET event_id = ? WHERE event_id = ?")
        .run(newEventId, row.id).changes;
      for (const table of ["earnings_emails", "earnings_email_skips"]) {
        auditRowsMigrated += db
          .prepare(`UPDATE OR IGNORE ${table} SET event_id = ? WHERE event_id = ?`)
          .run(newEventId, row.id).changes;
      }
    }

    // ── 3. Delete the wrong rows + suppress the tuple ──────────────────────
    // handBack:false — step 2 already migrated every child onto newEventId,
    // and this is a BATCH delete: letting each delete re-run the reconciler
    // mid-loop could repoint those children onto a sibling doomed row that a
    // later iteration then deletes, cascading them away. The cluster settles
    // on the next reconcile pass, with all the wrong rows already gone.
    const deletedIds: number[] = [];
    for (const row of doomedRows) {
      deleteAndSuppressCalendarEvent(db, row.id, { handBack: false });
      deletedIds.push(row.id);
    }

    return { ok: true, newEventId, deletedIds, bogeysMigrated, auditRowsMigrated };
  });

  return runCorrection();
}

// updateCalendarEvent / deleteCalendarEvent intentionally only operate on
// rows where source='manual'. Manual rows are exclusively user-curated;
// Finnhub/WSH/FRED rows are owned by their sync pipelines and a stray
// PATCH/DELETE would corrupt the next sync's idempotency. Routes wrap
// these and return 403 on attempts to touch non-manual rows — EXCEPT the
// DELETE route's sync-owned earnings branch, which goes through
// deleteAndSuppressCalendarEvent above (delete + suppression, so the next
// sync can't resurrect a wrong date).

export interface ManualEarningsInput {
  symbol: string;
  event_date: string;             // YYYY-MM-DD
  event_type?: string;            // default 'earnings'
  event_time?: string | null;     // 'BMO' | 'AMC' | 'TAS' | 'HH:MM'
  release_time?: string | null;   // explicit override; otherwise derived
  expected_impact?: string | null;
  consensus_estimate?: string | null;
  description?: string | null;
  security_id?: number | null;
  week_of: string;                // Monday of the event's week, computed by caller
}

export interface ManualEarningsResult {
  id: number;
}

/**
 * Insert a manually-curated calendar event (typically earnings the user
 * knows is happening but Finnhub didn't have at sync time). Returns the
 * new row's id. Throws on UNIQUE(source_key) collision — caller should
 * retry the upsert path or treat as a no-op if the manual row already
 * exists for that symbol+date+type.
 *
 * Default event_time/release_time mapping (only applied when caller doesn't
 * pass an explicit value):
 *   - event_time omitted     → "AMC" (most common case for missed names)
 *   - release_time omitted   → 08:00 if BMO, 16:15 if AMC, null otherwise
 */
export function insertCalendarEvent(
  db: Database.Database,
  input: ManualEarningsInput,
): ManualEarningsResult {
  const symbol = input.symbol.trim().toUpperCase();
  const eventType = input.event_type ?? "earnings";
  const eventTime = input.event_time ?? "AMC";
  const releaseTime = input.release_time ?? deriveReleaseTime(db, eventTime, symbol);
  const sourceKey = `manual:${symbol}:${input.event_date}:${eventType}`;
  const title = `${symbol} earnings (Manual entry)`;

  const result = db
    .prepare(
      `INSERT INTO calendar_events
       (source, event_type, event_date, event_time, title, description,
        security_id, symbol, expected_impact, consensus_estimate,
        source_key, week_of, release_time)
       VALUES ('manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventType,
      input.event_date,
      eventTime,
      title,
      input.description ?? null,
      input.security_id ?? null,
      symbol,
      input.expected_impact ?? "high",
      input.consensus_estimate ?? null,
      sourceKey,
      input.week_of,
      releaseTime,
    );
  return { id: result.lastInsertRowid as number };
}

export interface UpdateManualEarningsInput {
  id: number;
  event_date?: string;
  event_time?: string | null;
  release_time?: string | null;
  description?: string | null;
  consensus_estimate?: string | null;
  expected_impact?: string | null;
  symbol?: string;
  event_type?: string;
  week_of?: string;
}

/** Returns true if the row was updated, false if not found OR not manual. */
export function updateCalendarEvent(
  db: Database.Database,
  input: UpdateManualEarningsInput,
): boolean {
  const existing = db
    .prepare("SELECT source FROM calendar_events WHERE id = ?")
    .get(input.id) as { source: string } | undefined;
  if (!existing) return false;
  if (existing.source !== "manual") return false; // sync-owned — refuse silently; route returns 403

  const fields: string[] = [];
  const params: (string | number | null)[] = [];

  if (input.event_date !== undefined) { fields.push("event_date = ?"); params.push(input.event_date); }
  if (input.event_time !== undefined) { fields.push("event_time = ?"); params.push(input.event_time); }
  if (input.release_time !== undefined) { fields.push("release_time = ?"); params.push(input.release_time); }
  if (input.description !== undefined) { fields.push("description = ?"); params.push(input.description); }
  if (input.consensus_estimate !== undefined) { fields.push("consensus_estimate = ?"); params.push(input.consensus_estimate); }
  if (input.expected_impact !== undefined) { fields.push("expected_impact = ?"); params.push(input.expected_impact); }
  if (input.symbol !== undefined) {
    fields.push("symbol = ?");
    params.push(input.symbol.trim().toUpperCase());
  }
  if (input.event_type !== undefined) { fields.push("event_type = ?"); params.push(input.event_type); }
  if (input.week_of !== undefined) { fields.push("week_of = ?"); params.push(input.week_of); }
  // Re-derive the source_key only when symbol/date/type changed, so a date
  // edit doesn't break the UNIQUE constraint with the original key.
  if (
    input.symbol !== undefined ||
    input.event_date !== undefined ||
    input.event_type !== undefined
  ) {
    const row = db.prepare("SELECT symbol, event_date, event_type FROM calendar_events WHERE id = ?").get(input.id) as { symbol: string; event_date: string; event_type: string };
    const newSym = (input.symbol ?? row.symbol).toUpperCase();
    const newDate = input.event_date ?? row.event_date;
    const newType = input.event_type ?? row.event_type;
    fields.push("source_key = ?");
    params.push(`manual:${newSym}:${newDate}:${newType}`);
  }

  if (fields.length === 0) return true; // no-op update

  params.push(input.id);
  return db.transaction(() => {
    const result = db
      .prepare(
        `UPDATE calendar_events SET ${fields.join(", ")}
          WHERE id = ? AND source = 'manual'`,
      )
      .run(...params);
    // v2 slice A: an armed event's projection (date, slot, release time,
    // consensus) just changed — the Worker delta must carry the new shape.
    // Unarmed edits write nothing; an edit that changed no VALUE is caught by
    // the writer's own no-op rule (D10).
    if (result.changes > 0 && isEventArmed(db, input.id)) writeArmedEventsOutboxRow(db);
    return result.changes > 0;
  })();
}

/**
 * Returns true if a manual row was deleted, false otherwise.
 *
 * Hand-back on delete (qa:today-earningshub-add-ticker--manual-add-supersedes-
 * vendor-date-delete-never-restores): a manual/user_confirmed earnings row is
 * rung 1 of resolveCluster, so while it exists it supersedes every vendor row
 * in its cluster — by design, the user's date wins. Deleting it used to leave
 * those vendor rows at superseded=1 forever, and since every calendar surface
 * filters `COALESCE(superseded,0) = 0`, the company's real earnings date
 * disappeared with no path back (ORCL: manual Sep 2 added, Finnhub's Sep 7
 * superseded, manual row removed, Sep 7 gone).
 *
 * So after removing an earnings row we re-run the reconciler scoped to that
 * issuer family, which re-resolves the surviving cluster exactly as if the
 * manual row had never been added. Re-using the reconciler rather than
 * hand-rolling an un-supersede is what keeps the restore honest: a twin that
 * is superseded for its OWN reason (a Nasdaq duplicate of a surviving,
 * agreeing Finnhub row) stays superseded, and other symbols are never touched.
 *
 * NOTE the deliberate asymmetry with deleteAndSuppressCalendarEvent: no
 * suppression is written here. Sync never re-emits a `source='manual'` row, so
 * there is nothing to suppress — and a suppression would be scoped to the
 * MANUAL row's date anyway, never the vendor date being restored.
 *
 * `opts.today` is the ET anchor for the reconcile pass (past-with-actuals vs
 * future logic); it defaults to todayET() and exists for tests/callers that
 * already hold an ET date. The restore inherits the reconciler's own gather
 * window, which is the same window the supersession was decided in.
 */
export function deleteCalendarEvent(
  db: Database.Database,
  id: number,
  opts: { today?: string } = {},
): boolean {
  const today = opts.today ?? todayET();

  // The read sits INSIDE the transaction with the writes it authorizes: the
  // hand-back below moves child rows before the DELETE, so a row that turns
  // out not to be deletable must not leave those moves behind.
  const txn = db.transaction((): boolean => {
    const existing = db
      .prepare("SELECT source, event_type, symbol FROM calendar_events WHERE id = ?")
      .get(id) as
      | { source: string; event_type: string; symbol: string | null }
      | undefined;
    if (!existing) return false;
    if (existing.source !== "manual") return false;

    const restoreSymbol =
      existing.event_type === "earnings" && existing.symbol ? existing.symbol : null;

    // [C-7] Read the arm state BEFORE the DELETE cascades the flag row away:
    // the Worker only ever hears "this event is gone" through a tombstone in
    // the armed-events projection, written below once the delete lands.
    const wasArmed = isEventArmed(db, id);

    // BEFORE the DELETE: earnings_bogeys / earnings_emails /
    // earnings_email_skips are ON DELETE CASCADE on event_id (migrations
    // 042/043/045), and the reconcile pass that made THIS row canonical had
    // already moved the whole cluster's children onto it. Deleting first would
    // destroy the user's uploaded bogeys and the sent-email audit trail, and
    // leave the restored vendor row with no preview-phase row — which
    // findEmailCandidates reads as "never emailed", re-opening the print to a
    // duplicate send. Hand them to the row that is about to become canonical
    // instead, under the reconciler's own repoint rules.
    if (restoreSymbol) {
      repointDependentsBeforeDelete(db, { eventId: id, today });
    }

    const deleted =
      db
        .prepare("DELETE FROM calendar_events WHERE id = ? AND source = 'manual'")
        .run(id).changes > 0;
    if (deleted && restoreSymbol) {
      reconcileEarningsDates(db, { today, symbols: [restoreSymbol] });
    }
    // The flag has cascaded away, so the projection no longer carries the
    // event and the writer emits its tombstone (D7).
    if (deleted && wasArmed) writeArmedEventsOutboxRow(db, { today });
    return deleted;
  });
  return txn();
}

function deriveReleaseTime(
  db: Database.Database,
  eventTime: string | null | undefined,
  symbol?: string | null,
): string | null {
  if (!eventTime) return null;
  const t = eventTime.trim().toUpperCase();
  // If the caller passed "HH:MM" through event_time, treat that as the release_time too.
  if (/^\d{1,2}:\d{2}$/.test(eventTime)) return eventTime;
  if (t === "TAS") return null; // "during trading" — no specific release time

  // Wire-time cascade (user override → web-verified → observed-derived)
  // wins over the static per-symbol constant + BMO/AMC defaults below.
  if (symbol) {
    const slot = t === "BMO" ? "bmo" : t === "AMC" ? "amc" : null;
    const fromCascade = resolveSymbolReleaseTime(db, symbol, slot);
    if (fromCascade) return fromCascade.time;
  }

  // Per-symbol overrides win over BMO/AMC defaults (e.g. AAPL=16:30 not 16:15).
  if (symbol) {
    const override = SYMBOL_RELEASE_TIMES_ET[symbol.trim().toUpperCase()];
    if (override) return override;
  }
  if (t === "BMO") return "08:00";
  if (t === "AMC") return "16:15";
  return null;
}

/**
 * Delete UN-enriched events for a given week + source. The sync pipeline's
 * delete-before-reinsert exists for reschedule-orphan cleanup (source_key
 * includes the date, so a rescheduled event leaves a stale row behind) — but
 * an ENRICHED row is the historical record of a release that already
 * happened: deleting it destroys actual_value / consensus_value /
 * reaction_snapshot / enriched_at, and (via ON DELETE CASCADE) the
 * earnings_emails / earnings_email_skips audit rows keyed on its id.
 *
 * Sync may only ADD data, never clear it (same invariant as the enrichment
 * runner's COALESCE guards, 309f2ca). Enriched rows survive: if the new sync
 * set re-produces the same source_key, upsertCalendarEvents refreshes the
 * sync-owned metadata without touching enrichment; if it doesn't (source
 * list drift — the Existing Home Sales disappearance), the row simply stays.
 * Un-enriched orphans are still cleaned exactly as before.
 *
 * Rows referenced by earnings_emails / earnings_email_skips / earnings_bogeys
 * are also user-curated state — even for a PRE-release (unenriched) event, a
 * sent preview audit row, a per-event skip, or a user-uploaded bogey exists.
 * Deleting the parent CASCADEs them away, and the re-inserted row (upserted
 * on the next sync pass) gets a NEW id that orphans any KV/snapshot refs
 * keyed on the old one (B4). Sync may only replace rows nothing else points
 * at.
 *
 * wire_probe_empty_at (migration 076) is the same class of protected state:
 * a stamped empty pre-release probe BOUNDS a future wire-time observation
 * (earnings/wire-times.ts's bounded-vs-unbounded distinction). A mid-window
 * manual "Refresh from Finnhub" that deletes-then-reinserts the row would
 * silently drop the stamp — the symbol's release-time cascade would still
 * degrade honestly to unbounded, but a real observation is lost for good.
 * Treated the same as the four enrichment columns: a stamped row survives.
 */
export function deleteUnenrichedEventsForWeek(
  db: Database.Database,
  weekOf: string,
  source: CalendarEventSource
): number {
  return db
    .prepare(
      `DELETE FROM calendar_events
        WHERE week_of = ? AND source = ?
          AND actual_value IS NULL
          AND consensus_value IS NULL
          AND reaction_snapshot IS NULL
          AND enriched_at IS NULL
          AND wire_probe_empty_at IS NULL
          AND id NOT IN (SELECT event_id FROM earnings_emails)
          AND id NOT IN (SELECT event_id FROM earnings_email_skips)
          AND id NOT IN (SELECT event_id FROM earnings_bogeys)`
    )
    .run(weekOf, source).changes;
}

/**
 * Delete events for a given week, optionally filtered by source.
 * NOTE: unconditional — destroys enrichment. Sync paths must use
 * deleteUnenrichedEventsForWeek instead.
 */
export function deleteEventsForWeek(
  db: Database.Database,
  weekOf: string,
  source?: CalendarEventSource
): number {
  if (source) {
    return db
      .prepare(
        "DELETE FROM calendar_events WHERE week_of = ? AND source = ?"
      )
      .run(weekOf, source).changes;
  }
  return db
    .prepare("DELETE FROM calendar_events WHERE week_of = ?")
    .run(weekOf).changes;
}
