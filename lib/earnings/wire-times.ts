/**
 * Earnings wire-time tracking (spec 2026-08-04): observed print times per
 * (symbol, quarter) + the per-symbol release-time resolution cascade.
 *
 * "Bounded" observation = an empty probe existed <=30 min before the first
 * sighting, so the true wire time lies in a tight interval. Unbounded
 * observations (Mac woke late) prove only "at or before first_seen_at" and
 * are excluded from calibration except the pull-down rule (an early
 * sighting is proof regardless of bounding).
 *
 * All reads tolerate missing tables (minimal test DBs) — precedent:
 * calendar_event_suppressions.
 */
import type Database from "better-sqlite3";
import { issuerSiblings } from "@/lib/securities/issuer-family";
import {
  earningsHourToReleaseTime,
  resolveReleaseTime,
  SYMBOL_RELEASE_TIMES_ET,
} from "@/lib/calendar/release-times";
import { deriveEarningsSlot } from "@/lib/earnings/earnings-slot";
import { todayET } from "@/lib/calendar/date-utils";

export const BOUNDED_MAX_GAP_MS = 30 * 60 * 1000;
export const OBSERVATION_LOOKBACK_DAYS = 400; // ~4 quarters + slack

export interface WireObservationRow {
  id: number;
  symbol: string;
  event_date: string;
  event_id: number | null;
  first_seen_at: string; // ISO UTC
  last_empty_probe_at: string | null; // ISO UTC
  source: string;
}

export interface RecordObservationInput {
  symbol: string;
  eventDate: string;
  eventId: number | null;
  firstSeenAt: string; // ISO UTC
  lastEmptyProbeAt: string | null;
  source?: "finnhub_probe" | "web_verified" | "manual";
}

/** Insert a first sighting. Returns false on duplicate or missing table. */
export function recordWireObservation(
  db: Database.Database,
  input: RecordObservationInput,
): boolean {
  try {
    const res = db
      .prepare(
        `INSERT INTO earnings_wire_observations
           (symbol, event_date, event_id, first_seen_at, last_empty_probe_at, source)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol, event_date, source) DO NOTHING`,
      )
      .run(
        input.symbol.trim().toUpperCase(),
        input.eventDate,
        input.eventId,
        input.firstSeenAt,
        input.lastEmptyProbeAt,
        input.source ?? "finnhub_probe",
      );
    return res.changes > 0;
  } catch {
    return false;
  }
}

export function isBoundedObservation(
  firstSeenAt: string,
  lastEmptyProbeAt: string | null,
): boolean {
  if (!lastEmptyProbeAt) return false;
  const seen = Date.parse(firstSeenAt);
  const empty = Date.parse(lastEmptyProbeAt);
  if (!Number.isFinite(seen) || !Number.isFinite(empty)) return false;
  const gap = seen - empty;
  return gap >= 0 && gap <= BOUNDED_MAX_GAP_MS;
}

/** Stamp the latest came-up-empty probe instant on the event row. */
export function stampEmptyProbe(
  db: Database.Database,
  eventId: number,
  at: Date,
): void {
  try {
    db.prepare(
      `UPDATE calendar_events SET wire_probe_empty_at = ? WHERE id = ?`,
    ).run(at.toISOString(), eventId);
  } catch {
    // column absent in a minimal test DB — observation stays unbounded
  }
}

/** All observations for the symbol's issuer family since sinceDate. */
export function getObservationsForFamily(
  db: Database.Database,
  symbol: string,
  sinceDate: string,
): WireObservationRow[] {
  try {
    const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
    const ph = family.map(() => "?").join(",");
    return db
      .prepare(
        `SELECT id, symbol, event_date, event_id, first_seen_at, last_empty_probe_at, source
         FROM earnings_wire_observations
         WHERE symbol IN (${ph}) AND event_date >= ?
         ORDER BY event_date DESC`,
      )
      .all(...family, sinceDate) as WireObservationRow[];
  } catch {
    return [];
  }
}

// ─── Release-time resolution cascade ──────────────────────────────
//
// Layers, most authoritative first:
//   1. user override (symbol_release_times, source='user')
//   2. web_verified override — honored only while ZERO bounded
//      observations exist for the symbol (a bounded observation is direct
//      evidence and supersedes a stale web-sourced note), and never when it
//      looks like an AMC CALL time rather than a print (isSuspectAmcCallTime)
//   3. observed-derived — earliest bounded first_seen minus a 10-min
//      margin, rounded DOWN to the nearest :05, floored at 04:00 ET
//   4. legacy per-symbol constant / BMO-AMC default (resolveReleaseTime)
//   5. pull-down — ANY observation (bounded or not) earlier than a
//      layer-4 default is direct evidence the default is late; never
//      applied when layers 1-2 already resolved (a standing user/web
//      override is deliberate, not a data gap)
//
// An explicit "HH:MM" event_time on the row always wins over everything
// (layer 0) — it's the caller stating a known fact for THIS print, not a
// general symbol default.

export const RESOLUTION_MARGIN_MIN = 10;
export const EARLIEST_PLAUSIBLE_ET = "04:00";
export const LATEST_PLAUSIBLE_ET = "20:00";

export interface SymbolReleaseTimeRow {
  symbol: string;
  release_time: string;
  source: string; // 'user' | 'web_verified'
  note: string | null;
  verified_for_date: string | null;
  updated_at: string;
}

/** ET wall-clock HH:MM for an ISO UTC instant (DST-aware, 24:00 normalized). */
export function etTimeOfInstant(isoUtc: string): string | null {
  const ms = Date.parse(isoUtc);
  if (!Number.isFinite(ms)) return null;
  const hhmm = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ms));
  return hhmm.replace(/^24/, "00");
}

function minusMarginFloored(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  let total = h * 60 + m - RESOLUTION_MARGIN_MIN;
  total = Math.floor(total / 5) * 5; // round DOWN to :05
  const [fh, fm] = EARLIEST_PLAUSIBLE_ET.split(":").map(Number);
  total = Math.max(total, fh * 60 + fm);
  const hh = String(Math.floor(total / 60)).padStart(2, "0");
  const mm = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}

function sameSideOfNoon(hhmm: string, slot: "bmo" | "amc" | null): boolean {
  if (slot === null) return true;
  const isMorning = hhmm < "12:00";
  return slot === "bmo" ? isMorning : !isMorning;
}

/**
 * Earliest ET time at which an "after-close" release_time stops being a
 * plausible PRINT time and starts looking like the earnings CALL.
 */
export const SUSPECT_AMC_CALL_TIME_ET = "17:00";

/**
 * True when an AMC release_time is almost certainly the earnings CALL, not
 * the wire (owner report, live 2026-08-26/27). Companies that print after
 * the close overwhelmingly cross the wire in the 16:00–16:30 window and hold
 * the call at 17:00; a "17:00" answer from a web lookup is the schedule page
 * quoting the call. Believing it poisons two things at once — the release
 * cascade (every downstream countdown, preview window and probe schedule
 * lands ~an hour late) and, before the 2026-08-28 slot floor, the accept
 * guard, which refused a real 16:12 ET print as "still in the future".
 *
 * Applied ONLY to web_verified rows: a 'user' row at 17:00 is an explicit
 * human decision about a company the user knows, and stands.
 */
export function isSuspectAmcCallTime(
  time: string | null | undefined,
  slot: "bmo" | "amc" | null,
): boolean {
  if (slot !== "amc") return false;
  if (!time || !/^\d{2}:\d{2}$/.test(time)) return false;
  return time >= SUSPECT_AMC_CALL_TIME_ET;
}

export function getSymbolReleaseTimeRow(
  db: Database.Database,
  symbol: string,
): SymbolReleaseTimeRow | null {
  try {
    const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
    const ph = family.map(() => "?").join(",");
    return (
      (db
        .prepare(
          `SELECT symbol, release_time, source, note, verified_for_date, updated_at
           FROM symbol_release_times WHERE symbol IN (${ph})
           ORDER BY CASE source WHEN 'user' THEN 0 ELSE 1 END LIMIT 1`,
        )
        .get(...family) as SymbolReleaseTimeRow | undefined) ?? null
    );
  } catch {
    return null;
  }
}

export function upsertSymbolReleaseTime(
  db: Database.Database,
  input: {
    symbol: string;
    releaseTime: string;
    source: "user" | "web_verified";
    /** undefined = not supplied (keep the stored note); null or "" = clear it. */
    note?: string | null;
    /** undefined = not supplied (keep the stored date); null = clear it. */
    verifiedForDate?: string | null;
  },
): void {
  const symbol = input.symbol.trim().toUpperCase();
  // Source precedence (single-row-per-symbol PK): a web_verified write must
  // never downgrade an existing user override — the row is one slot, so
  // without this guard a later web-sourced note would silently clobber a
  // standing user decision. A user write always wins and always proceeds.
  if (input.source === "web_verified") {
    const existing = db
      .prepare(`SELECT source FROM symbol_release_times WHERE symbol = ?`)
      .get(symbol) as { source: string } | undefined;
    if (existing?.source === "user") return;
  }
  // The row is one slot per symbol, so a save from one event's editor must
  // not silently drop the standing note / verified date (D4, 2026-10-08):
  // keep what is stored unless the caller supplies a value. An explicit
  // null (or an empty note) is a deliberate clear.
  const noteSupplied = input.note !== undefined;
  const dateSupplied = input.verifiedForDate !== undefined;
  const note = noteSupplied ? (input.note?.trim() ? input.note : null) : null;
  db.prepare(
    `INSERT INTO symbol_release_times (symbol, release_time, source, note, verified_for_date, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(symbol) DO UPDATE SET
       release_time = excluded.release_time,
       source = excluded.source,
       note = CASE WHEN ? THEN excluded.note ELSE symbol_release_times.note END,
       verified_for_date = CASE WHEN ? THEN excluded.verified_for_date ELSE symbol_release_times.verified_for_date END,
       updated_at = datetime('now')`,
  ).run(
    symbol,
    input.releaseTime,
    input.source,
    note,
    input.verifiedForDate ?? null,
    noteSupplied ? 1 : 0,
    dateSupplied ? 1 : 0,
  );
}

export function clearUserReleaseTime(db: Database.Database, symbol: string): boolean {
  try {
    return (
      db
        .prepare(`DELETE FROM symbol_release_times WHERE symbol = ? AND source = 'user'`)
        .run(symbol.trim().toUpperCase()).changes > 0
    );
  } catch {
    return false;
  }
}

/** The 409 code a Save answers when it would replace a web-verified time. */
export const WOULD_REPLACE_WEB_VERIFIED = "would_replace_web_verified";

/**
 * Ask-first guard for a user Save (unit 17, 2026-10-08). The store keeps ONE
 * row per ticker, so a user Save over a web-verified row turns it into the
 * user's own row, and a later Clear (which deletes only a user row) then
 * removes it: the web-verified time, its note and its date are gone for good.
 * The route answers 409 with this code until the body acknowledges with
 * `replaceWebVerified: true`. Read-only.
 *
 * Looks at the ticker's OWN row only: the upsert is keyed on the exact
 * symbol, so a sibling share class's row is never overwritten by this save.
 *
 * A web-verified time at or after 17:00 is a suspect call time, never trusted
 * (isSuspectAmcCallTime), so replacing one loses nothing and is not asked.
 * Such a time is after noon, so the only print it could serve is after-close.
 */
export function checkUserSaveWouldReplaceWebVerified(
  db: Database.Database,
  symbol: string,
  releaseTime: string,
):
  | { ok: true }
  | {
      ok: false;
      code: typeof WOULD_REPLACE_WEB_VERIFIED;
      standing: { releaseTime: string; verifiedForDate: string | null; note: string | null };
      /** Plain-English question, ready to render. */
      message: string;
    } {
  const sym = symbol.trim().toUpperCase();
  let row: Pick<SymbolReleaseTimeRow, "release_time" | "source" | "note" | "verified_for_date"> | undefined;
  try {
    row = db
      .prepare(
        `SELECT release_time, source, note, verified_for_date
         FROM symbol_release_times WHERE symbol = ?`,
      )
      .get(sym) as typeof row;
  } catch {
    return { ok: true };
  }
  if (!row || row.source !== "web_verified") return { ok: true };
  if (isSuspectAmcCallTime(row.release_time, "amc")) return { ok: true };

  const verifiedFor = row.verified_for_date ? ` (verified for ${row.verified_for_date})` : "";
  const change =
    releaseTime === row.release_time
      ? `Saving makes ${releaseTime} your own time instead`
      : `Saving ${releaseTime} replaces it with your own time`;
  return {
    ok: false,
    code: WOULD_REPLACE_WEB_VERIFIED,
    standing: {
      releaseTime: row.release_time,
      verifiedForDate: row.verified_for_date ?? null,
      note: row.note?.trim() ? row.note : null,
    },
    message:
      `${sym} has a web-verified release time of ${row.release_time}${verifiedFor}. ` +
      `${change}, and a later Clear will not bring the web-verified time back. Save anyway?`,
  };
}

/** How the resolver treats the ticker's standing row for a print in `slot`. */
export type StandingReleaseTimeUse = "in_effect" | "suspect_call_time" | "not_in_effect";

/**
 * Whether the standing row is the time the resolver actually uses, so the
 * editor never presents an ignored time as the row's time. Null with no row.
 * `in_effect` is read off resolveSymbolReleaseTime itself, never re-derived.
 */
export function standingReleaseTimeUse(
  db: Database.Database,
  symbol: string,
  slot: "bmo" | "amc" | null,
): StandingReleaseTimeUse | null {
  const row = getSymbolReleaseTimeRow(db, symbol);
  if (!row) return null;
  const resolved = resolveSymbolReleaseTime(db, symbol, slot);
  if (resolved && resolved.source === row.source && resolved.time === row.release_time) {
    return "in_effect";
  }
  if (row.source === "web_verified" && isSuspectAmcCallTime(row.release_time, slot ?? "amc")) {
    return "suspect_call_time";
  }
  return "not_in_effect";
}

function lookbackSinceDate(): string {
  // UTC-sliced (not ET-anchored): on a 400-day window this is at most a
  // ~1-day fuzz at either boundary, which can only ever admit one extra
  // stale observation or exclude one marginal one — never material to the
  // cascade's conclusions. Deliberate; don't "fix" this in an ET-anchor sweep.
  const d = new Date(Date.now() - OBSERVATION_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

export function hasBoundedObservations(db: Database.Database, symbol: string): boolean {
  return getObservationsForFamily(db, symbol, lookbackSinceDate()).some((o) =>
    isBoundedObservation(o.first_seen_at, o.last_empty_probe_at),
  );
}

/** Cascade layers 1–3 (user → web_verified → observed-derived). */
export function resolveSymbolReleaseTime(
  db: Database.Database,
  symbol: string,
  slot: "bmo" | "amc" | null,
): { time: string; source: "user" | "web_verified" | "observed" } | null {
  const row = getSymbolReleaseTimeRow(db, symbol);
  const bounded = getObservationsForFamily(db, symbol, lookbackSinceDate()).filter((o) =>
    isBoundedObservation(o.first_seen_at, o.last_empty_probe_at),
  );

  if (row?.source === "user" && sameSideOfNoon(row.release_time, slot)) {
    return { time: row.release_time, source: "user" };
  }
  if (
    row?.source === "web_verified" &&
    bounded.length === 0 &&
    sameSideOfNoon(row.release_time, slot) &&
    !isSuspectAmcCallTime(row.release_time, slot)
  ) {
    return { time: row.release_time, source: "web_verified" };
  }
  const times = bounded
    .map((o) => etTimeOfInstant(o.first_seen_at))
    .filter((t): t is string => t !== null)
    .filter((t) => sameSideOfNoon(t, slot));
  if (times.length > 0) {
    const earliest = times.reduce((a, b) => (a < b ? a : b));
    return { time: minusMarginFloored(earliest), source: "observed" };
  }
  return null;
}

/**
 * Full release-time resolution for one earnings row: explicit HH:MM
 * event_time → layers 1–3 → legacy constant + BMO/AMC defaults
 * (resolveReleaseTime) → pull-down rule (any observation earlier than a
 * layer-≥3 resolution pulls it down; user/web layers are never pulled).

 */
export function resolveEarningsReleaseTime(
  db: Database.Database,
  row: {
    event_type: string;
    event_time: string | null;
    raw_json: string | null;
    symbol?: string | null;
  },
): string | null {
  if (row.event_time && /^\d{2}:\d{2}$/.test(row.event_time)) return row.event_time;
  if (row.event_type !== "earnings" || !row.symbol) return resolveReleaseTime(row);
  // "TAS" ("during trading" — no specific release time) is a distinct
  // category from BMO/AMC, not merely "unknown". Mirrors deriveReleaseTime's
  // conservative choice (lib/mutations/calendar.ts): a TAS row never
  // consults the symbol cascade — a standing user/web override for the
  // symbol's usual BMO/AMC slot says nothing about a TAS print, and
  // slot=null would otherwise bypass the sameSideOfNoon guard entirely.
  if (row.event_time?.trim().toUpperCase() === "TAS") return resolveReleaseTime(row);

  // release_time is deliberately not consulted for the slot here: the row's
  // own release_time is the value this cascade is about to (re)compute.
  const slot = deriveEarningsSlot(row);

  const fromSymbol = resolveSymbolReleaseTime(db, row.symbol, slot);
  if (fromSymbol?.source === "user" || fromSymbol?.source === "web_verified") {
    return fromSymbol.time;
  }

  let resolved = fromSymbol?.time ?? resolveReleaseTime(row);
  if (!resolved) return null;

  // Pull-down: ANY observation (bounded or not) earlier than the resolved
  // time is direct evidence — layers ≥3 only (we're past user/web above).
  const allTimes = getObservationsForFamily(db, row.symbol, lookbackSinceDate())
    .map((o) => etTimeOfInstant(o.first_seen_at))
    .filter((t): t is string => t !== null)
    .filter((t) => sameSideOfNoon(t, slot));
  const earliestSeen = allTimes.length
    ? allTimes.reduce((a, b) => (a < b ? a : b))
    : null;
  if (earliestSeen && earliestSeen < resolved) {
    resolved = minusMarginFloored(earliestSeen);
  }
  return resolved;
}

/**
 * Guard for the release-time POST route (QA finding
 * today-earningshub-release-time--save-stamps-slot-default-summary-contradicts-input,
 * 2026-09-03): a user-entered release time whose side of noon disagrees with
 * the symbol's NEAREST upcoming untouched earnings event's derived BMO/AMC
 * slot would be written by upsertSymbolReleaseTime and then silently
 * IGNORED by resolveSymbolReleaseTime's sameSideOfNoon guard — the write
 * happens, the value is never used, and the resolver falls through to the
 * slot default instead. Call this BEFORE the write so the route can reject
 * the mismatch instead of accepting a value the cascade will never honor.
 *
 * Uses the apply predicate's issuer family / event_date >= today / not
 * superseded, narrowed to the nearest date, but deliberately does NOT
 * exclude rows that already carry actuals or were enriched: those are the
 * rows the user is editing, and the standing override is discarded by the
 * resolver against them just the same (QA finding
 * today-earningshub-release-time--wrong-side-time-saves-200-then-ignored-
 * when-row-has-actuals). Skips the
 * check (ok: true) when there's no upcoming event, the row is TAS, or the
 * row's slot can't be derived — mirroring resolveEarningsReleaseTime's own
 * TAS/null-slot handling, where slot=null means "no side of noon to check".
 */
export function checkUserReleaseTimeAgainstUpcomingSlot(
  db: Database.Database,
  symbol: string,
  releaseTime: string,
  opts: { today?: string } = {},
):
  | { ok: true }
  | {
      ok: false;
      slot: "bmo" | "amc";
      eventDate: string;
      eventId: number;
      /** false = no upcoming event existed; checked against the latest past print. */
      upcoming: boolean;
    } {
  const today = opts.today ?? todayET();
  type Row = {
    id: number;
    event_type: string;
    event_time: string | null;
    raw_json: string | null;
    symbol: string | null;
    event_date: string;
  };
  let rows: Row[];
  let upcoming = true;
  try {
    const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
    const ph = family.map(() => "?").join(",");
    rows = db
      .prepare(
        `SELECT id, event_type, event_time, raw_json, symbol, event_date
         FROM calendar_events
         WHERE event_type = 'earnings' AND UPPER(symbol) IN (${ph})
           AND event_date >= ?
           AND COALESCE(superseded, 0) = 0
         ORDER BY event_date ASC, id ASC`,
      )
      .all(...family, today) as Row[];
    if (rows.length === 0) {
      // No upcoming print: the editor is on a reported row. Check the most
      // recent past date (all its twins) so a wrong-side write is refused
      // instead of stored and ignored.
      upcoming = false;
      rows = db
        .prepare(
          `SELECT id, event_type, event_time, raw_json, symbol, event_date
           FROM calendar_events
           WHERE event_type = 'earnings' AND UPPER(symbol) IN (${ph})
             AND event_date < ?
             AND COALESCE(superseded, 0) = 0
           ORDER BY event_date DESC, id ASC`,
        )
        .all(...family, today) as Row[];
    }
  } catch {
    return { ok: true };
  }
  if (rows.length === 0) return { ok: true };

  // Slice A made unsuperseded same-(symbol, event_date) twins a real shape,
  // and the write this guards applies to EVERY upcoming row — so every row on
  // the NEAREST event_date has to agree, not just whichever twin a bare
  // `LIMIT 1` happened to return (SQLite's tie-break for equal event_date
  // values is arbitrary). Rows further out are never consulted; the nearest
  // date is still the one that matters.
  const nearestDate = rows[0].event_date;
  for (const row of rows) {
    if (row.event_date !== nearestDate) break;
    if (row.event_time?.trim().toUpperCase() === "TAS") continue;
    const slot = deriveEarningsSlot(row);
    if (slot === null) continue;
    if (!sameSideOfNoon(releaseTime, slot)) {
      return { ok: false, slot, eventDate: row.event_date, eventId: row.id, upcoming };
    }
  }
  return { ok: true };
}

/** "16:05" → "4:05 PM". */
function clock12(hhmm: string): string {
  const [hh, mm] = hhmm.split(":");
  const h = parseInt(hh, 10);
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${mm} ${h >= 12 ? "PM" : "AM"}`;
}

export type ManualSlotCheck =
  | {
      ok: true;
      /** The time to store: the symbol's known same-side time, else the slot default. */
      releaseTime: string;
      basis: "known" | "slot_default";
    }
  | {
      ok: false;
      slot: "bmo" | "amc";
      /** The symbol's known time, on the OTHER side of the session. */
      knownTime: string;
      /** What a forced add stores instead of `knownTime`. */
      slotDefaultTime: string;
      /** Plain-English refusal, ready to render. */
      message: string;
    };

/**
 * Guard for the manual "+ Add ticker" road (user ruling 2026-10-05; QA
 * findings: BMO picked, 4:05 PM stored): a manual earnings row may never
 * carry a slot and a release time on opposite sides of the session — the
 * countdown reads the time, the accept gate reads the slot, and the two then
 * disagree by nine hours.
 *
 * The symbol's "known time" is the same evidence the release cascade uses
 * (user override → web_verified → observed wire time → the curated
 * per-symbol constant), and the side of the session is the SAME
 * sameSideOfNoon rule the cascade and the release-time route guard
 * (checkUserReleaseTimeAgainstUpcomingSlot) apply — never a second copy.
 *
 *   - a known time on the chosen slot's side      → ok, keep it
 *   - a known time only on the other side         → REFUSED (the route 409s
 *     `slot_contradicts_known_time`; `force` stores `slotDefaultTime`)
 *   - no known time at all                        → ok, slot default
 */
export function checkManualSlotAgainstKnownTime(
  db: Database.Database,
  symbol: string,
  slot: "bmo" | "amc",
): ManualSlotCheck {
  const sym = symbol.trim().toUpperCase();
  const constant = SYMBOL_RELEASE_TIMES_ET[sym] ?? null;
  const slotDefaultTime = earningsHourToReleaseTime(slot);

  const sameSide =
    resolveSymbolReleaseTime(db, sym, slot)?.time ??
    (constant && sameSideOfNoon(constant, slot) ? constant : null);
  if (sameSide) return { ok: true, releaseTime: sameSide, basis: "known" };

  // Nothing on the chosen side. Ask again with no slot filter: anything that
  // comes back now is, by construction, evidence for the OTHER side — unless
  // it is a same-side time the cascade merely distrusts (a suspect 17:00 AMC
  // call time), which is no contradiction and falls to the slot default.
  const known = resolveSymbolReleaseTime(db, sym, null)?.time ?? constant;
  if (!known || sameSideOfNoon(known, slot)) {
    return { ok: true, releaseTime: slotDefaultTime, basis: "slot_default" };
  }

  const picked = slot === "bmo" ? "BMO (before the open)" : "AMC (after the close)";
  const knownSide = slot === "bmo" ? "after the close" : "before the open";
  return {
    ok: false,
    slot,
    knownTime: known,
    slotDefaultTime,
    message:
      `${sym} is on record reporting at ${clock12(known)} ET, ${knownSide} — but you picked ${picked}. ` +
      `Nothing was added. Change the slot, or add anyway to save it as ${slot.toUpperCase()} ` +
      `at the default ${clock12(slotDefaultTime)} ET.`,
  };
}

/** Re-resolve release_time for future, untouched family earnings rows. */
export function applyResolvedReleaseTimeToUpcomingEvents(
  db: Database.Database,
  symbol: string,
  opts: { today?: string } = {},
): number {
  const today = opts.today ?? todayET();
  let rows: Array<{
    id: number; event_type: string; event_time: string | null;
    raw_json: string | null; symbol: string | null; release_time: string | null;
  }>;
  try {
    const family = issuerSiblings(symbol).map((s) => s.toUpperCase());
    const ph = family.map(() => "?").join(",");
    rows = db
      .prepare(
        `SELECT id, event_type, event_time, raw_json, symbol, release_time
         FROM calendar_events
         WHERE event_type = 'earnings' AND UPPER(symbol) IN (${ph})
           AND event_date >= ? AND actual_value IS NULL AND enriched_at IS NULL
           AND COALESCE(superseded, 0) = 0`,
      )
      .all(...family, today) as typeof rows;
  } catch {
    return 0;
  }
  let updated = 0;
  const upd = db.prepare(`UPDATE calendar_events SET release_time = ? WHERE id = ?`);
  for (const r of rows) {
    const resolved = resolveEarningsReleaseTime(db, r);
    if (resolved && resolved !== r.release_time) {
      upd.run(resolved, r.id);
      updated++;
    }
  }
  return updated;
}
